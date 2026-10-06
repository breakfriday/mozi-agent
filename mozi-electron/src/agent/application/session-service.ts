import { AGENT_MAX_MESSAGE_BYTES, isApiResultFor } from "../../../../shared/agent";
import type { ModelSelection, ParamsOf, ResultOf, SessionSnapshot } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import type { MetadataStore } from "./ports/metadata-store";
import type { AgentRuntime } from "./ports/agent-runtime";
import type { ApplicationControl, SessionMetadata, SessionRecord } from "./models";
import { SessionState } from "./state/session-state";
import { projectHistory } from "./state/history-projection";
import type { AgentEventPublisher } from "./agent-event-publisher";
import type { ModelService } from "./model-service";
import { failure } from "./errors";

const log = createAgentLogger("agent-service");
const now = () => new Date().toISOString();
export class SessionService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly catalog = new Map<string, SessionMetadata>();
  private readonly loading = new Map<string, Promise<SessionState>>();
  private createQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: MetadataStore, private readonly runtime: AgentRuntime,
    private readonly events: AgentEventPublisher, private readonly control: ApplicationControl, private readonly models: ModelService) {}
  async initialize(): Promise<void> {
    const nativeSessions = await this.runtime.listSessions();
    const deleted = new Set(this.repository.deletedSessionIds());
    const saved = new Map(this.repository.listSessions().map(metadata => [metadata.descriptor.sessionId, metadata]));
    // Native discovery works even with an empty/reset metadata database.
    for (const native of nativeSessions) {
      if (deleted.has(native.descriptor.sessionId)) continue;
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
    log.info("service.recovered", { stage: "native_sessions_discovered" });
  }

  async load(sessionId: string): Promise<SessionState> {
    this.control.assertAvailable();
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const metadata = this.catalog.get(sessionId);
    if (!metadata) throw failure("SESSION_NOT_FOUND", "会话不存在。");
    const job = (async () => {
      const history = await this.runtime.readHistory(metadata.descriptor);
      this.control.assertAvailable();
      this.assertExists(sessionId);
      const { record, confirmedLinks } = projectHistory(metadata, this.repository.readSession(sessionId), history);
      record.snapshot.lastSeq = this.events.sequence(sessionId);
      this.assertSnapshot(record.snapshot);
      this.control.write(() => this.repository.saveLinks(sessionId, confirmedLinks));
      const state = new SessionState(record);
      this.sessions.set(sessionId, state);
      return state;
    })();
    this.loading.set(sessionId, job);
    try { return await job; } finally { this.loading.delete(sessionId); }
  }

  create(input: ParamsOf<"session.create">): Promise<{ sessionId: string }> {
    const title = input.title ?? "新会话";
    const job = this.createQueue.then(async () => {
      this.control.assertAvailable();
      const existing = this.repository.findCreation(input.clientOperationId);
      if (existing) {
        this.assertExists(existing.sessionId);
        if (existing.title !== title || existing.model?.providerId !== input.model?.providerId || existing.model?.modelId !== input.model?.modelId) throw failure("SUBMISSION_CONFLICT", "同一创建操作的内容发生变化。");
        return { sessionId: existing.sessionId };
      }
      const model = input.model ?? this.models.defaultSelection();
      if (model) await this.models.prepare(model);
      this.control.assertAvailable();
      const descriptor = await this.runtime.createSession();
      const record: SessionRecord = {
        descriptor, messageLinks: [],
        snapshot: { session: { sessionId: descriptor.sessionId, title, ...(model ? { model } : {}), createdAt: now(), updatedAt: now() },
          lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] },
      };
      this.assertSnapshot(record.snapshot);
      const metadata = { descriptor, session: record.snapshot.session };
      this.repository.create(input.clientOperationId, metadata, input.model);
      this.catalog.set(descriptor.sessionId, metadata);
      this.sessions.set(descriptor.sessionId, new SessionState(record));
      log.info("session.created", { sessionId: descriptor.sessionId, clientOperationId: input.clientOperationId });
      return { sessionId: descriptor.sessionId };
    });
    this.createQueue = job.catch(() => {});
    return job;
  }

  async setModel(input: ParamsOf<"session.setModel">): Promise<ResultOf<"session.setModel">> {
    this.control.assertAvailable(); this.assertExists(input.sessionId);
    await this.models.prepare(input.model);
    this.control.assertAvailable(); this.assertExists(input.sessionId);
    if (this.repository.unfinishedRuns().some(run => run.sessionId === input.sessionId)) {
      throw failure("SESSION_BUSY", "请先停止当前任务，再切换 provider 或模型。");
    }
    return { session: this.bindModel(input.sessionId, input.model) };
  }
  bindModel(sessionId: string, model: ModelSelection) {
    this.assertExists(sessionId);
    const metadata = this.catalog.get(sessionId)!;
    const session = { ...metadata.session, model: { ...model }, updatedAt: now() };
    this.control.write(() => this.repository.saveSession({ ...metadata, session }));
    metadata.session = session;
    const cached = this.sessions.get(sessionId);
    if (cached) cached.record.snapshot.session = session;
    return structuredClone(session);
  }

  rename(input: ParamsOf<"session.rename">): ResultOf<"session.rename"> {
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    const title = input.title.trim();
    if (!title || input.title.length > 200) throw failure("INVALID_ARGUMENT", "会话名称需要 1–200 个字符。");
    const metadata = this.catalog.get(input.sessionId)!;
    const session = { ...metadata.session, title, updatedAt: now() };
    this.control.write(() => this.repository.saveSession({ ...metadata, session }));
    metadata.session = session;
    const cached = this.sessions.get(input.sessionId);
    if (cached) cached.record.snapshot.session = session;
    return structuredClone({ session });
  }

  delete(input: ParamsOf<"session.delete">): ResultOf<"session.delete"> {
    this.control.assertAvailable();
    if (!this.catalog.has(input.sessionId)) {
      if (this.repository.deletedSessionIds().includes(input.sessionId)) return { sessionId: input.sessionId };
      this.assertExists(input.sessionId);
    }
    if (this.repository.readSession(input.sessionId).runs.some(({ run }) =>
      ["accepted", "running", "waiting_approval", "cancelling"].includes(run.status))) {
      throw failure("SESSION_BUSY", "会话仍有任务运行，请先停止任务再删除。");
    }
    this.control.write(() => this.repository.deleteSession(input.sessionId, now()));
    this.catalog.delete(input.sessionId);
    this.sessions.delete(input.sessionId);
    return { sessionId: input.sessionId };
  }

  private assertSnapshot(snapshot: SessionSnapshot): void {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > AGENT_MAX_MESSAGE_BYTES - 1_024
      || !isApiResultFor("session.snapshot", { ok: true, result: snapshot })) throw failure("CAPACITY_EXCEEDED", "会话超过当前快照容量，请创建新会话。");
  }
  assertExists(sessionId: string): void {
    if (!this.catalog.has(sessionId)) throw failure("SESSION_NOT_FOUND", "会话不存在。");
  }
  peek(sessionId: string): SessionState | undefined { return this.sessions.get(sessionId); }
  loaded(sessionId: string): SessionState {
    const state = this.peek(sessionId);
    if (!state) throw failure("SESSION_NOT_FOUND", "会话尚未加载。");
    return state;
  }
  touch(sessionId: string, at: string): void {
    const metadata = this.catalog.get(sessionId);
    if (metadata) metadata.session.updatedAt = at;
  }
  list(input: ParamsOf<"session.list">): ResultOf<"session.list"> {
    this.control.assertAvailable();
    const ordered = [...this.catalog.values()].map(metadata => metadata.session)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId));
    const index = input.cursor ? ordered.findIndex(item => item.sessionId === input.cursor) + 1 : 0;
    if (input.cursor && index === 0) throw failure("INVALID_ARGUMENT", "无效的会话游标。");
    const items = ordered.slice(index, index + (input.limit ?? 50));
    return structuredClone({ items, ...(index + items.length < ordered.length ? { nextCursor: items.at(-1)!.sessionId } : {}) });
  }
  async snapshot(input: ParamsOf<"session.snapshot">): Promise<SessionSnapshot> {
    const state = await this.load(input.sessionId);
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    this.assertSnapshot(state.record.snapshot);
    return structuredClone(state.record.snapshot);
  }
  async respondApproval(input: ParamsOf<"approval.respond">): Promise<ResultOf<"approval.respond">> {
    const state = await this.load(input.sessionId);
    this.control.assertAvailable();
    const approval = state.record.snapshot.approvals.find(item => item.id === input.approvalId && item.runId === input.runId);
    if (!approval) throw failure("APPROVAL_NOT_FOUND", "当前文本运行时没有此审批项。");
    if (approval.status === "expired") throw failure("APPROVAL_EXPIRED", "审批已过期。");
    const expected = input.decision === "approve" ? "approved" : "denied";
    if (approval.status === expected) return { approval, disposition: "already_resolved" };
    if (approval.status !== "pending") throw failure("APPROVAL_CONFLICT", "审批决定已确定。");
    throw failure("UNSUPPORTED_CAPABILITY", "当前文本运行时未启用工具审批执行。");
  }
  async drain(): Promise<void> {
    await this.createQueue;
    await Promise.allSettled([...this.loading.values()]);
  }
}
