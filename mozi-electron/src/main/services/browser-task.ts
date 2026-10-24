import {
  BrowserFailure,
  type BrowserCallContext,
  type BrowserOperation,
  type BrowserProgress,
  type BrowserResult,
} from "../../../../shared/browser";

export type BrowserTaskState =
  | "created"
  | "queued"
  | "running"
  | "waiting_user"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

/** One async operation: progress callbacks, a final result, and cooperative cancellation. */
export class BrowserTask {
  readonly result: Promise<BrowserResult>;
  private readonly controller = new AbortController();
  private resolve!: (result: BrowserResult) => void;
  private reject!: (error: unknown) => void;
  private currentState: BrowserTaskState = "created";
  private timer?: ReturnType<typeof setTimeout>;
  private cancelled?: () => void;
  private resumeWait?: () => void;
  stage?: BrowserProgress["stage"];
  interactionDispatched?: boolean;

  constructor(
    readonly operation: BrowserOperation,
    readonly context: BrowserCallContext,
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  get state(): BrowserTaskState {
    return this.currentState;
  }
  get cancellationRequested(): boolean {
    return this.controller.signal.aborted;
  }
  get reason(): unknown {
    return this.controller.signal.reason;
  }
  get waitingForUser(): boolean {
    return this.state === "waiting_user";
  }
  private get settled(): boolean {
    return (
      this.state === "succeeded" ||
      this.state === "failed" ||
      this.state === "cancelled"
    );
  }

  /** Called by the scheduler on submission; starts the deadline, including queue time and manual verification. */
  onSubmitted(timeoutMs: number, onCancel: () => void): void {
    if (this.state !== "created")
      throw new Error("Only created tasks can be submitted.");
    this.currentState = "queued";
    this.cancelled = onCancel;
    this.controller.signal.addEventListener("abort", onCancel, { once: true });
    this.timer = setTimeout(
      () =>
        this.cancel(
          new BrowserFailure(
            "TIMEOUT",
            "浏览器任务超时，请重试；若出现验证页面，请处理后选择“继续读取”。",
          ),
        ),
      timeoutMs,
    );
    this.context.signal.addEventListener("abort", this.externalCancel, {
      once: true,
    });
    if (this.context.signal.aborted) this.externalCancel();
  }
  private readonly externalCancel = () =>
    this.cancel(
      this.context.signal.reason instanceof BrowserFailure
        ? this.context.signal.reason
        : new BrowserFailure("CANCELLED", "浏览器任务已取消。"),
    );

  /** Owns execution and settlement; callers await the same promise exposed as result. */
  execute(
    run: (task: BrowserTask) => Promise<BrowserResult>,
  ): Promise<BrowserResult> {
    if (this.cancellationRequested) return this.result;
    if (this.state !== "queued")
      return Promise.reject(new Error("Only queued tasks can execute."));
    this.currentState = "running";
    void (async () => {
      try {
        this.succeed(await run(this));
      } catch (error) {
        this.fail(error);
      }
    })();
    return this.result;
  }
  report(progress: BrowserProgress): void {
    this.throwIfCancelled();
    if (this.settled) return;
    this.stage = progress.stage;
    this.context.onProgress(progress);
  }
  cancel(reason: unknown): void {
    if (this.settled || this.cancellationRequested) return;
    const notRunning = this.state === "created" || this.state === "queued";
    this.currentState = "cancelling";
    this.controller.abort(reason);
    // Tasks that have not started have no runner cleanup to wait for.
    if (notRunning) this.fail(this.reason);
  }
  throwIfCancelled(): void {
    this.controller.signal.throwIfAborted();
  }

  /** Stop waiting on cancellation; the runner still owns stopping and cleaning up the host. */
  wait<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
      if (signal.aborted) abort();
    });
  }
  async pause(ms: number): Promise<void> {
    this.throwIfCancelled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.wait(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async waitForResume(announce: () => void): Promise<void> {
    this.throwIfCancelled();
    if (this.state !== "running")
      throw new Error("Only running tasks can wait for user input.");
    const resumed = new Promise<void>((resolve) => {
      this.resumeWait = resolve;
    });
    this.currentState = "waiting_user";
    try {
      announce();
      await this.wait(resumed);
    } finally {
      this.resumeWait = undefined;
      if (this.waitingForUser) this.currentState = "running";
    }
  }
  resume(): void {
    if (this.waitingForUser) this.resumeWait?.();
  }

  // Settlement happens only after the runner's finally blocks have completed.
  private succeed(result: BrowserResult): void {
    if (this.settled) return;
    if (this.cancellationRequested) {
      this.fail(this.reason);
      return;
    }
    this.finish("succeeded");
    this.resolve(result);
  }
  private fail(error: unknown): void {
    if (this.settled) return;
    const cancelled = this.cancellationRequested;
    this.finish(cancelled ? "cancelled" : "failed");
    this.reject(cancelled ? this.reason : error);
  }
  private finish(state: "succeeded" | "failed" | "cancelled"): void {
    this.currentState = state;
    clearTimeout(this.timer);
    this.context.signal.removeEventListener("abort", this.externalCancel);
    if (this.cancelled)
      this.controller.signal.removeEventListener("abort", this.cancelled);
    this.cancelled = undefined;
    this.resumeWait = undefined;
  }
}
