import { AGENT_MAX_MESSAGE_BYTES, isApiResultFor, buildUsageMonitor, TOOL_OUTCOMES } from "../../../../shared/agent";
import type { EventPayload, ModelCallView, ModelSelection, ParamsOf, ResultOf, RunView, SessionSnapshot, ToolOutcome, ToolView } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import type { MetadataStore } from "../storage/metadata-store";
import type { AgentRuntime } from "../runtime/agent-runtime";
import type { ApplicationControl } from "../agent-control";
import type { MessageLink, SessionMetadata } from "../storage/metadata";
import type { AcceptedRunChange, CompletedMessageChange, FinishedRunChange, MessageDelta, SessionProjectionSeed, StartedMessageChange } from "./types/session-projection";
import { SessionProjection } from "./session-projection";
import { projectHistory } from "./history-projection";
import type { AgentEventPublisher } from "../events/event-publisher";
import type { ModelService } from "../models/model-service";
import { failure } from "../errors";
import { EMPTY_SESSION_TITLE } from "./session-title";

const log = createAgentLogger("agent-service");
const now = () => new Date().toISOString();
export class SessionService {
  private readonly sessions = new Map<string, SessionProjection>();
  private readonly catalog = new Map<string, SessionMetadata>();
  private readonly loading = new Map<string, Promise<SessionProjection>>();
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
      // One-time migration: preserve legacy non-placeholder titles before making
      // the native name/first message authoritative. A recorded source prevents
      // later automatic titles from being mistaken for user names.
      const legacyName = existing && !existing.titleSource && existing.session.title !== EMPTY_SESSION_TITLE
        ? existing.session.title.trim() : undefined;
      if (legacyName) this.runtime.setSessionName(native.descriptor, legacyName);
      const title = legacyName || native.title;
      const metadata: SessionMetadata = { descriptor: native.descriptor, titleSource: legacyName || native.name ? "explicit" : "automatic",
        session: existing ? { ...existing.session, title, updatedAt: existing.session.updatedAt > native.updatedAt ? existing.session.updatedAt : native.updatedAt }
          : { sessionId: id, title, createdAt: native.createdAt, updatedAt: native.updatedAt } };
      this.catalog.set(id, metadata);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(metadata)) this.repository.saveSession(metadata);
    }
    // Retain bindings for missing files, so history access reports a real error;
    // never silently replace a lost native session with an empty conversation.
    for (const [id, metadata] of saved) if (!this.catalog.has(id)) this.catalog.set(id, metadata);
    log.info("service.recovered", { stage: "native_sessions_discovered" });
  }

  private async load(sessionId: string): Promise<SessionProjection> {
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
      const { seed, confirmedLinks } = projectHistory(metadata, this.repository.readSession(sessionId), history);
      if (this.runtime.readUsage) seed.snapshot.usage = buildUsageMonitor(await this.runtime.readUsage(metadata.descriptor));
      this.control.assertAvailable();
      this.assertExists(sessionId);
      // A rename/model update may have completed while usage was loading.
      seed.snapshot.session = structuredClone(metadata.session);
      seed.snapshot.lastSeq = this.events.sequence(sessionId);
      this.assertSnapshot(seed.snapshot);
      const state = new SessionProjection(seed);
      this.control.write(() => this.repository.saveLinks(sessionId, confirmedLinks));
      this.sessions.set(sessionId, state);
      return state;
    })();
    this.loading.set(sessionId, job);
    try { return await job; } finally { this.loading.delete(sessionId); }
  }

  create(input: ParamsOf<"session.create">): Promise<{ sessionId: string }> {
    const title = input.title?.replace(/[\r\n]+/g, " ").trim() || EMPTY_SESSION_TITLE;
    const job = this.createQueue.then(async () => {
      this.control.assertAvailable();
      const existing = this.repository.findCreation(input.clientOperationId);
      if (existing) {
        this.assertExists(existing.sessionId);
        if (existing.title !== title || existing.model?.providerId !== input.model?.providerId || existing.model?.modelId !== input.model?.modelId
          || existing.model?.thinkingLevel !== input.model?.thinkingLevel
          || existing.model?.webMode !== input.model?.webMode
          || existing.model?.webSearch !== input.model?.webSearch || existing.model?.webExtractor !== input.model?.webExtractor) throw failure("SUBMISSION_CONFLICT", "同一创建操作的内容发生变化。");
        return { sessionId: existing.sessionId };
      }
      const model = input.model ?? this.models.defaultSelection();
      if (model) await this.models.prepare(model);
      this.control.assertAvailable();
      const descriptor = await this.runtime.createSession();
      if (input.title?.trim()) this.runtime.setSessionName(descriptor, title);
      const seed: SessionProjectionSeed = {
        messageLinks: [],
        snapshot: { session: { sessionId: descriptor.sessionId, title, ...(model ? { model } : {}), createdAt: now(), updatedAt: now() },
          lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] },
      };
      this.assertSnapshot(seed.snapshot);
      const metadata: SessionMetadata = { descriptor, session: seed.snapshot.session, titleSource: input.title?.trim() ? "explicit" : "automatic" };
      this.repository.create(input.clientOperationId, metadata, input.model);
      this.catalog.set(descriptor.sessionId, metadata);
      this.sessions.set(descriptor.sessionId, new SessionProjection(seed));
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
      throw failure("SESSION_BUSY", "请先停止当前任务，再修改模型、思考或联网设置。");
    }
    return { session: this.bindModel(input.sessionId, input.model) };
  }
  bindModel(sessionId: string, model: ModelSelection) {
    this.assertExists(sessionId);
    const metadata = this.catalog.get(sessionId)!;
    const session = { ...metadata.session, model: { ...model }, updatedAt: now() };
    const change = this.sessions.get(sessionId)?.prepareSessionUpdated(session);
    this.control.write(() => this.repository.saveSession({ ...metadata, session }));
    change?.commit();
    metadata.session = session;
    return structuredClone(session);
  }

  rename(input: ParamsOf<"session.rename">): ResultOf<"session.rename"> {
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    const title = input.title.replace(/[\r\n]+/g, " ").trim();
    if (!title || input.title.length > 200) throw failure("INVALID_ARGUMENT", "会话名称需要 1–200 个字符。");
    const metadata = this.catalog.get(input.sessionId)!;
    const session = { ...metadata.session, title, updatedAt: now() };
    const change = this.sessions.get(input.sessionId)?.prepareSessionUpdated(session);
    // Native first: a metadata-write failure can be recovered from the JSONL.
    this.runtime.setSessionName(metadata.descriptor, title);
    this.control.write(() => this.repository.saveSession({ ...metadata, session, titleSource: "explicit" }));
    change?.commit();
    metadata.titleSource = "explicit";
    metadata.session = session;
    return structuredClone({ session });
  }

  updateAutomaticTitle(sessionId: string, title: string, runId: string): void {
    const metadata = this.catalog.get(sessionId)!;
    if (metadata.titleSource === "explicit" || metadata.session.title === title) return;
    const session = { ...metadata.session, title, updatedAt: now() };
    const change = this.loaded(sessionId).prepareSessionUpdated(session);
    this.control.write(() => this.repository.saveSession({ ...metadata, session, titleSource: "automatic" }));
    change.commit();
    metadata.session = session;
    metadata.titleSource = "automatic";
    this.publish(sessionId, runId, [{ type: "session.updated", data: { session } }]);
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
    this.runtime.deleteSession(this.catalog.get(input.sessionId)!.descriptor);
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
  async ensureLoaded(sessionId: string): Promise<void> { await this.load(sessionId); }
  isLoaded(sessionId: string): boolean { return this.sessions.has(sessionId); }
  private loaded(sessionId: string): SessionProjection {
    const state = this.sessions.get(sessionId);
    if (!state) throw failure("SESSION_NOT_FOUND", "会话尚未加载。");
    return state;
  }
  touch(sessionId: string, at: string): void {
    const metadata = this.catalog.get(sessionId);
    if (!metadata) return;
    const session = { ...metadata.session, updatedAt: at };
    this.sessions.get(sessionId)?.prepareSessionUpdated(session).commit();
    metadata.session = session;
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
    const snapshot = state.toSnapshot();
    this.assertSnapshot(snapshot);
    return snapshot;
  }
  async respondApproval(input: ParamsOf<"approval.respond">): Promise<ResultOf<"approval.respond">> {
    const state = await this.load(input.sessionId);
    this.control.assertAvailable();
    const approval = state.findApproval(input.approvalId, input.runId);
    if (!approval) throw failure("APPROVAL_NOT_FOUND", "当前文本运行时没有此审批项。");
    if (approval.status === "expired") throw failure("APPROVAL_EXPIRED", "审批已过期。");
    const expected = input.decision === "approve" ? "approved" : "denied";
    if (approval.status === expected) return { approval, disposition: "already_resolved" };
    if (approval.status !== "pending") throw failure("APPROVAL_CONFLICT", "审批决定已确定。");
    throw failure("UNSUPPORTED_CAPABILITY", "当前文本运行时未启用工具审批执行。");
  }
  descriptor(sessionId: string) {
    this.assertExists(sessionId);
    return structuredClone(this.catalog.get(sessionId)!.descriptor);
  }
  model(sessionId: string): ModelSelection | undefined {
    this.assertExists(sessionId);
    return structuredClone(this.catalog.get(sessionId)!.session.model);
  }
  findMessageLink(sessionId: string, runId: string, role: MessageLink["role"], ordinal: number) {
    return this.loaded(sessionId).findMessageLink(runId, role, ordinal);
  }
  isMessageStreaming(sessionId: string, messageId: string): boolean {
    return this.loaded(sessionId).isMessageStreaming(messageId);
  }

  // These operations synchronously prepare, persist, commit and publish. Do not
  // insert awaits: async storage needs per-session serialization first.
  applyRunAccepted(sessionId: string, input: AcceptedRunChange): void {
    const change = this.loaded(sessionId).prepareRunAccepted(input);
    this.repository.accept(input.metadata, input.link);
    change.commit();
    this.publish(sessionId, input.metadata.run.id, [
      { type: "run.updated", data: { run: input.metadata.run } },
      { type: "message.accepted", data: { message: input.message } },
    ]);
  }
  applyRunUpdated(sessionId: string, run: RunView, started = false): void {
    const change = this.loaded(sessionId).prepareRunUpdated(run);
    this.control.write(() => this.repository.updateRun(run));
    change.commit();
    this.publish(sessionId, run.id, [
      { type: "run.updated", data: { run } }, ...(started ? [{ type: "run.started" as const, data: {} }] : []),
    ]);
  }
  applyAssistantStarted(sessionId: string, input: StartedMessageChange): void {
    const change = this.loaded(sessionId).prepareAssistantStarted(input);
    this.control.write(() => this.repository.saveLinks(sessionId, [input.link]));
    change.commit();
    this.publish(sessionId, input.link.runId, [{ type: "message.started", data: { messageId: input.message.id, role: "assistant" } }]);
  }
  appendMessageDelta(sessionId: string, runId: string, input: MessageDelta): void {
    this.loaded(sessionId).appendMessageDelta(input);
    this.publish(sessionId, runId, [{ type: input.type === "text" ? "message.text.delta" : "message.reasoning.delta",
      data: { messageId: input.messageId, partId: input.partId, delta: input.delta } }]);
  }
  reportResponseModel(sessionId: string, runId: string, messageId: string, responseModelId: string): void {
    this.loaded(sessionId).reportResponseModel(messageId, responseModelId);
    this.publish(sessionId, runId, [{ type: "message.model.reported", data: { messageId, responseModelId } }]);
  }
  reportTool(sessionId: string, tool: ToolView): void {
    if (!tool.runId) throw failure("PROTOCOL_MISMATCH", "工具缺少任务关联。");
    this.loaded(sessionId).reportTool(tool);
    this.publish(sessionId, tool.runId, [TOOL_OUTCOMES.includes(tool.status as ToolOutcome)
      ? { type: "tool.completed", data: { toolCallId: tool.toolCallId, outcome: tool.status as ToolOutcome, tool } }
      : { type: "tool.updated", data: { tool } }]);
  }
  reportUsage(sessionId: string, call: ModelCallView): void {
    if (!call.runId) throw failure("PROTOCOL_MISMATCH", "用量记录缺少任务关联。");
    const data = this.loaded(sessionId).reportUsage(call);
    this.publish(sessionId, call.runId, [{ type: "usage.updated", data }]);
  }
  applyMessageCompleted(sessionId: string, runId: string, input: CompletedMessageChange): void {
    const change = this.loaded(sessionId).prepareMessageCompleted(input);
    this.control.write(() => this.repository.saveLinks(sessionId, input.links));
    change.commit();
    this.publish(sessionId, runId, [{ type: "message.completed", data: { messageId: input.messageId, content: input.content } }]);
  }
  applyRunFinished(sessionId: string, input: FinishedRunChange): void {
    const change = this.loaded(sessionId).prepareRunFinished(input);
    this.control.write(() => {
      this.repository.saveLinks(sessionId, input.links);
      this.repository.updateRun(input.run);
    });
    change.commit();
    this.publish(sessionId, input.run.id, [
      ...change.tools.map(tool => ({ type: "tool.completed" as const, data: { toolCallId: tool.toolCallId, outcome: tool.status as ToolOutcome, tool } })),
      { type: "run.updated", data: { run: input.run } },
      { type: "run.finished", data: input.outcome },
    ]);
  }
  private publish(sessionId: string, runId: string, payloads: EventPayload[]): void {
    const events = this.events.prepare(sessionId, runId, payloads);
    const at = now();
    this.loaded(sessionId).recordPublication(events.at(-1)!.seq, at);
    this.catalog.get(sessionId)!.session.updatedAt = at;
    this.events.publish(events);
  }

  async drain(): Promise<void> {
    await this.createQueue;
    await Promise.allSettled([...this.loading.values()]);
  }
}
