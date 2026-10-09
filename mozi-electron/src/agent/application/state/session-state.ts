import { AGENT_MAX_MESSAGE_BYTES } from "../../../../../shared/agent";
import type { MessageView, RunView } from "../../../../../shared/agent";
import { failure } from "../errors";
import type { MessageLink, SessionRecord } from "../models";

type Size = { bytes: number; nodes: number };
export type MessageEntry = Size & { value: MessageView; position: number; chars: number };
type RunEntry = Size & { value: RunView; position: number };
const chars = (message: MessageView) => message.content.reduce((sum, part) => sum + part.text.length, 0);
export function measure(value: unknown): Size {
  const nodes = (item: unknown): number => 1 + (item && typeof item === "object"
    ? Object.values(item).reduce<number>((sum, child) => sum + nodes(child), 0) : 0);
  return { bytes: Buffer.byteLength(JSON.stringify(value)), nodes: nodes(value) };
}
export const linkKey = (runId: string, role: string, ordinal: number): string => `${runId}:${role}:${ordinal}`;

/** Indexes and wire-size accounting: deltas never visit historical messages. */
export class SessionState {
  readonly messages = new Map<string, MessageEntry>();
  readonly runs = new Map<string, RunEntry>();
  readonly links = new Map<string, MessageLink>();
  readonly messagesByRun = new Map<string, MessageEntry[]>();
  private size: Size;
  constructor(readonly record: SessionRecord) {
    this.size = measure(record.snapshot);
    record.snapshot.messages.forEach((value, position) => this.indexMessage(value, position));
    record.snapshot.runs.forEach((value, position) => this.runs.set(value.id, { value, position, ...measure(value) }));
    record.messageLinks.forEach(link => this.indexLink(link));
  }
  ensureCapacity(growth: Size): void {
    // Reserve room for terminal state/errors and the response envelope/seq digits.
    if (this.size.bytes + growth.bytes > AGENT_MAX_MESSAGE_BYTES - 64_000 || this.size.nodes + growth.nodes > 95_000) {
      throw failure("CAPACITY_EXCEEDED", "会话超过当前快照容量，请创建新会话。");
    }
  }
  private grow(size: Size): void { this.size.bytes += size.bytes; this.size.nodes += size.nodes; }
  checkAppend(message: MessageView, run?: RunView): void {
    const m = measure(message), r = run ? measure(run) : { bytes: 0, nodes: 0 };
    this.ensureCapacity({ bytes: m.bytes + r.bytes + 2, nodes: m.nodes + r.nodes });
  }
  private indexMessage(value: MessageView, position: number): MessageEntry {
    const entry = { value, position, chars: chars(value), ...measure(value) };
    this.messages.set(value.id, entry);
    if (value.runId) {
      const list = this.messagesByRun.get(value.runId) ?? [];
      list.push(entry); this.messagesByRun.set(value.runId, list);
    }
    return entry;
  }
  appendMessage(value: MessageView): MessageEntry {
    const entry = this.indexMessage(value, this.record.snapshot.messages.length);
    this.record.snapshot.messages.push(value); this.grow({ bytes: entry.bytes + 1, nodes: entry.nodes });
    return entry;
  }
  appendRun(value: RunView): void {
    const entry = { value, position: this.record.snapshot.runs.length, ...measure(value) };
    this.runs.set(value.id, entry); this.record.snapshot.runs.push(value);
    this.grow({ bytes: entry.bytes + 1, nodes: entry.nodes });
  }
  private indexLink(link: MessageLink): void {
    this.links.set(linkKey(link.runId, link.role, link.ordinal), link);
  }
  appendLink(link: MessageLink): void { this.record.messageLinks.push(link); this.indexLink(link); }
  refreshRun(id: string): void {
    const entry = this.runs.get(id)!;
    const size = measure(entry.value);
    this.grow({ bytes: size.bytes - entry.bytes, nodes: size.nodes - entry.nodes }); Object.assign(entry, size);
  }
  refreshMessage(entry: MessageEntry): void {
    const size = measure(entry.value);
    this.grow({ bytes: size.bytes - entry.bytes, nodes: size.nodes - entry.nodes });
    Object.assign(entry, size, { chars: chars(entry.value) });
  }
  appendDelta(entry: MessageEntry, partId: string, delta: string, type: MessageView["content"][number]["type"] = "text"): void {
    if (entry.chars + delta.length > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
    let part = entry.value.content.find(part => part.id === partId);
    if (part && part.type !== type) throw failure("PROTOCOL_MISMATCH", "内容块类型发生变化。");
    const added = part ? { bytes: 0, nodes: 0 } : measure({ id: partId, type, text: "" });
    // JSON escaping is measured on the new delta only. Split surrogate pairs may
    // conservatively overcount until completion, but can never undercount capacity.
    const growth = { bytes: added.bytes + (part ? 0 : 1) + Buffer.byteLength(JSON.stringify(delta)) - 2, nodes: added.nodes };
    this.ensureCapacity(growth);
    if (!part) { part = { id: partId, type, text: "" }; entry.value.content.push(part); }
    part.text += delta; entry.chars += delta.length;
    entry.bytes += growth.bytes; entry.nodes += growth.nodes; this.grow(growth);
  }
  reportResponseModel(entry: MessageEntry, responseModelId: string): void {
    const size = measure({ ...entry.value, responseModelId });
    this.ensureCapacity({ bytes: size.bytes - entry.bytes, nodes: size.nodes - entry.nodes });
    entry.value.responseModelId = responseModelId;
    this.refreshMessage(entry);
  }
  completeMessage(entry: MessageEntry, content: MessageView["content"], status: MessageView["status"] = "completed"): void {
    const next = { ...entry.value, content, status };
    if (chars(next) > 256_000) throw failure("CAPACITY_EXCEEDED", "单条回复超过当前展示容量。");
    const size = measure(next);
    this.ensureCapacity({ bytes: size.bytes - entry.bytes, nodes: size.nodes - entry.nodes });
    entry.value.content = content; entry.value.status = status;
    this.refreshMessage(entry);
  }
}
