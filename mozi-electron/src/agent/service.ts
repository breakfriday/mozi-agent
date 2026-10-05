import { randomUUID } from "node:crypto";
import { AGENT_PROTOCOL_VERSION, AGENT_MAX_MESSAGE_BYTES, isApiResultFor, TERMINAL_RUN_STATUSES } from "../../../shared/agent";
import type { AgentEvent, EventPayload, MessageView, RunAccepted, RunOutcome, RunView,
  RuntimeRequest, RuntimeMethod, ResultOf, SessionSnapshot, StartRunInput } from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import type { AgentStore } from "./agent-store";
import { contentHash, type MessageLink, type SessionMetadata, type SessionRecord } from "./storage-models";
import { SessionState, linkKey } from "./session-state";
import { projectHistory } from "./history-projection";
import type { AgentRuntime, RuntimeOutput, RuntimeSession } from "./runtime";
import { appError, failure } from "./errors";

const log = createAgentLogger("agent-service");
const terminal = (run: RunView) => TERMINAL_RUN_STATUSES.some(status => run.status === status);
const now = () => new Date().toISOString();
type Execution = { cancelled: boolean; session?: RuntimeSession; done: Promise<void> };

export class AgentService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly active = new Map<string, Execution>();
  private readonly busySessions = new Set<string>();
  private readonly catalog = new Map<string, SessionMetadata>();
  private readonly loading = new Map<string, Promise<SessionState>>();
  private closing = false;
  private storageFailed = false;
  private closePromise?: Promise<void>;
  private createQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repository: AgentStore, private readonly runtime: AgentRuntime,
    private readonly emit: (event: AgentEvent) => void, private readonly fatal: (error: unknown) => void) {}

  async initialize(): Promise<void> {
    const nativeSessions = await this.runtime.listSessions();
    const saved = new Map(this.repository.listSessions().map(metadata => [metadata.descriptor.sessionId, metadata]));
    // Native discovery works even with an empty/reset metadata database.
    for (const native of nativeSessions) {
      const id = native.descriptor.sessionId, existing = saved.get(id);
      const metadata: SessionMetadata = { descriptor: native.descriptor,
        session: existing ? { ...existing.session, updatedAt: existing.session.updatedAt > native.updatedAt ? existing.session.updatedAt : native.updatedAt }
          : { sessionId: id, title: native.title, createdAt: native.createdAt, updatedAt: native.updatedAt } };
      this.catalog.set(id, metadata);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(metadata)) this.repository.saveSession(metadata);
    }
    // Retain bindings for missing files, so history access reports a real error;
    // never silently replace a lost native session with an empty conversation.
    for (const [id, metadata] of saved) if (!this.catalog.has(id)) this.catalog.set(id, metadata);
    for (const run of this.repository.unfinishedRuns()) {
      run.status = "interrupted"; run.interruptionReason = "Agent 进程已重启，任务未自动续跑。"; run.updatedAt = now();
      this.repository.updateRun(run);
      const metadata = this.catalog.get(run.sessionId);
      if (metadata) metadata.session.updatedAt = run.updatedAt;
    }
    log.info("service.recovered", { stage: "native_sessions_discovered" });
  }

  private async loadState(sessionId: string): Promise<SessionState> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const metadata = this.catalog.get(sessionId);
    if (!metadata) throw failure("SESSION_NOT_FOUND", "会话不存在。");
    const job = (async () => {
      const history = await this.runtime.readHistory(metadata.descriptor);
      const { record, confirmedLinks } = projectHistory(metadata, this.repository.readSession(sessionId), history);
      this.assertSnapshot(record.snapshot);
      this.write(() => this.repository.saveLinks(sessionId, confirmedLinks));
      const state = new SessionState(record);
      this.sessions.set(sessionId, state);
      return state;
    })();
    this.loading.set(sessionId, job);
    try { return await job; } finally { this.loading.delete(sessionId); }
  }

  async dispatch(request: RuntimeRequest): Promise<ResultOf<RuntimeMethod>> {
    if (this.closing) throw failure("RUNTIME_UNAVAILABLE", "Agent 正在关闭。");
    if ("sessionId" in request.params) {
      if (!this.catalog.has(request.params.sessionId)) throw failure("SESSION_NOT_FOUND", "会话不存在。");
      if (request.method === "run.start") {
        const duplicate = this.duplicate(request.params);
        if (duplicate) return duplicate;
      }
      if (request.method !== "run.get" && request.method !== "run.cancel") await this.loadState(request.params.sessionId);
      if (this.closing) throw failure("RUNTIME_UNAVAILABLE", "Agent 正在关闭。");
    }
    switch (request.method) {
      case "session.create": return this.create(request.params);
      case "session.list": {
        const ordered = [...this.catalog.values()].map(metadata => metadata.session)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId));
        const index = request.params.cursor ? ordered.findIndex(item => item.sessionId === request.params.cursor) + 1 : 0;
        if (request.params.cursor && index === 0) throw failure("INVALID_ARGUMENT", "无效的会话游标。");
        const items = ordered.slice(index, index + (request.params.limit ?? 50));
        return { items, ...(index + items.length < ordered.length ? { nextCursor: items.at(-1)!.sessionId } : {}) };
      }
      case "session.snapshot": {
        const snapshot = this.state(request.params.sessionId).record.snapshot;
        this.assertSnapshot(snapshot);
        return structuredClone(snapshot);
      }
      case "run.start": return this.start(request.params);
      case "run.get": return structuredClone(this.run(request.params.sessionId, request.params.runId));
      case "run.cancel": {
        const run = this.run(request.params.sessionId, request.params.runId);
        if (terminal(run)) return { ...request.params, disposition: "already_finished", status: run.status as RunOutcome["status"] };
        const execution = this.active.get(run.id);
        if (!execution) throw failure("RUNTIME_UNAVAILABLE", "任务执行器不可用，请重新同步。");
        execution.cancelled = true;
        if (run.status !== "cancelling") {
          const state = this.state(run.sessionId);
          run.status = "cancelling"; run.updatedAt = now(); state.refreshRun(run.id);
          this.write(() => this.repository.updateRun(run));
          this.publish(state, run.id, { type: "run.updated", data: { run } });
        }
        if (execution.session) void execution.session.cancel().catch(this.fatal);
        return { ...request.params, disposition: "requested" };
      }
      case "approval.respond": {
        const approval = this.state(request.params.sessionId).record.snapshot.approvals.find(item => item.id === request.params.approvalId && item.runId === request.params.runId);
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
      this.assertSnapshot(record.snapshot);
      const metadata = { descriptor, session: record.snapshot.session };
      this.repository.create(input.clientOperationId, metadata);
      this.catalog.set(descriptor.sessionId, metadata);
      this.sessions.set(descriptor.sessionId, new SessionState(record));
      log.info("session.created", { sessionId: descriptor.sessionId, clientOperationId: input.clientOperationId });
      return { sessionId: descriptor.sessionId };
    });
    this.createQueue = job.catch(() => {});
    return job;
  }

  private duplicate(input: StartRunInput): RunAccepted | undefined {
    const duplicate = this.repository.findSubmission(input.sessionId, input.clientMessageId);
    if (duplicate) {
      if (duplicate.contentHash !== contentHash(input.content)) throw failure("SUBMISSION_CONFLICT", "同一 clientMessageId 的消息内容发生变化。");
      return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: duplicate.runId, messageId: duplicate.messageId, disposition: "duplicate" };
    }
  }

  private start(input: StartRunInput): RunAccepted {
    const state = this.state(input.sessionId);
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
    this.publish(state, run.id, { type: "run.updated", data: { run } });
    this.publish(state, run.id, { type: "message.accepted", data: { message } });
    execution.done = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.execute(state, run, input, execution)).catch(error => { if (!this.storageFailed) this.fatal(error); });
    return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: run.id, messageId: message.id, disposition: "accepted" };
  }

  private async execute(state: SessionState, run: RunView, input: StartRunInput, execution: Execution): Promise<void> {
    let outcome: RunOutcome = { status: "completed" };
    try {
      if (!execution.cancelled) execution.session = await this.runtime.openSession(state.record.descriptor);
      if (!execution.cancelled) {
        run.status = "running"; run.updatedAt = now(); state.refreshRun(run.id);
        this.write(() => this.repository.updateRun(run));
        this.publish(state, run.id, { type: "run.updated", data: { run } });
        this.publish(state, run.id, { type: "run.started", data: {} });
        await execution.session!.execute({ runId: run.id, clientMessageId: input.clientMessageId, content: input.content },
          event => { if (!this.storageFailed && !execution.cancelled && !terminal(run)) this.output(state, run, event); });
      }
      if (execution.cancelled) outcome = { status: "cancelled" };
    } catch (error) {
      outcome = execution.cancelled ? { status: "cancelled" } : { status: "failed", error: appError(error) };
    } finally {
      const links: MessageLink[] = [];
      try {
        execution.session?.dispose();
        // Only update mappings belonging to this Run. History does not trigger row rewrites.
        for (const native of this.storageFailed ? [] : await this.runtime.readHistory(state.record.descriptor)) {
          if (native.runId !== run.id) continue;
          const link = state.links.get(linkKey(run.id, native.role, native.ordinal));
          if (link && link.nativeEntryId !== native.nativeEntryId) { link.nativeEntryId = native.nativeEntryId; links.push(link); }
        }
      } catch (error) {
        if (outcome.status === "completed") outcome = { status: "failed", error: appError(error) };
      }
      if (!this.storageFailed) this.finish(state, run, outcome, links);
      this.active.delete(run.id); this.busySessions.delete(run.sessionId);
    }
  }

  private output(state: SessionState, run: RunView, event: RuntimeOutput): void {
    if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时消息序号。");
    let link = state.links.get(linkKey(run.id, "assistant", event.ordinal));
    if (!link) {
      link = { messageId: randomUUID(), runId: run.id, role: "assistant", ordinal: event.ordinal };
      const message: MessageView = { id: link.messageId, sessionId: run.sessionId, runId: run.id, role: "assistant", status: "streaming", content: [] };
      state.checkAppend(message);
      this.write(() => this.repository.saveLinks(run.sessionId, [link!]));
      state.appendMessage(message); state.appendLink(link);
      this.publish(state, run.id, { type: "message.started", data: { messageId: message.id, role: "assistant" } });
    }
    const entry = state.messages.get(link.messageId)!, message = entry.value;
    if (message.status !== "streaming") return;
    if (event.type === "message.delta") {
      const partId = this.partId(message.id, event.partIndex);
      state.appendDelta(entry, partId, event.delta);
      this.publish(state, run.id, { type: "message.text.delta", data: { messageId: message.id, partId, delta: event.delta } });
    } else if (event.type === "message.complete") {
      const content = event.parts.map(part => ({ id: this.partId(message.id, part.index), type: "text" as const, text: part.text }));
      if (new Set(content.map(part => part.id)).size !== content.length) throw failure("PROTOCOL_MISMATCH", "重复的运行时内容块。");
      state.completeMessage(entry, content);
      const links: MessageLink[] = [];
      if (event.nativeEntryId && link.nativeEntryId !== event.nativeEntryId) { link.nativeEntryId = event.nativeEntryId; links.push(link); }
      this.write(() => this.repository.saveLinks(run.sessionId, links));
      this.publish(state, run.id, { type: "message.completed", data: { messageId: message.id, content: message.content } });
    }
  }

  private finish(state: SessionState, run: RunView, outcome: RunOutcome, links: MessageLink[]): void {
    if (terminal(run)) return;
    run.status = outcome.status; run.updatedAt = now();
    if (outcome.status === "failed") run.error = { ...outcome.error, message: outcome.error.message.slice(0, 8_000) };
    if (outcome.status === "interrupted") run.interruptionReason = outcome.reason;
    state.refreshRun(run.id);
    for (const entry of state.messagesByRun.get(run.id) ?? []) {
      if (entry.value.status !== "streaming" && entry.value.status !== "accepted") continue;
      entry.value.status = entry.value.role === "user" ? "completed" : outcome.status;
      state.refreshMessage(entry);
    }
    this.write(() => this.repository.saveLinks(run.sessionId, links));
    this.write(() => this.repository.updateRun(run));
    this.publish(state, run.id, { type: "run.updated", data: { run } });
    this.publish(state, run.id, { type: "run.finished", data: outcome.status === "failed" ? { status: "failed", error: run.error! } : outcome });
    log.info("run.finished", { sessionId: run.sessionId, runId: run.id, status: outcome.status });
  }

  private write(work: () => void): void {
    try { work(); }
    catch (error) {
      // Memory may already contain the event. Do not serve it as durable after a failed write.
      this.failStorage(error); throw error;
    }
  }
  private failStorage(error: unknown): void {
    if (this.storageFailed) return;
    this.storageFailed = true; this.closing = true;
    for (const execution of this.active.values()) {
      execution.cancelled = true;
      if (execution.session) void execution.session.cancel().catch(cancelError => log.error("storage.cancel.failed", appError(cancelError)));
    }
    this.fatal(error);
  }
  private publish(state: SessionState, runId: string, payload: EventPayload): void {
    const record = state.record;
    record.snapshot.session.updatedAt = now(); record.snapshot.lastSeq++;
    this.emit(structuredClone({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "event", sessionId: record.descriptor.sessionId,
      runId, seq: record.snapshot.lastSeq, ...payload }) as AgentEvent);
  }
  private assertSnapshot(snapshot: SessionSnapshot): void {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > AGENT_MAX_MESSAGE_BYTES - 1_024
      || !isApiResultFor("session.snapshot", { ok: true, result: snapshot })) throw failure("CAPACITY_EXCEEDED", "会话超过当前快照容量，请创建新会话。");
  }
  private partId(messageId: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时内容块序号。");
    return `${messageId}:text:${index}`;
  }
  private state(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw failure("SESSION_NOT_FOUND", "会话不存在。");
    return state;
  }
  private run(sessionId: string, runId: string): RunView {
    const run = this.sessions.get(sessionId)?.runs.get(runId)?.value ?? this.repository.findRun(sessionId, runId);
    if (!run) throw failure("RUN_NOT_FOUND", "任务不存在。");
    return run;
  }
  close(): Promise<void> {
    return this.closePromise ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    this.closing = true;
    await this.createQueue;
    const pending = [...this.active.values()];
    for (const execution of pending) {
      execution.cancelled = true;
      if (execution.session) void execution.session.cancel().catch(this.fatal);
    }
    await Promise.all(pending.map(execution => execution.done));
    await Promise.allSettled([...this.loading.values()]);
    this.runtime.dispose(); this.repository.close();
  }
}
