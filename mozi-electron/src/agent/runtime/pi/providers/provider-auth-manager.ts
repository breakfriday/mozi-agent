import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthState } from "../../../../../../shared/agent";
import { failure } from "../../../errors";

import type { OAuthInteractionPolicy } from "./provider-plugin";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type Login = {
  state: ProviderAuthState;
  abort: AbortController;
  task?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  pending?: {
    id: string;
    resolve(value: string): void;
    reject(error: Error): void;
  };
};
const running = (phase: ProviderAuthState["phase"]) =>
  ["starting", "waiting", "completing"].includes(phase);

/** Browser waiting never occupies an IPC request or the credential repository lock. */
class ProviderLoginSession {
  private login?: Login;
  private disposed = false;
  private revision = 0;
  private logoutTask?: Promise<void>;
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly emit: (state: ProviderAuthState) => void,
    private readonly committed: (
      credential: Awaited<ReturnType<ModelRuntime["login"]>>,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly removeCredential: () => Promise<void>,
    private readonly timeoutMs: number,
    private readonly providerId: string,
    private readonly policy: OAuthInteractionPolicy,
  ) {}
  private check(providerId: string): void {
    if (providerId !== this.providerId)
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "此 provider 尚未接入 OAuth 登录。",
      );
    if (this.disposed) throw failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。");
  }
  status(providerId: string): ProviderAuthState {
    this.check(providerId);
    return structuredClone(
      this.login?.state ?? {
        providerId,
        loginId: "",
        phase: "idle",
        revision: this.revision,
      },
    );
  }
  private publish(login: Login, patch: Partial<ProviderAuthState>): void {
    if (this.disposed || this.login !== login) return;
    login.state = { ...login.state, ...patch, revision: ++this.revision };
    this.emit(structuredClone(login.state));
  }
  start(providerId: string): ProviderAuthState {
    this.check(providerId);
    if (this.logoutTask)
      throw failure("INVALID_ARGUMENT", "正在退出登录，请稍后重试。");
    if (this.login && running(this.login.state.phase))
      return this.status(providerId);
    const previous = this.login?.task;
    const login: Login = {
      state: {
        providerId,
        loginId: randomUUID(),
        phase: "starting",
        revision: ++this.revision,
      },
      abort: new AbortController(),
    };
    this.login = login;
    this.publish(login, {});
    login.timer = setTimeout(() => this.stop(login, "expired"), this.timeoutMs);
    login.task = this.run(login, previous);
    return this.status(providerId);
  }
  private async run(login: Login, previous?: Promise<void>): Promise<void> {
    const signal = login.abort.signal;
    try {
      await previous; // Let the preceding callback listener release its port.
      signal.throwIfAborted();
      const runtime = await this.runtime();
      signal.throwIfAborted();
      const interaction: Interaction = {
        signal,
        notify: (event) => {
          if (signal.aborted) return;
          if (event.type === "auth_url")
            this.publish(login, {
              phase: "waiting",
              authUrl: event.url,
              openRequest: 1,
            });
          // Do not forward arbitrary provider messages: they may contain URLs or tokens.
        },
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            if (signal.aborted || prompt.signal?.aborted) {
              reject(new Error("Login cancelled"));
              return;
            }
            if (prompt.type === "select") {
              reject(new Error("Unsupported OAuth prompt"));
              return;
            }
            login.pending?.reject(new Error("Prompt replaced"));
            const id = randomUUID();
            const cleanup = () => {
              signal.removeEventListener("abort", abort);
              prompt.signal?.removeEventListener("abort", abort);
              if (login.pending?.id === id) login.pending = undefined;
            };
            const abort = () => {
              cleanup();
              reject(new Error("Login cancelled"));
            };
            login.pending = {
              id,
              resolve: (value) => {
                cleanup();
                resolve(value);
              },
              reject: (error) => {
                cleanup();
                reject(error);
              },
            };
            signal.addEventListener("abort", abort, { once: true });
            prompt.signal?.addEventListener("abort", abort, { once: true });
            this.publish(login, {
              phase: "waiting",
              prompt: { id, ...this.policy.prompt },
            });
          }),
      };
      const credential = await runtime.login(
        login.state.providerId,
        "oauth",
        interaction,
      );
      signal.throwIfAborted();
      // The login runtime stages credentials; the application commits only after cancellation checks.
      clearTimeout(login.timer);
      login.pending?.reject(new Error("Login completed"));
      this.publish(login, {
        phase: "completing",
        prompt: undefined,
        authUrl: undefined,
      });
      await this.committed(credential, signal);
      this.publish(login, {
        phase: "succeeded",
        message: this.policy.successMessage,
      });
    } catch (error) {
      if (!signal.aborted) {
        this.publish(login, {
          phase: "failed",
          prompt: undefined,
          authUrl: undefined,
          message: this.policy.failureMessage(error),
        });
      }
    } finally {
      clearTimeout(login.timer);
      login.pending?.reject(new Error("Login finished"));
    }
  }
  submit(input: {
    providerId: string;
    loginId: string;
    promptId: string;
    callbackUrl: string;
  }): ProviderAuthState {
    const login = this.match(input.providerId, input.loginId);
    if (!running(login.state.phase) || login.pending?.id !== input.promptId)
      throw failure("INVALID_ARGUMENT", "输入请求已结束，请刷新登录状态。");
    login.pending.resolve(this.policy.normalizeInput(input.callbackUrl));
    this.publish(login, { phase: "completing", prompt: undefined });
    return this.status(input.providerId);
  }
  private match(providerId: string, loginId: string): Login {
    this.check(providerId);
    if (!this.login || this.login.state.loginId !== loginId)
      throw failure("INVALID_ARGUMENT", "登录会话已失效。");
    return this.login;
  }
  private stop(login: Login, phase: "cancelled" | "expired"): void {
    if (!running(login.state.phase)) return;
    login.abort.abort();
    clearTimeout(login.timer);
    this.publish(login, {
      phase,
      prompt: undefined,
      authUrl: undefined,
      message: phase === "expired" ? "登录已超时，请重试。" : "登录已取消。",
    });
  }
  cancel(providerId: string, loginId: string): ProviderAuthState {
    this.stop(this.match(providerId, loginId), "cancelled");
    return this.status(providerId);
  }
  open(providerId: string, loginId: string): ProviderAuthState {
    const login = this.match(providerId, loginId);
    if (!running(login.state.phase) || !login.state.authUrl)
      throw failure("INVALID_ARGUMENT", "授权链接已失效。");
    this.publish(login, { openRequest: (login.state.openRequest ?? 0) + 1 });
    return this.status(providerId);
  }
  logout(providerId: string): Promise<void> {
    this.check(providerId);
    if (this.logoutTask) return this.logoutTask;
    if (this.login) this.stop(this.login, "cancelled");
    const task = (async () => {
      await this.login?.task;
      await this.removeCredential();
      if (this.login)
        this.publish(this.login, {
          phase: "idle",
          authUrl: undefined,
          prompt: undefined,
          message: "已退出登录。",
        });
    })();
    this.logoutTask = task;
    void task
      .finally(() => {
        if (this.logoutTask === task) this.logoutTask = undefined;
      })
      .catch(() => {});
    return task;
  }
  dispose(): void {
    if (this.login) {
      this.login.abort.abort();
      clearTimeout(this.login.timer);
    }
    this.disposed = true;
  }
}

