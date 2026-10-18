import { AGENT_MAX_MESSAGE_BYTES, buildUsageMonitor } from "../../../../shared/agent";
import type { MessageView, ModelCallView, RunView, SessionSnapshot, SessionSummary, ToolView } from "../../../../shared/agent";
import { failure } from "../errors";
import type { MessageLink } from "../storage/metadata";
import { linkKey } from "./message-identity";
import type {
  AcceptedRunChange, CompletedMessageChange, FinishedRunChange, MessageDelta, MessageEntry,
  PreparedProjectionChange, PreparedRunFinish, ProjectionPatch, ProjectionSize, RunEntry,
  SessionProjectionSeed, StartedMessageChange,
} from "./types/session-projection";

const chars = (message: MessageView) => message.content.reduce((sum, part) => sum + part.text.length, 0);
function measure(value: unknown): ProjectionSize {
  const nodes = (item: unknown): number => 1 + (item && typeof item === "object"
    ? Object.values(item).reduce<number>((sum, child) => sum + nodes(child), 0) : 0);
  return { bytes: Buffer.byteLength(JSON.stringify(value)), nodes: nodes(value) };
}

/** SessionService owns its lifetime. All mutable representation stays inside this object. */
export class SessionProjection {
  readonly #snapshot: SessionSnapshot;
  readonly #messages = new Map<string, MessageEntry>();
  readonly #runs = new Map<string, RunEntry>();
  readonly #links = new Map<string, MessageLink>();
  readonly #messagesByRun = new Map<string, Set<string>>();
  #size: ProjectionSize;
  #revision = 0;

