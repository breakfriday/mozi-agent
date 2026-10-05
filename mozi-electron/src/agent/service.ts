import { randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION, AGENT_MAX_MESSAGE_BYTES, isApiResultFor, TERMINAL_RUN_STATUSES,
} from "../../../shared/agent";
import type {
  AgentEvent, EventPayload, MessageView, RunAccepted, RunOutcome, RunView,
  RuntimeRequest, RuntimeMethod, ResultOf, SessionSnapshot, StartRunInput,
} from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import { AgentRepository, type SessionRecord } from "./repository";
import type { AgentRuntime, RuntimeOutput, RuntimeSession } from "./runtime";
import { appError, failure } from "./errors";

const log = createAgentLogger("agent-service");
const terminal = (run: RunView) => TERMINAL_RUN_STATUSES.some((status) => run.status === status);
const now = () => new Date().toISOString();
type Execution = { cancelled: boolean; session?: RuntimeSession; done: Promise<void> };

export class AgentService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly active = new Map<string, Execution>();
  private closing = false;
  private createQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repository: AgentRepository, private readonly runtime: AgentRuntime,
    private readonly emit: (event: AgentEvent) => void, private readonly fatal: (error: unknown) => void) {}

  initialize(): void {
    for (const record of this.repository.load()) {
      const unfinished = new Set(record.snapshot.runs.filter((run) => !terminal(run)).map((run) => run.id));
      // Reconcile Pi's durable entries without replaying any prompt or tool.
      for (const native of this.runtime.readHistory(record.descriptor)) {
        const link = record.messageLinks.find((item) => item.runId === native.runId && item.role === native.role && item.ordinal === native.ordinal);
        if (!link) continue;
        link.nativeEntryId = native.nativeEntryId;
        const message = record.snapshot.messages.find((item) => item.id === link.messageId);
        if (message && native.role === "assistant") {
          const previous = message.content;
          message.content = native.parts.map((part) => ({
            id: this.partId(message.id, part.index), type: "text", text: part.text,
          }));
          // Native output can outgrow the display projection just before abort/crash.
          // Retain the last valid projection rather than making history unopenable.
          try {
            if (message.content.reduce((size, part) => size + part.text.length, 0) > 256_000) throw new Error("Output limit");
            this.assertSnapshot(record.snapshot);
          } catch { message.content = previous; }
        }
      }
      for (const run of record.snapshot.runs) {
        if (!unfinished.has(run.id)) continue;
        run.status = "interrupted"; run.interruptionReason = "Agent 进程已重启，任务未自动续跑。"; run.updatedAt = now();
      }
      for (const message of record.snapshot.messages) {
        if (message.runId && unfinished.has(message.runId) && message.role === "assistant"
          && (message.status === "streaming" || message.status === "accepted")) message.status = "interrupted";
      }
      for (const tool of record.snapshot.tools) {
        if (["preparing", "running", "awaiting_approval"].includes(tool.status)) tool.status = "interrupted";
      }
      for (const approval of record.snapshot.approvals) {
        if (approval.status === "pending") { approval.status = "expired"; approval.resolvedAt = now(); }
      }
      record.snapshot.lastSeq = 0;
      this.repository.save(record);
      this.sessions.set(record.descriptor.sessionId, record);
    }
    log.info("service.recovered", { stage: "recovery_complete" });
  }

  async dispatch(request: RuntimeRequest): Promise<ResultOf<RuntimeMethod>> {
    if (this.closing) throw failure("RUNTIME_UNAVAILABLE", "Agent 正在关闭。");
    switch (request.method) {
      case "session.create": return this.create(request.params);
      case "session.list": {
        const ordered = [...this.sessions.values()].map((record) => record.snapshot.session)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId));
        const index = request.params.cursor ? ordered.findIndex((item) => item.sessionId === request.params.cursor) + 1 : 0;
        if (request.params.cursor && index === 0) throw failure("INVALID_ARGUMENT", "无效的会话游标。");
        const items = ordered.slice(index, index + (request.params.limit ?? 50));
        return { items, ...(index + items.length < ordered.length ? { nextCursor: items.at(-1)!.sessionId } : {}) };
      }
      case "session.snapshot": return structuredClone(this.record(request.params.sessionId).snapshot);
      case "run.start": return this.start(request.params);
      case "run.get": return structuredClone(this.run(request.params.sessionId, request.params.runId));
      case "run.cancel": {
        const run = this.run(request.params.sessionId, request.params.runId);
        if (terminal(run)) return { ...request.params, disposition: "already_finished", status: run.status as RunOutcome["status"] };
        const execution = this.active.get(run.id);
        if (!execution) throw failure("RUNTIME_UNAVAILABLE", "任务执行器不可用，请重新同步。");
        execution.cancelled = true;
        if (run.status !== "cancelling") {
          run.status = "cancelling"; run.updatedAt = now();
          this.publish(this.record(run.sessionId), run.id, { type: "run.updated", data: { run } }, true);
        }
        if (execution.session) void execution.session.cancel().catch(this.fatal);
        return { ...request.params, disposition: "requested" };
      }
      case "approval.respond": {
        const approval = this.record(request.params.sessionId).snapshot.approvals.find((item) => item.id === request.params.approvalId && item.runId === request.params.runId);
        if (!approval) throw failure("APPROVAL_NOT_FOUND", "当前文本运行时没有此审批项。");
        if (approval.status === "expired") throw failure("APPROVAL_EXPIRED", "审批已过期。");
        const expected = request.params.decision === "approve" ? "approved" : "denied";
        if (approval.status === expected) return { approval, disposition: "already_resolved" };
        if (approval.status !== "pending") throw failure("APPROVAL_CONFLICT", "审批决定已确定。");
        throw failure("UNSUPPORTED_CAPABILITY", "当前文本运行时未启用工具审批执行。");
      }
    }
  }

  private create(input: { clientOperationId: string; title?: string }): Promise<{ sessionId: string }> {
    const title = input.title ?? "新会话";
    const saved = this.repository.findCreation(input.clientOperationId);
    if (saved) {
      if (saved.title !== title) return Promise.reject(failure("SUBMISSION_CONFLICT", "同一创建操作的内容发生变化。"));
      return Promise.resolve({ sessionId: saved.sessionId });
    }
    // Serialize creates to avoid two Pi files for concurrent retries of one operation.
    const job = this.createQueue.then(async () => {
      if (this.closing) throw failure("RUNTIME_UNAVAILABLE", "Agent 正在关闭。");
      const existing = this.repository.findCreation(input.clientOperationId);
      if (existing) {
        if (existing.title !== title) throw failure("SUBMISSION_CONFLICT", "同一创建操作的内容发生变化。");
        return { sessionId: existing.sessionId };
      }
      const descriptor = await this.runtime.createSession();
      const record: SessionRecord = {
        descriptor, messageLinks: [],
        snapshot: { session: { sessionId: descriptor.sessionId, title, createdAt: now(), updatedAt: now() },
          lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] },
      };
      this.repository.create(input.clientOperationId, title, record);
      this.sessions.set(descriptor.sessionId, record);
      log.info("session.created", { sessionId: descriptor.sessionId, clientOperationId: input.clientOperationId });
      return { sessionId: descriptor.sessionId };
    });
    this.createQueue = job.catch(() => {});
    return job;
  }

  private start(input: StartRunInput): RunAccepted {
    const current = this.record(input.sessionId);
    const duplicate = this.repository.findSubmission(input.sessionId, input.clientMessageId);
    if (duplicate) {
      if (JSON.stringify(duplicate.input.content) !== JSON.stringify(input.content)) throw failure("SUBMISSION_CONFLICT", "同一 clientMessageId 的消息内容发生变化。");
      return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: duplicate.runId, messageId: duplicate.messageId, disposition: "duplicate" };
    }
    if (current.snapshot.runs.some((run) => !terminal(run))) throw failure("SESSION_BUSY", "当前会话仍有正在执行的任务。");
    if (this.active.size >= 8) throw failure("CAPACITY_EXCEEDED", "同时运行的任务过多。");
    const record = structuredClone(current);
    const run: RunView = { id: randomUUID(), sessionId: input.sessionId, userMessageId: randomUUID(), status: "accepted", createdAt: now(), updatedAt: now() };
    const message: MessageView = {
      id: run.userMessageId, sessionId: input.sessionId, runId: run.id, clientMessageId: input.clientMessageId,
      role: "user", status: "accepted", content: input.content.map((part, index) => ({ ...part, id: this.partId(run.userMessageId, index) })),
    };
    record.snapshot.runs.push(run); record.snapshot.messages.push(message);
    record.snapshot.session.updatedAt = now();
    record.messageLinks.push({ messageId: message.id, runId: run.id, role: "user", ordinal: 0 });
    this.assertSnapshot(record.snapshot);
    // No await in acceptance: dedupe, busy check and durable reservation are one critical section.
    this.repository.accept(record, { input, runId: run.id, messageId: message.id });
    this.sessions.set(input.sessionId, record);
    this.publish(record, run.id, { type: "run.updated", data: { run } });
    this.publish(record, run.id, { type: "message.accepted", data: { message } });
    const execution: Execution = { cancelled: false, done: Promise.resolve() };
    this.active.set(run.id, execution);
    // Schedule after returning acceptance. The request does not wait for model output.
    execution.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.execute(record, run, input, execution)).catch(this.fatal);
    return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: run.id, messageId: message.id, disposition: "accepted" };
  }

  private async execute(record: SessionRecord, run: RunView, input: StartRunInput, execution: Execution): Promise<void> {
    let outcome: RunOutcome = { status: "completed" };
    try {
      if (!execution.cancelled) execution.session = await this.runtime.openSession(record.descriptor);
      if (!execution.cancelled) {
        run.status = "running"; run.updatedAt = now();
        this.publish(record, run.id, { type: "run.updated", data: { run } }, true);
        this.publish(record, run.id, { type: "run.started", data: {} });
        await execution.session!.execute({ runId: run.id, clientMessageId: input.clientMessageId, content: input.content },
          (event) => { if (!execution.cancelled) this.output(record, run, event); });
      }
      if (execution.cancelled) outcome = { status: "cancelled" };
    } catch (error) {
      outcome = execution.cancelled ? { status: "cancelled" } : { status: "failed", error: appError(error) };
    } finally {
      execution.session?.dispose();
      // Associate durable Pi entry IDs, including user messages, after SDK persistence finishes.
      for (const native of this.runtime.readHistory(record.descriptor)) {
        const link = record.messageLinks.find((item) => item.runId === native.runId && item.role === native.role && item.ordinal === native.ordinal);
        if (link) link.nativeEntryId = native.nativeEntryId;
      }
      this.finish(record, run, outcome);
      this.active.delete(run.id);
    }
  }

  private output(record: SessionRecord, run: RunView, event: RuntimeOutput): void {
    let link = record.messageLinks.find((item) => item.runId === run.id && item.role === "assistant" && item.ordinal === event.ordinal);
    if (!link) {
      link = { messageId: randomUUID(), runId: run.id, role: "assistant", ordinal: event.ordinal };
      record.messageLinks.push(link);
      record.snapshot.messages.push({ id: link.messageId, sessionId: run.sessionId, runId: run.id, role: "assistant", status: "streaming", content: [] });
      this.publish(record, run.id, { type: "message.started", data: { messageId: link.messageId, role: "assistant" } }, true);
    }
    const message = record.snapshot.messages.find((item) => item.id === link.messageId)!;
    if (event.type === "message.delta") {
      const size = message.content.reduce((sum, part) => sum + part.text.length, 0) + event.delta.length;
      if (size > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
      const partId = this.partId(message.id, event.partIndex);
      const previous = message.content;
      message.content = message.content.map((item) => ({ ...item }));
      let part = message.content.find((item) => item.id === partId);
      if (!part) { part = { id: partId, type: "text", text: "" }; message.content.push(part); }
      part.text += event.delta;
      try { this.assertSnapshot(record.snapshot); } catch (error) { message.content = previous; throw error; }
      this.publish(record, run.id, { type: "message.text.delta", data: { messageId: message.id, partId, delta: event.delta } });
    } else if (event.type === "message.complete") {
      if (event.parts.reduce((sum, part) => sum + part.text.length, 0) > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
      const previous = message.content;
      message.content = event.parts.map((part) => ({ id: this.partId(message.id, part.index), type: "text", text: part.text }));
      try { this.assertSnapshot(record.snapshot); } catch (error) { message.content = previous; throw error; }
      message.status = "completed";
      if (event.nativeEntryId) link.nativeEntryId = event.nativeEntryId;
      this.publish(record, run.id, { type: "message.completed", data: { messageId: message.id, content: message.content } }, true);
    }
  }

  private finish(record: SessionRecord, run: RunView, outcome: RunOutcome): void {
    if (terminal(run)) return;
    run.status = outcome.status; run.updatedAt = now();
    if (outcome.status === "failed") run.error = outcome.error;
    if (outcome.status === "interrupted") run.interruptionReason = outcome.reason;
    for (const message of record.snapshot.messages) {
      if (message.runId === run.id && (message.status === "streaming" || message.status === "accepted")) {
        message.status = message.role === "user" ? "completed" : outcome.status;
      }
    }
    this.publish(record, run.id, { type: "run.updated", data: { run } }, true);
    this.publish(record, run.id, { type: "run.finished", data: outcome });
    log.info("run.finished", { sessionId: run.sessionId, runId: run.id, status: outcome.status });
  }

  private publish(record: SessionRecord, runId: string, payload: EventPayload, persist = false): void {
    record.snapshot.session.updatedAt = now();
    record.snapshot.lastSeq++;
    if (persist) this.repository.save(record);
    const event = structuredClone({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "event", sessionId: record.descriptor.sessionId, runId, seq: record.snapshot.lastSeq, ...payload }) as AgentEvent;
    this.emit(event);
  }
  private assertSnapshot(snapshot: SessionSnapshot): void {
    // Leave room for terminal status/errors and response envelopes.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > AGENT_MAX_MESSAGE_BYTES - 64_000
      || !isApiResultFor("session.snapshot", { ok: true, result: snapshot })) throw failure("CAPACITY_EXCEEDED", "会话超过当前快照容量，请创建新会话。");
  }
  private partId(messageId: string, index: number): string { return `${messageId}:text:${index}`; }
  private record(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw failure("SESSION_NOT_FOUND", "会话不存在。");
    return record;
  }
  private run(sessionId: string, runId: string): RunView {
    const run = this.record(sessionId).snapshot.runs.find((item) => item.id === runId);
    if (!run) throw failure("RUN_NOT_FOUND", "任务不存在。");
    return run;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.createQueue;
    const pending = [...this.active.values()];
    for (const execution of pending) {
      execution.cancelled = true;
      if (execution.session) void execution.session.cancel().catch(this.fatal);
    }
    await Promise.all(pending.map((execution) => execution.done));
    for (const record of this.sessions.values()) this.repository.save(record);
    this.runtime.dispose();
    this.repository.close();
  }
}
