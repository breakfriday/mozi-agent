import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeSession } from "../../agent-runtime";
import { failure } from "../../../errors";
import { observeExecution } from "./execution-observer";
import { createRunEntry } from "./session-entries";

type ExecutionState = "ready" | "running" | "finished" | "disposed";

/** Owns one SDK session and its reservation; observation is scoped to execute(). */
export class PiExecution implements RuntimeSession {
  private state: ExecutionState = "ready";
  private cancelled = false;
  private abortPromise?: Promise<void>;
  private disposeRequested = false;
  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly release: () => void = () => {},
  ) {}
  async execute(
    input: Parameters<RuntimeSession["execute"]>[0],
    emit: Parameters<RuntimeSession["execute"]>[1],
  ): Promise<void> {
    if (this.state !== "ready")
      throw failure("INVALID_ARGUMENT", "执行实例只能使用一次，且不能在释放后执行。");
    if (this.cancelled) return;
    this.state = "running";
    let observer: ReturnType<typeof observeExecution> | undefined;
    let sdkMayBeActive = false;
    try {
      const runEntry = createRunEntry({
        runId: input.runId,
        clientMessageId: input.clientMessageId,
      });
      this.manager.appendCustomEntry(runEntry.customType, runEntry.data);
      observer = observeExecution(this.session, this.manager, {
        runId: input.runId,
        emit,
        isCancelled: () => this.cancelled,
        // Observation failures stop the SDK without turning a failed run into cancellation.
        onError: () => { void this.abort().catch(() => {}); },
      });
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(new Date());
      await this.session.sendCustomMessage(
        {
          customType: "mozi.prompt-time",
          content: `本轮用户消息的本地时间：${localTime}（${timeZone}）。`,
          display: false,
        },
        { triggerTurn: false },
      );
      // Cancellation may arrive while the prompt context is being written.
      observer.throwIfFailed();
      if (!this.cancelled) {
        sdkMayBeActive = true;
        await this.session.prompt(
          input.content.map((part) => part.text).join("\n"),
          { expandPromptTemplates: false },
        );
      }
      // Includes retries. Neither agent_end nor message_end proves the Run is finished.
      await this.session.waitForIdle();
      sdkMayBeActive = false;
      observer.flush();
      observer.throwIfFailed();
    } catch (error) {
      // A rejected prompt/idle wait is not proof that SDK background work has stopped.
      if (sdkMayBeActive) void this.abort().catch(() => {});
      throw error;
    } finally {
      try {
        // abort() also waits for idle; never release a writer while cancellation is pending.
        if (this.abortPromise) await this.abortPromise;
      } finally {
        observer?.dispose();
        this.state = "finished";
        if (this.disposeRequested) this.dispose();
      }
    }
    // Cleanup can publish interrupted usage or fail to unsubscribe; both must fail the run.
    observer?.throwIfFailed();
  }
  private abort(): Promise<void> {
    // Memoize before calling the SDK, including synchronous exceptions and reentrant callbacks.
    return (this.abortPromise ??= Promise.resolve().then(() => this.session.abort()));
  }
  cancel(): Promise<void> {
    this.cancelled = true;
    if (this.state !== "running") return this.abortPromise ?? Promise.resolve();
    return this.abort();
  }
  dispose(): void {
    if (this.state === "disposed") return;
    this.disposeRequested = true;
    if (this.state === "running") {
      // execute() owns cleanup until its asynchronous work has settled.
      void this.cancel().catch(() => {});
      return;
    }
    this.state = "disposed";
    try {
      this.session.dispose();
    } finally {
      this.release();
    }
  }
}
