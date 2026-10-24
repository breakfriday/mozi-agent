import {
  BROWSER_MAX_PENDING,
  BrowserFailure,
  type BrowserResult,
} from "../../../../shared/browser";
import { BrowserTask } from "./browser-task";

/** Serial ownership of one browser, including user waits and asynchronous runner cleanup. */
export class BrowserTaskScheduler {
  private readonly tasks = new Map<string, BrowserTask>();
  private readonly queue: BrowserTask[] = [];
  private current?: BrowserTask;
  private closed = false;
  get active(): BrowserTask | undefined {
    return this.current;
  }
  get size(): number {
    return this.tasks.size;
  }

  constructor(
    private readonly run: (task: BrowserTask) => Promise<BrowserResult>,
    private readonly stop: (task: BrowserTask) => void,
    private readonly finished: (task: BrowserTask) => void,
    private readonly timeoutMs: number,
  ) {}

  enqueue(task: BrowserTask): void {
    const id = task.context.requestId;
    if (this.closed)
      throw new BrowserFailure("UNAVAILABLE", "Mozi 浏览器已关闭。");
    if (this.tasks.has(id) || this.tasks.size >= BROWSER_MAX_PENDING) {
      throw new BrowserFailure(
        "CAPACITY_EXCEEDED",
        "浏览器任务重复或队列已满。",
      );
    }
    if (task.state !== "created")
      throw new Error("Only created tasks can be submitted.");
    this.tasks.set(id, task);
    this.queue.push(task);
    task.onSubmitted(this.timeoutMs, () => {
      if (this.current === task) {
        // Stopping the host is best effort; task waits must still receive cancellation.
        try {
          this.stop(task);
        } catch {
          /* A closing target may already be gone. */
        }
      } else {
        const index = this.queue.indexOf(task);
        if (index >= 0) this.queue.splice(index, 1);
        this.tasks.delete(id);
      }
    });
    if (!task.cancellationRequested) {
      try {
        task.report({ stage: "queued", message: "等待 Mozi 浏览器执行任务…" });
      } catch (error) {
        task.cancel(error);
      }
    }
    this.pump();
  }
  cancel(id: string, reason: unknown): void {
    this.tasks.get(id)?.cancel(reason);
  }
  cancelAll(reason: unknown): void {
    for (const task of [...this.tasks.values()]) task.cancel(reason);
  }
  dispose(reason: unknown): void {
    this.closed = true;
    this.cancelAll(reason);
  }

  private pump(): void {
    if (this.current || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.current = task;
    void this.execute(task);
  }
  private async execute(task: BrowserTask): Promise<void> {
    try {
      await task.execute(this.run);
    } catch {
      /* Task has already settled its result; release ownership below. */
    } finally {
      this.tasks.delete(task.context.requestId);
      this.current = undefined;
      try {
        this.finished(task);
      } catch {
        /* Window titles must not strand the queue. */
      }
      this.pump();
    }
  }
}