  constructor(seed: SessionProjectionSeed) {
    const owned = structuredClone(seed);
    this.#snapshot = owned.snapshot;
    this.#size = measure(this.#snapshot);
    for (const [position, value] of this.#snapshot.messages.entries()) {
      this.validateMessage(value);
      if (this.#messages.has(value.id)) throw failure("PROTOCOL_MISMATCH", "重复的消息标识。");
      this.#messages.set(value.id, { value, position, chars: chars(value), ...measure(value) });
      this.indexRunMessage(value);
    }
    for (const [position, value] of this.#snapshot.runs.entries()) {
      this.assertSession(value.sessionId);
      if (this.#runs.has(value.id)) throw failure("PROTOCOL_MISMATCH", "重复的任务标识。");
      this.#runs.set(value.id, { value, position, ...measure(value) });
    }
    for (const link of owned.messageLinks) {
      const key = linkKey(link.runId, link.role, link.ordinal);
      if (this.#links.has(key)) throw failure("PROTOCOL_MISMATCH", "重复的消息关联。");
      this.#links.set(key, link);
    }
  }

  toSnapshot(): SessionSnapshot { return structuredClone(this.#snapshot); }
  findMessageLink(runId: string, role: MessageLink["role"], ordinal: number): MessageLink | undefined {
    const link = this.#links.get(linkKey(runId, role, ordinal));
    return link && structuredClone(link);
  }
  isMessageStreaming(messageId: string): boolean { return this.message(messageId).value.status === "streaming"; }
  findApproval(id: string, runId: string) {
    return structuredClone(this.#snapshot.approvals.find(item => item.id === id && item.runId === runId));
  }

  prepareSessionUpdated(session: SessionSummary): PreparedProjectionChange { return this.prepare({ session }); }

  prepareRunAccepted({ metadata, message, link }: AcceptedRunChange): PreparedProjectionChange {
    const run = metadata.run;
    if (this.#runs.has(run.id) || this.#messages.has(message.id) || run.userMessageId !== message.id
      || message.runId !== run.id || message.role !== "user" || link.role !== "user") {
      throw failure("PROTOCOL_MISMATCH", "接受记录与消息不匹配。");
    }
    this.assertNewLink(message, link);
    return this.prepare({ runs: [run], messages: [message], links: [link] });
  }

  prepareRunUpdated(run: RunView): PreparedProjectionChange {
    if (!this.#runs.has(run.id)) throw failure("RUN_NOT_FOUND", "投影中的任务不存在。");
    return this.prepare({ runs: [run] }, true);
  }

  prepareAssistantStarted({ message, link }: StartedMessageChange): PreparedProjectionChange {
    if (this.#messages.has(message.id) || message.role !== "assistant" || link.role !== "assistant"
      || !message.runId || !this.#runs.has(message.runId)) throw failure("PROTOCOL_MISMATCH", "助手消息关联无效。");
    this.assertNewLink(message, link);
    return this.prepare({ messages: [message], links: [link] });
  }

  prepareMessageCompleted({ messageId, content, links }: CompletedMessageChange): PreparedProjectionChange {
    const message = this.message(messageId).value;
    if (message.status !== "streaming") throw failure("PROTOCOL_MISMATCH", "消息已结束。");
    this.validateLinks(links);
    if (links.some(link => link.messageId !== messageId)) throw failure("PROTOCOL_MISMATCH", "消息完成关联不匹配。");
    return this.prepare({ messages: [{ ...message, content, status: "completed" }], links });
  }

  prepareRunFinished({ run, outcome, links }: FinishedRunChange): PreparedRunFinish {
    if (!this.#runs.has(run.id) || run.status !== outcome.status) throw failure("PROTOCOL_MISMATCH", "任务终态不匹配。");
    this.validateLinks(links);
    if (links.some(link => link.runId !== run.id)) throw failure("PROTOCOL_MISMATCH", "任务结束关联不匹配。");
    const messages: MessageView[] = [];
    for (const id of this.#messagesByRun.get(run.id) ?? []) {
      const message = this.message(id).value;
      if (message.status === "streaming" || message.status === "accepted") {
        messages.push({ ...message, status: message.role === "user" ? "completed" : outcome.status });
      }
    }
    const tools: ToolView[] = this.#snapshot.tools
      .filter(tool => tool.runId === run.id && ["preparing", "running", "awaiting_approval"].includes(tool.status))
      .map(tool => ({ ...tool, status: outcome.status === "cancelled" ? "cancelled" : "interrupted" }));
    const prepared = this.prepare({ runs: [run], messages, tools, links }, true);
    return { ...prepared, tools: structuredClone(tools) };
  }

  appendMessageDelta({ messageId, partId, type, delta }: MessageDelta): void {
    const entry = this.message(messageId);
    if (entry.value.status !== "streaming") throw failure("PROTOCOL_MISMATCH", "消息已结束。");
    if (entry.chars + delta.length > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
    let part = entry.value.content.find(part => part.id === partId);
    if (part && part.type !== type) throw failure("PROTOCOL_MISMATCH", "内容块类型发生变化。");
    const added = part ? { bytes: 0, nodes: 0 } : measure({ id: partId, type, text: "" });
    // Only measure the delta. Split surrogate pairs can conservatively overcount until completion.
    const growth = { bytes: added.bytes + (part ? 0 : 1) + Buffer.byteLength(JSON.stringify(delta)) - 2, nodes: added.nodes };
    this.ensureCapacity(growth);
    if (!part) { part = { id: partId, type, text: "" }; entry.value.content.push(part); }
    part.text += delta; entry.chars += delta.length;
    entry.bytes += growth.bytes; entry.nodes += growth.nodes;
    this.grow(growth); this.#revision++;
  }

  reportResponseModel(messageId: string, responseModelId: string): void {
    this.prepare({ messages: [{ ...this.message(messageId).value, responseModelId }] }).commit();
  }
  reportTool(tool: ToolView): void {
    if (!tool.messageId || !tool.runId) throw failure("PROTOCOL_MISMATCH", "工具缺少消息或任务关联。");
    const message = this.message(tool.messageId).value;
    if (message.runId !== tool.runId) throw failure("PROTOCOL_MISMATCH", "工具与消息所属任务不匹配。");
    const existing = this.#snapshot.tools.find(item => item.toolCallId === tool.toolCallId);
    if (existing && (existing.runId !== tool.runId || existing.messageId !== tool.messageId)) {
      throw failure("PROTOCOL_MISMATCH", "工具所属消息不能改变。");
    }
    this.prepare({ tools: [tool] }).commit();
  }
  reportUsage(call: ModelCallView) {
    if (!call.runId) throw failure("PROTOCOL_MISMATCH", "用量记录缺少任务关联。");
    const usage = buildUsageMonitor([...(this.#snapshot.usage?.calls ?? []), structuredClone(call)]);
    const result = structuredClone({ call, total: usage.total, runTotal: usage.runs.find(run => run.runId === call.runId)!.total });
    this.prepare({ usage }).commit();
    return result;
  }

  /** Publication metadata only; reserved capacity covers timestamps and sequence digits. */
  recordPublication(lastSeq: number, at: string): void {
    if (!Number.isSafeInteger(lastSeq) || lastSeq <= this.#snapshot.lastSeq) throw failure("PROTOCOL_MISMATCH", "无效的事件序号。");
    const before = measure({ lastSeq: this.#snapshot.lastSeq, updatedAt: this.#snapshot.session.updatedAt });
    const after = measure({ lastSeq, updatedAt: at });
    this.#snapshot.lastSeq = lastSeq;
    this.#snapshot.session.updatedAt = at;
    this.grow({ bytes: after.bytes - before.bytes, nodes: after.nodes - before.nodes });
    this.#revision++;
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.#snapshot.session.sessionId) throw failure("PROTOCOL_MISMATCH", "投影会话不匹配。");
  }
  private message(id: string): MessageEntry {
    const entry = this.#messages.get(id);
    if (!entry) throw failure("PROTOCOL_MISMATCH", "投影消息不存在。");
    return entry;
  }
  private validateMessage(message: MessageView): void {
    this.assertSession(message.sessionId);
    if (chars(message) > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
    if (new Set(message.content.map(part => part.id)).size !== message.content.length) throw failure("PROTOCOL_MISMATCH", "重复的内容块标识。");
  }
  private assertNewLink(message: MessageView, link: MessageLink): void {
    if (link.messageId !== message.id || link.runId !== message.runId || link.role !== message.role
      || !Number.isSafeInteger(link.ordinal) || link.ordinal < 0 || this.#links.has(linkKey(link.runId, link.role, link.ordinal))) {
      throw failure("PROTOCOL_MISMATCH", "消息身份关联不匹配。");
    }
  }
  private validateLinks(links: MessageLink[]): void {
    for (const link of links) {
      const existing = this.#links.get(linkKey(link.runId, link.role, link.ordinal));
      if (!existing || existing.messageId !== link.messageId
        || (existing.nativeEntryId && existing.nativeEntryId !== link.nativeEntryId)) {
        throw failure("PROTOCOL_MISMATCH", "已确认的消息关联不能改变。");
      }
    }
  }
  private indexRunMessage(message: MessageView): void {
    if (!message.runId) return;
    const ids = this.#messagesByRun.get(message.runId) ?? new Set<string>();
    ids.add(message.id); this.#messagesByRun.set(message.runId, ids);
  }
  private grow(growth: ProjectionSize): void { this.#size.bytes += growth.bytes; this.#size.nodes += growth.nodes; }
  private ensureCapacity(growth: ProjectionSize, terminal = false): void {
    if (this.#size.bytes + growth.bytes > AGENT_MAX_MESSAGE_BYTES - (terminal ? 1_024 : 64_000)
      || this.#size.nodes + growth.nodes > (terminal ? 99_000 : 95_000)) {
      throw failure("CAPACITY_EXCEEDED", "会话超过当前快照容量，请创建新会话。");
    }
  }

  /** Clone/validate/measure only affected values. No I/O or callbacks during commit. */
  private prepare(input: ProjectionPatch, terminal = false): PreparedProjectionChange {
    const patch = structuredClone(input), growth = { bytes: 0, nodes: 0 };
    const account = (next: unknown, before?: ProjectionSize, overhead = 0) => {
      const size = measure(next);
      growth.bytes += size.bytes - (before?.bytes ?? 0) + overhead;
      growth.nodes += size.nodes - (before?.nodes ?? 0);
      return size;
    };
    const messages = (patch.messages ?? []).map(value => {
      this.validateMessage(value);
      const old = this.#messages.get(value.id);
      if (old && (old.value.runId !== value.runId || old.value.role !== value.role)) throw failure("PROTOCOL_MISMATCH", "消息身份不能改变。");
      return { value, position: old?.position ?? -1, chars: chars(value), ...account(value, old, old ? 0 : 1) };
    });
    const runs = (patch.runs ?? []).map(value => {
      this.assertSession(value.sessionId);
      const old = this.#runs.get(value.id);
      if (old && old.value.userMessageId !== value.userMessageId) throw failure("PROTOCOL_MISMATCH", "任务的用户消息不能改变。");
      return { value, position: old?.position ?? -1, ...account(value, old, old ? 0 : 1) };
    });
    const tools = (patch.tools ?? []).map(value => {
      const position = this.#snapshot.tools.findIndex(tool => tool.toolCallId === value.toolCallId);
      account(value, position < 0 ? undefined : measure(this.#snapshot.tools[position]), position < 0 ? 1 : 0);
      return { value, position };
    });
    if (patch.session) { this.assertSession(patch.session.sessionId); account(patch.session, measure(this.#snapshot.session)); }
    if (patch.usage) account(patch.usage, this.#snapshot.usage && measure(this.#snapshot.usage), this.#snapshot.usage ? 0 : 9);
    this.ensureCapacity(growth, terminal);
    const revision = this.#revision;
    let committed = false;
    return { commit: () => {
      if (committed || revision !== this.#revision) throw failure("PROTOCOL_MISMATCH", "投影变更已提交或已过期。");
      for (const entry of messages) {
        if (entry.position < 0) entry.position = this.#snapshot.messages.length;
        this.#snapshot.messages[entry.position] = entry.value;
        this.#messages.set(entry.value.id, entry); this.indexRunMessage(entry.value);
      }
      for (const entry of runs) {
        if (entry.position < 0) entry.position = this.#snapshot.runs.length;
        this.#snapshot.runs[entry.position] = entry.value; this.#runs.set(entry.value.id, entry);
      }
      for (const { value, position } of tools) this.#snapshot.tools[position < 0 ? this.#snapshot.tools.length : position] = value;
      for (const link of patch.links ?? []) this.#links.set(linkKey(link.runId, link.role, link.ordinal), link);
      if (patch.session) this.#snapshot.session = patch.session;
      if (patch.usage) this.#snapshot.usage = patch.usage;
      this.grow(growth); this.#revision++; committed = true;
    } };
  }
}