export interface ProviderAuthOptions {
  policy(providerId: string): OAuthInteractionPolicy | undefined;
  runtime(): Promise<ModelRuntime>;
  emit(state: ProviderAuthState): void;
  committed(
    providerId: string,
    credential: Awaited<ReturnType<ModelRuntime["login"]>>,
    signal: AbortSignal,
  ): Promise<void>;
  removeCredential(providerId: string): Promise<void>;
  timeoutMs?: number;
}
/** Generic session dispatcher: each registered OAuth provider owns independent login state. */
export class ProviderAuthManager {
  private readonly sessions = new Map<string, ProviderLoginSession>();
  private disposed = false;
  constructor(private readonly options: ProviderAuthOptions) {}
  private session(id: string): ProviderLoginSession {
    if (this.disposed) throw failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。");
    const policy = this.options.policy(id);
    if (!policy)
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "此 provider 尚未接入 OAuth 登录。",
      );
    let session = this.sessions.get(id);
    if (!session) {
      session = new ProviderLoginSession(
        this.options.runtime,
        this.options.emit,
        (credential, signal) => this.options.committed(id, credential, signal),
        () => this.options.removeCredential(id),
        this.options.timeoutMs ?? 5 * 60_000,
        id,
        policy,
      );
      this.sessions.set(id, session);
    }
    return session;
  }
  start(id: string) {
    return this.session(id).start(id);
  }
  status(id: string) {
    return this.session(id).status(id);
  }
  submit(input: {
    providerId: string;
    loginId: string;
    promptId: string;
    callbackUrl: string;
  }) {
    return this.session(input.providerId).submit(input);
  }
  cancel(id: string, loginId: string) {
    return this.session(id).cancel(id, loginId);
  }
  open(id: string, loginId: string) {
    return this.session(id).open(id, loginId);
  }
  logout(id: string) {
    return this.session(id).logout(id);
  }
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) session.dispose();
  }
}
