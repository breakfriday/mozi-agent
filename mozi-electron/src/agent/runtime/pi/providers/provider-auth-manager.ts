import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthState } from "../../../../../../shared/agent";
import { failure } from "../../../errors";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type Login = { state: ProviderAuthState; abort: AbortController; task?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  pending?: { id: string; resolve(value: string): void; reject(error: Error): void } };
const running = (phase: ProviderAuthState["phase"]) => ["starting", "waiting", "completing"].includes(phase);

/** Browser waiting never occupies an IPC request or the credential repository lock. */
export class ProviderAuthManager {
  private login?: Login;
  private disposed = false;
  private revision = 0;
  private logoutTask?: Promise<void>;
  constructor(private readonly runtime: () => Promise<ModelRuntime>, private readonly emit: (state: ProviderAuthState) => void,
    private readonly committed: (credential: Awaited<ReturnType<ModelRuntime["login"]>>, signal: AbortSignal) => Promise<void>, private readonly removeCredential: () => Promise<void>,
    private readonly timeoutMs = 5 * 60_000) {}
  private check(providerId: string): void {
    if (providerId !== "antigravity") throw failure("UNSUPPORTED_CAPABILITY", "此 provider 尚未接入 OAuth 登录。");
    if (this.disposed) throw failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。");
  }
  status(providerId: string): ProviderAuthState {
    this.check(providerId);
    return structuredClone(this.login?.state ?? { providerId, loginId: "", phase: "idle", revision: this.revision });
  }
  private publish(login: Login, patch: Partial<ProviderAuthState>): void {
    if (this.disposed || this.login !== login) return;
    login.state = { ...login.state, ...patch, revision: ++this.revision };
    this.emit(structuredClone(login.state));
  }
  start(providerId: string): ProviderAuthState {
    this.check(providerId);
    if (this.logoutTask) throw failure("INVALID_ARGUMENT", "正在退出登录，请稍后重试。");
    if (this.login && running(this.login.state.phase)) return this.status(providerId);
    const previous = this.login?.task;
    const login: Login = { state: { providerId, loginId: randomUUID(), phase: "starting", revision: ++this.revision }, abort: new AbortController() };
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
        notify: event => {
          if (signal.aborted) return;
          if (event.type === "auth_url") this.publish(login, { phase: "waiting", authUrl: event.url, openRequest: 1 });
          // Do not forward arbitrary provider messages: they may contain URLs or tokens.
        },
        prompt: prompt => new Promise<string>((resolve, reject) => {
          if (signal.aborted || prompt.signal?.aborted) { reject(new Error("Login cancelled")); return; }
          if (prompt.type === "select") { reject(new Error("Unsupported OAuth prompt")); return; }
          login.pending?.reject(new Error("Prompt replaced"));
          const id = randomUUID();
          const cleanup = () => {
            signal.removeEventListener("abort", abort);
            prompt.signal?.removeEventListener("abort", abort);
            if (login.pending?.id === id) login.pending = undefined;
          };
          const abort = () => { cleanup(); reject(new Error("Login cancelled")); };
          login.pending = { id, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
          signal.addEventListener("abort", abort, { once: true });
          prompt.signal?.addEventListener("abort", abort, { once: true });
          this.publish(login, { phase: "waiting", prompt: { id, message: "自动回调未完成时，可粘贴本次登录的完整回调 URL。", placeholder: "http://localhost:51121/oauth-callback?code=…&state=…" } });
        }),
      };
      const credential = await runtime.login(login.state.providerId, "oauth", interaction);
      signal.throwIfAborted();
      // The login runtime stages credentials; the application commits only after cancellation checks.
      clearTimeout(login.timer);
      login.pending?.reject(new Error("Login completed"));
      this.publish(login, { phase: "completing", prompt: undefined, authUrl: undefined });
      await this.committed(credential, signal);
      this.publish(login, { phase: "succeeded", message: "Google 授权已保存。" });
    } catch (error) {
      if (!signal.aborted) {
        const portBusy = error instanceof Error && /EADDRINUSE|Port 51121 is already in use/.test(error.message);
        this.publish(login, { phase: "failed", prompt: undefined, authUrl: undefined,
          message: portBusy ? "登录端口 51121 已被占用，请结束其他 Antigravity 登录后重试。" : "Google 登录未完成，请检查网络或授权状态后重试。" });
      }
    } finally {
      clearTimeout(login.timer);
      login.pending?.reject(new Error("Login finished"));
    }
  }
  submit(input: { providerId: string; loginId: string; promptId: string; callbackUrl: string }): ProviderAuthState {
    const login = this.match(input.providerId, input.loginId);
    if (!running(login.state.phase) || login.pending?.id !== input.promptId) throw failure("INVALID_ARGUMENT", "输入请求已结束，请刷新登录状态。");
    let url: URL;
    try { url = new URL(input.callbackUrl.trim()); } catch { throw failure("INVALID_ARGUMENT", "请输入完整回调 URL。"); }
    if (url.origin !== "http://localhost:51121" || url.pathname !== "/oauth-callback" || !url.searchParams.get("code") || !url.searchParams.get("state"))
      throw failure("INVALID_ARGUMENT", "请输入本次登录的 localhost:51121/oauth-callback URL，不支持直接导入 token。");
    login.pending.resolve(url.href);
    this.publish(login, { phase: "completing", prompt: undefined });
    return this.status(input.providerId);
  }
  private match(providerId: string, loginId: string): Login {
    this.check(providerId);
    if (!this.login || this.login.state.loginId !== loginId) throw failure("INVALID_ARGUMENT", "登录会话已失效。");
    return this.login;
  }
  private stop(login: Login, phase: "cancelled" | "expired"): void {
    if (!running(login.state.phase)) return;
    login.abort.abort(); clearTimeout(login.timer);
    this.publish(login, { phase, prompt: undefined, authUrl: undefined, message: phase === "expired" ? "登录已超时，请重试。" : "登录已取消。" });
  }
  cancel(providerId: string, loginId: string): ProviderAuthState {
    this.stop(this.match(providerId, loginId), "cancelled"); return this.status(providerId);
  }
  open(providerId: string, loginId: string): ProviderAuthState {
    const login = this.match(providerId, loginId);
    if (!running(login.state.phase) || !login.state.authUrl) throw failure("INVALID_ARGUMENT", "授权链接已失效。");
    this.publish(login, { openRequest: (login.state.openRequest ?? 0) + 1 }); return this.status(providerId);
  }
  logout(providerId: string): Promise<void> {
    this.check(providerId);
    if (this.logoutTask) return this.logoutTask;
    if (this.login) this.stop(this.login, "cancelled");
    const task = (async () => {
      await this.login?.task;
      await this.removeCredential();
      if (this.login) this.publish(this.login, { phase: "idle", authUrl: undefined, prompt: undefined, message: "已退出登录。" });
    })();
    this.logoutTask = task;
    void task.finally(() => { if (this.logoutTask === task) this.logoutTask = undefined; }).catch(() => {});
    return task;
  }
  dispose(): void {
    if (this.login) { this.login.abort.abort(); clearTimeout(this.login.timer); }
    this.disposed = true;
  }
}
