import { AGENT_MAX_MESSAGE_BYTES, isApiResultFor, buildUsageMonitor, TOOL_OUTCOMES } from "../../../../shared/agent";
import type { DerivedSourceView, EventPayload, ModelCallView, ModelSelection, ParamsOf, ResultOf, RunView, SessionSnapshot, ToolOutcome, ToolView } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import type { MetadataStore } from "../storage/metadata-store";
import type { AgentRuntime } from "../runtime/agent-runtime";
import type { ApplicationControl } from "../agent-control";
import type { MessageLink, SessionMetadata } from "../storage/metadata";
import type { AcceptedRunChange, CompletedMessageChange, FinishedRunChange, MessageDelta, SessionProjectionSeed, StartedMessageChange } from "./types/session-projection";
import { SessionProjection } from "./session-projection";
import { projectHistory } from "./history-projection";
import { computeBudgetTokens, packSessionsContext, type PackedContext, type PackSource } from "./session-context-packer";
import type { AgentEventPublisher } from "../events/event-publisher";
import type { ModelService } from "../models/model-service";
import { failure } from "../errors";
import { EMPTY_SESSION_TITLE } from "./session-title";

const PRIOR_SESSIONS_CUSTOM_TYPE = "mozi.prior-sessions";
const SOURCE_READ_CONCURRENCY = 4;

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]!, current);
    }
  });
  await Promise.all(runners);
  return results;
}

function sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((val, idx) => val === right[idx]);
}

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
      if (this.runtime.readDerivation) {
        const derivation = await this.runtime.readDerivation(metadata.descriptor);
        if (derivation) seed.snapshot.derivedFrom = this.resolveDerivedFrom(derivation.details.sources);
      }
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

  private resolveDerivedFrom(sources: readonly { sessionId: string; title: string }[]): DerivedSourceView[] {
    return sources.map((source) => {
      const live = this.catalog.get(source.sessionId);
      return {
        sessionId: source.sessionId,
        title: live ? live.session.title : source.title,
        deleted: !live,
      };
    });
  }

  private validateSourceSessionIds(sourceSessionIds: readonly string[]): string[] {
    if (!Array.isArray(sourceSessionIds)
      || sourceSessionIds.length < 1
      || sourceSessionIds.length > 20
      || new Set(sourceSessionIds).size !== sourceSessionIds.length
      || sourceSessionIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw failure("INVALID_ARGUMENT", "前置会话需要 1–20 个不重复的会话 ID。");
    }
    for (const id of sourceSessionIds) {
      if (!this.catalog.has(id)) throw failure("SESSION_NOT_FOUND", "所选前置会话不存在。");
    }
    return [...sourceSessionIds];
  }

  private async collectPackSources(sourceSessionIds: readonly string[], model?: ModelSelection): Promise<PackedContext> {
    const validIds = this.validateSourceSessionIds(sourceSessionIds);
    const activeSessionIds = new Set(this.repository.unfinishedRuns().map((run) => run.sessionId));
    const sources = await mapConcurrent(validIds, SOURCE_READ_CONCURRENCY, async (id): Promise<PackSource> => {
      this.control.assertAvailable();
      const metadata = this.catalog.get(id);
      if (!metadata) throw failure("SESSION_NOT_FOUND", "所选前置会话不存在。");
      const [messages, derivation] = await Promise.all([
        this.runtime.readHistory(metadata.descriptor),
        this.runtime.readDerivation ? this.runtime.readDerivation(metadata.descriptor) : Promise.resolve(undefined),
      ]);
      this.control.assertAvailable();
      const latest = this.catalog.get(id);
      if (!latest) throw failure("SESSION_NOT_FOUND", "所选前置会话不存在。");
      return {
        sessionId: id,
        title: latest.session.title,
        cwd: latest.descriptor.cwd,
        running: activeSessionIds.has(id),
        derived: !!derivation,
        ...(derivation ? { derivedCount: derivation.details.sources.length } : {}),
        messages,
      };
    });
    const contextWindow = await this.models.contextWindow(model);
    this.control.assertAvailable();
    const budgetTokens = computeBudgetTokens(contextWindow);
    return packSessionsContext(sources, { budgetTokens });
  }

  async previewContext(input: ParamsOf<"session.previewContext">): Promise<ResultOf<"session.previewContext">> {
    this.control.assertAvailable();
    const packed = await this.collectPackSources(input.sourceSessionIds, input.model);
    this.control.assertAvailable();
    return structuredClone({
      sources: packed.sources,
      packedChars: packed.packedChars,
      estimatedTokens: packed.estimatedTokens,
      budgetTokens: packed.budgetTokens,
      overBudget: packed.overBudget,
    });
  }

  async context(input: ParamsOf<"session.context">): Promise<ResultOf<"session.context">> {
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    const metadata = this.catalog.get(input.sessionId)!;
    const derivation = this.runtime.readDerivation
      ? await this.runtime.readDerivation(metadata.descriptor)
      : undefined;
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    if (!derivation) return {};
    return structuredClone({
      derivation: {
        text: derivation.text,
        sources: this.resolveDerivedFrom(derivation.details.sources),
      },
    });
  }

  listProjects(): ResultOf<"project.list"> {
    this.control.assertAvailable();
    return { items: this.repository.listProjects() };
  }
  private assertProject(projectId: string | null | undefined): void {
    if (projectId && !this.repository.listProjects().some(p => p.id === projectId))
      throw failure("INVALID_ARGUMENT", "项目不存在或已删除。");
  }
  saveProject(input: ParamsOf<"project.create">, create: boolean): ResultOf<"project.create"> {
    this.control.assertAvailable();
    const name = input.name.replace(/[\r\n]+/g, " ").trim();
    if (!name || name.length > 100) throw failure("INVALID_ARGUMENT", "项目名称需要 1–100 个字符。");
    const projects = this.repository.listProjects();
    const existing = projects.find(p => p.id === input.projectId);
    if (!create && !existing) throw failure("INVALID_ARGUMENT", "项目不存在。");
    if (create && existing) {
      if (existing.name !== name) throw failure("SUBMISSION_CONFLICT", "项目创建请求发生变化。");
      return { project: existing };
    }
    if (projects.some(p => p.id !== input.projectId && p.name === name))
      throw failure("INVALID_ARGUMENT", "已存在同名项目。");
    const at = now();
    const project = { id: input.projectId, name, createdAt: existing?.createdAt ?? at, updatedAt: at };
    this.control.write(() => this.repository.saveProject(project));
    return { project };
  }
  private commitProject(sessionId: string, projectId: string | null): void {
    const metadata = this.catalog.get(sessionId)!;
    const session = { ...metadata.session, projectId };
    this.sessions.get(sessionId)?.prepareSessionUpdated(session).commit();
    metadata.session = session;
  }
  deleteProject(input: ParamsOf<"project.delete">): ResultOf<"project.delete"> {
    this.control.assertAvailable();
    this.control.write(() => this.repository.deleteProject(input.projectId));
    for (const [id, metadata] of this.catalog)
      if (metadata.session.projectId === input.projectId) this.commitProject(id, null);
    return input;
  }
  move(input: ParamsOf<"session.move">): ResultOf<"session.move"> {
    this.control.assertAvailable();
    this.assertExists(input.sessionId);
    this.assertProject(input.projectId);
    this.control.write(() => this.repository.moveSession(input.sessionId, input.projectId));
    this.commitProject(input.sessionId, input.projectId);
    return { session: structuredClone(this.catalog.get(input.sessionId)!.session) };
  }

  async create(input: ParamsOf<"session.create">): Promise<{ sessionId: string }> {
    this.control.assertAvailable();
    const title = input.title?.replace(/[\r\n]+/g, " ").trim() || EMPTY_SESSION_TITLE;
    const requestedSources = input.sourceSessionIds ? this.validateSourceSessionIds(input.sourceSessionIds) : undefined;
    const existingBeforeQueue = this.repository.findCreation(input.clientOperationId);
    const packed = !existingBeforeQueue && requestedSources
      ? await this.collectPackSources(requestedSources, input.model)
      : undefined;
    if (packed) {
      if (packed.details.sources.length === 0 || !packed.text) {
        throw failure("INVALID_ARGUMENT", "所选前置会话没有可用内容。");
      }
      if (packed.overBudget) {
        throw failure("CAPACITY_EXCEEDED", "所选前置会话超出上下文预算，请减少会话数量。");
      }
    }
    const job = this.createQueue.then(async () => {
      this.control.assertAvailable();
      const existing = this.repository.findCreation(input.clientOperationId);
      if (existing) {
        this.assertExists(existing.sessionId);
        const existingMeta = this.catalog.get(existing.sessionId)!;
        const existingDerivation = this.runtime.readDerivation
          ? await this.runtime.readDerivation(existingMeta.descriptor)
          : undefined;
        this.control.assertAvailable();
        this.assertExists(existing.sessionId);
        if ((existing.projectId ?? null) !== (input.projectId ?? null) || existing.title !== title || existing.model?.providerId !== input.model?.providerId || existing.model?.modelId !== input.model?.modelId
          || existing.model?.thinkingLevel !== input.model?.thinkingLevel
          || existing.model?.webMode !== input.model?.webMode
          || existing.model?.webSearch !== input.model?.webSearch || existing.model?.webExtractor !== input.model?.webExtractor
          || !sameStringArray(existingDerivation?.details.sourceSessionIds, requestedSources)) {
          throw failure("SUBMISSION_CONFLICT", "同一创建操作的内容发生变化。");
        }
        return { sessionId: existing.sessionId };
      }
      let finalPacked = packed;
      if (requestedSources) {
        for (const id of requestedSources) this.assertExists(id);
        if (!finalPacked) {
          finalPacked = await this.collectPackSources(requestedSources, input.model);
          if (finalPacked.details.sources.length === 0 || !finalPacked.text) {
            throw failure("INVALID_ARGUMENT", "所选前置会话没有可用内容。");
          }
          if (finalPacked.overBudget) {
            throw failure("CAPACITY_EXCEEDED", "所选前置会话超出上下文预算，请减少会话数量。");
          }
        }
      }
      this.assertProject(input.projectId);
      const model = input.model ?? this.models.defaultSelection();
      if (model) await this.models.prepare(model);
      this.control.assertAvailable();
      if (requestedSources) {
        for (const id of requestedSources) this.assertExists(id);
      }
      const details = finalPacked && requestedSources
        ? { ...finalPacked.details, sourceSessionIds: requestedSources }
        : undefined;
      const descriptor = finalPacked && details
        ? await this.runtime.createSession({
            initialContext: { customType: PRIOR_SESSIONS_CUSTOM_TYPE, text: finalPacked.text, details },
          })
        : await this.runtime.createSession();
      // Creation may await the native runtime while another window deletes the project.
      // Do not leave an orphan native session on this expected validation failure.
      try { this.assertProject(input.projectId); }
      catch (error) { this.runtime.deleteSession(descriptor); throw error; }
      if (input.title?.trim()) this.runtime.setSessionName(descriptor, title);
      const derivedFrom = details ? this.resolveDerivedFrom(details.sources) : undefined;
      const seed: SessionProjectionSeed = {
        messageLinks: [],
        snapshot: {
          session: { sessionId: descriptor.sessionId, projectId: input.projectId ?? null, title, ...(model ? { model } : {}), createdAt: now(), updatedAt: now() },
          ...(derivedFrom ? { derivedFrom } : {}),
          lastSeq: 0, messages: [], runs: [], tools: [], approvals: [],
        },
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
    const activeRuns = new Map(this.repository.unfinishedRuns().map(run => [run.sessionId, { id: run.id, status: run.status }]));
    const ordered = [...this.catalog.values()].map(metadata => ({ ...metadata.session, activeRun: activeRuns.get(metadata.session.sessionId) }))
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
    if (snapshot.derivedFrom) {
      snapshot.derivedFrom = this.resolveDerivedFrom(snapshot.derivedFrom);
    }
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
