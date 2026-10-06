import type { AgentEvent, ModelSelection } from "../../../../shared/agent";
import type { MetadataStore } from "./ports/metadata-store";
import type { AgentRuntime } from "./ports/agent-runtime";
import type { ApplicationControl } from "./models";
import { AgentEventPublisher } from "./agent-event-publisher";
import { SessionService } from "./session-service";
import { ModelService } from "./model-service";
import type { ModelCatalog } from "./ports/model-catalog";
import { RunService } from "./run-service";
import { failure } from "./errors";

/** Application lifetime. Services never exit the process or own one another's state. */
export class AgentApplication implements ApplicationControl {
  readonly models: ModelService;
  readonly sessions: SessionService;
  readonly runs: RunService;
  private phase: "starting" | "ready" | "closing" | "failed" | "closed" = "starting";
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  constructor(private readonly store: MetadataStore, private readonly runtime: AgentRuntime,
    emit: (event: AgentEvent) => void, private readonly fatal: (error: unknown) => void, catalog?: ModelCatalog, startupDefault?: ModelSelection) {
    const events = new AgentEventPublisher(event => {
      try { emit(event); }
      catch (error) { this.fail(error); throw error; }
    });
    this.models = new ModelService(store, this, catalog, startupDefault);
    this.sessions = new SessionService(store, runtime, events, this, this.models);
    this.runs = new RunService(store, runtime, this.sessions, events, this, this.models);
  }
  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    if (this.phase !== "starting") return Promise.reject(failure("RUNTIME_UNAVAILABLE", "Agent 无法重新初始化。"));
    return this.initializePromise = this.recover();
  }
  private async recover(): Promise<void> {
    try {
      await this.sessions.initialize();
      this.runs.recover();
      if (this.phase === "starting") this.phase = "ready";
    } catch (error) { this.phase = "failed"; throw error; }
  }
  assertAvailable(): void {
    if (this.phase !== "ready") throw failure("RUNTIME_UNAVAILABLE", "Agent 尚未就绪或正在关闭。");
  }
  isFailed(): boolean { return this.phase === "failed"; }
  write(work: () => void): void {
    try { work(); }
    catch (error) { this.fail(error); throw error; }
  }
  fail(error: unknown): void {
    if (this.phase === "failed" || this.phase === "closed") return;
    this.phase = "failed";
    this.runs.cancelAll();
    this.fatal(error);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.phase !== "failed") this.phase = "closing";
    return this.closePromise = this.shutdown();
  }
  private async shutdown(): Promise<void> {
    try {
      // A failed initialization must not prevent releasing its acquired resources.
      await this.initializePromise?.catch(() => {});
      this.runs.cancelAll();
      await this.sessions.drain();
      await this.runs.close();
    } finally {
      try { this.runtime.dispose(); }
      finally { this.store.close(); this.phase = "closed"; }
    }
  }
}
