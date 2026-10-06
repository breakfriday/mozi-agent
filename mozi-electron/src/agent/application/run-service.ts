import { randomUUID } from "node:crypto";
import type { MessageView, ParamsOf, RunAccepted, RunOutcome, RunView, ResultOf, StartRunInput } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import { isTerminalRun as terminal, transitionRun } from "../domain/run/run-machine";
import type { MetadataStore } from "./ports/metadata-store";
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from "./ports/agent-runtime";
import { contentHash, type ApplicationControl, type MessageLink } from "./models";
import { SessionState, linkKey } from "./state/session-state";
import type { SessionService } from "./session-service";
import type { AgentEventPublisher } from "./agent-event-publisher";
import { appError, failure } from "./errors";

const log = createAgentLogger("agent-service");
const now = () => new Date().toISOString();
type Execution = { cancelled: boolean; session?: RuntimeSession; done: Promise<void> };
export class RunService {
  private readonly active = new Map<string, Execution>();
  private readonly busySessions = new Set<string>();
  constructor(private readonly repository: MetadataStore, private readonly runtime: AgentRuntime,
    private readonly sessions: SessionService, private readonly events: AgentEventPublisher,
    private readonly control: ApplicationControl) {}

  recover(): void {
    for (const run of this.repository.unfinishedRuns()) {
      transitionRun(run, "interrupted", now());
      run.interruptionReason = "Agent 进程已重启，任务未自动续跑。";
      this.repository.updateRun(run);
      this.sessions.touch(run.sessionId, run.updatedAt);
    }
  }
  async start(input: StartRunInput): Promise<RunAccepted> {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    const duplicate = this.duplicate(input);
    if (duplicate) return duplicate;
    await this.sessions.load(input.sessionId);
    this.control.assertAvailable();
    return this.accept(input);
  }
  get(input: ParamsOf<"run.get">): RunView {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    return structuredClone(this.run(input.sessionId, input.runId));
  }
  cancel(input: ParamsOf<"run.cancel">): ResultOf<"run.cancel"> {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    const run = this.run(input.sessionId, input.runId);
    if (terminal(run)) return { ...input, disposition: "already_finished", status: run.status as RunOutcome["status"] };
    const execution = this.active.get(run.id);
    if (!execution) throw failure("RUNTIME_UNAVAILABLE", "任务执行器不可用，请重新同步。");
    execution.cancelled = true;
    if (transitionRun(run, "cancelling", now())) {
      const state = this.sessions.loaded(run.sessionId);
      state.refreshRun(run.id);
      this.control.write(() => this.repository.updateRun(run));
      this.events.publish(state, run.id, { type: "run.updated", data: { run } });
    }
    if (execution.session) void execution.session.cancel().catch(error => this.control.fail(error));
    return { ...input, disposition: "requested" };
  }
  private duplicate(input: StartRunInput): RunAccepted | undefined {
    const duplicate = this.repository.findSubmission(input.sessionId, input.clientMessageId);
    if (duplicate) {
      if (duplicate.contentHash !== contentHash(input.content)) throw failure("SUBMISSION_CONFLICT", "同一 clientMessageId 的消息内容发生变化。");
      return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: duplicate.runId, messageId: duplicate.messageId, disposition: "duplicate" };
    }
  }

  private accept(input: StartRunInput): RunAccepted {
    const state = this.sessions.loaded(input.sessionId);
    // Check again after async history loading: simultaneous retries share one acceptance.
    const duplicate = this.duplicate(input);
    if (duplicate) return duplicate;
    const hash = contentHash(input.content);
    if (this.busySessions.has(input.sessionId)) throw failure("SESSION_BUSY", "当前会话仍有正在执行的任务。");
    if (this.active.size >= 8) throw failure("CAPACITY_EXCEEDED", "同时运行的任务过多。");
    const run: RunView = { id: randomUUID(), sessionId: input.sessionId, userMessageId: randomUUID(), status: "accepted", createdAt: now(), updatedAt: now() };
    const message: MessageView = {
      id: run.userMessageId, sessionId: input.sessionId, runId: run.id, clientMessageId: input.clientMessageId,
      role: "user", status: "accepted", content: input.content.map((part, index) => ({ ...part, id: this.partId(run.userMessageId, index) })),
    };
    const link: MessageLink = { messageId: message.id, runId: run.id, role: "user", ordinal: 0 };
    state.checkAppend(message, run);
    // Reserve pending input, Run and stable ID in one durable transaction.
    // No projection or completed message body is passed into the store.
    this.repository.accept({ run, clientMessageId: input.clientMessageId, contentHash: hash, pendingContent: input.content }, link);
    state.appendRun(run); state.appendMessage(message); state.appendLink(link);
    this.busySessions.add(input.sessionId);
    const execution: Execution = { cancelled: false, done: Promise.resolve() };
    this.active.set(run.id, execution);
    this.events.publish(state, run.id, { type: "run.updated", data: { run } });
    this.events.publish(state, run.id, { type: "message.accepted", data: { message } });
    execution.done = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.execute(state, run, input, execution)).catch(error => { if (!this.control.isFailed()) this.control.fail(error); });
    return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: run.id, messageId: message.id, disposition: "accepted" };
  }

  private async execute(state: SessionState, run: RunView, input: StartRunInput, execution: Execution): Promise<void> {
    let outcome: RunOutcome = { status: "completed" };
    try {
      if (!execution.cancelled) execution.session = await this.runtime.openSession(state.record.descriptor);
      if (!execution.cancelled) {
        transitionRun(run, "running", now()); state.refreshRun(run.id);
        this.control.write(() => this.repository.updateRun(run));
        this.events.publish(state, run.id, { type: "run.updated", data: { run } });
        this.events.publish(state, run.id, { type: "run.started", data: {} });
        await execution.session!.execute({ runId: run.id, clientMessageId: input.clientMessageId, content: input.content },
          event => { if (!this.control.isFailed() && !execution.cancelled && !terminal(run)) this.output(state, run, event); });
      }
      if (execution.cancelled) outcome = { status: "cancelled" };
    } catch (error) {
      outcome = execution.cancelled ? { status: "cancelled" } : { status: "failed", error: appError(error) };
    } finally {
      const links: MessageLink[] = [];
      try {
        const session = execution.session;
        execution.session = undefined;
        session?.dispose();
        // Only update mappings belonging to this Run. History does not trigger row rewrites.
        for (const native of this.control.isFailed() ? [] : await this.runtime.readHistory(state.record.descriptor)) {
          if (native.runId !== run.id) continue;
          const link = state.links.get(linkKey(run.id, native.role, native.ordinal));
          if (link && link.nativeEntryId !== native.nativeEntryId) { link.nativeEntryId = native.nativeEntryId; links.push(link); }
        }
      } catch (error) {
        if (outcome.status === "completed") outcome = { status: "failed", error: appError(error) };
      }
      // Cancellation can arrive while native-history reconciliation is awaiting I/O.
      if (execution.cancelled) outcome = { status: "cancelled" };
      try { if (!this.control.isFailed()) this.finish(state, run, outcome, links); }
      finally { this.active.delete(run.id); this.busySessions.delete(run.sessionId); }
    }
  }

  private output(state: SessionState, run: RunView, event: RuntimeEvent): void {
    if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时消息序号。");
    let link = state.links.get(linkKey(run.id, "assistant", event.ordinal));
    if (!link) {
      link = { messageId: randomUUID(), runId: run.id, role: "assistant", ordinal: event.ordinal };
      const message: MessageView = { id: link.messageId, sessionId: run.sessionId, runId: run.id, role: "assistant", status: "streaming", content: [] };
      state.checkAppend(message);
      this.control.write(() => this.repository.saveLinks(run.sessionId, [link!]));
      state.appendMessage(message); state.appendLink(link);
      this.events.publish(state, run.id, { type: "message.started", data: { messageId: message.id, role: "assistant" } });
    }
    const entry = state.messages.get(link.messageId)!, message = entry.value;
    if (message.status !== "streaming") return;
    if (event.type === "message.delta") {
      const partId = this.partId(message.id, event.partIndex);
      state.appendDelta(entry, partId, event.delta);
      this.events.publish(state, run.id, { type: "message.text.delta", data: { messageId: message.id, partId, delta: event.delta } });
    } else if (event.type === "message.complete") {
      const content = event.parts.map(part => ({ id: this.partId(message.id, part.index), type: "text" as const, text: part.text }));
      if (new Set(content.map(part => part.id)).size !== content.length) throw failure("PROTOCOL_MISMATCH", "重复的运行时内容块。");
      state.completeMessage(entry, content);
      const links: MessageLink[] = [];
      if (event.nativeEntryId && link.nativeEntryId !== event.nativeEntryId) { link.nativeEntryId = event.nativeEntryId; links.push(link); }
      this.control.write(() => this.repository.saveLinks(run.sessionId, links));
      this.events.publish(state, run.id, { type: "message.completed", data: { messageId: message.id, content: message.content } });
    }
  }

  private finish(state: SessionState, run: RunView, outcome: RunOutcome, links: MessageLink[]): void {
    if (!transitionRun(run, outcome.status, now())) return;
    if (outcome.status === "failed") run.error = { ...outcome.error, message: outcome.error.message.slice(0, 8_000) };
    if (outcome.status === "interrupted") run.interruptionReason = outcome.reason;
    state.refreshRun(run.id);
    for (const entry of state.messagesByRun.get(run.id) ?? []) {
      if (entry.value.status !== "streaming" && entry.value.status !== "accepted") continue;
      entry.value.status = entry.value.role === "user" ? "completed" : outcome.status;
      state.refreshMessage(entry);
    }
    this.control.write(() => this.repository.saveLinks(run.sessionId, links));
    this.control.write(() => this.repository.updateRun(run));
    this.events.publish(state, run.id, { type: "run.updated", data: { run } });
    this.events.publish(state, run.id, { type: "run.finished", data: outcome.status === "failed" ? { status: "failed", error: run.error! } : outcome });
    log.info("run.finished", { sessionId: run.sessionId, runId: run.id, status: outcome.status });
  }

  private partId(messageId: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时内容块序号。");
    return `${messageId}:text:${index}`;
  }
  private run(sessionId: string, runId: string): RunView {
    const run = this.sessions.peek(sessionId)?.runs.get(runId)?.value ?? this.repository.findRun(sessionId, runId);
    if (!run) throw failure("RUN_NOT_FOUND", "任务不存在。");
    return run;
  }
  cancelAll(): void {
    for (const execution of this.active.values()) {
      execution.cancelled = true;
      if (execution.session) void execution.session.cancel().catch(error => this.control.fail(error));
    }
  }
  async close(): Promise<void> {
    this.cancelAll();
    await Promise.all([...this.active.values()].map(execution => execution.done));
  }
}
