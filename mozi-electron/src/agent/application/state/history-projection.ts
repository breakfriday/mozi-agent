import { createHash } from "node:crypto";
import type { MessageView } from "../../../../../shared/agent";
import type { RuntimeHistoryMessage } from "../ports/agent-runtime";
import type { MessageLink, SessionMetadata, SessionMetadataDetails, SessionRecord } from "../models";
import { linkKey } from "./session-state";

export const partId = (messageId: string, index: number): string => `${messageId}:text:${index}`;
const nativeId = (metadata: SessionMetadata, entryId: string): string => "native:" + createHash("sha256")
  .update(JSON.stringify([metadata.descriptor.engine, metadata.descriptor.sessionId, entryId])).digest("hex");

/** Build a disposable UI view from the selected native branch plus Mozi overlays. */
export function projectHistory(metadata: SessionMetadata, details: SessionMetadataDetails, history: RuntimeHistoryMessage[]): {
  record: SessionRecord; confirmedLinks: MessageLink[];
} {
  const sessionId = metadata.descriptor.sessionId;
  const runs = new Map(details.runs.map(item => [item.run.id, item]));
  const byOrdinal = new Map(details.links.map(link => [linkKey(link.runId, link.role, link.ordinal), link]));
  const byNative = new Map(details.links.filter(link => link.nativeEntryId).map(link => [link.nativeEntryId!, link]));
  const linksByRun = new Map<string, MessageLink[]>();
  for (const link of details.links) {
    const links = linksByRun.get(link.runId) ?? [];
    links.push(link); linksByRun.set(link.runId, links);
  }
  const confirmedLinks: MessageLink[] = [];
  const present = new Set<string>();
  const visibleRuns = new Set<string>();
  const entries: { message: MessageView; at: string }[] = [];
  for (const native of history) {
    let link = byNative.get(native.nativeEntryId);
    if (!link && native.runId) {
      const candidate = byOrdinal.get(linkKey(native.runId, native.role, native.ordinal));
      // A different branch must not take over an already bound application ID.
      if (candidate && !candidate.nativeEntryId) link = candidate;
    }
    const run = runs.get(link?.runId ?? native.runId ?? "");
    const id = link?.messageId ?? nativeId(metadata, native.nativeEntryId);
    if (link && (link.nativeEntryId !== native.nativeEntryId || (link.role === "user" && run?.pendingContent))) {
      link.nativeEntryId = native.nativeEntryId; confirmedLinks.push(link);
    }
    if (run) visibleRuns.add(run.run.id);
    present.add(id);
    entries.push({ at: native.createdAt, message: {
      id, sessionId, role: native.role, status: native.status,
      ...(native.role === "assistant" && native.responseModelId ? { responseModelId: native.responseModelId } : {}),
      ...(run ? { runId: run.run.id } : {}),
      ...(native.role === "user" && link && run ? { clientMessageId: run.clientMessageId } : {}),
      content: native.parts.map(part => ({ id: partId(id, part.index), type: "text", text: part.text })),
    } });
  }
  for (const item of details.runs) {
    const { run } = item;
    if (item.pendingContent && !present.has(run.userMessageId)) {
      visibleRuns.add(run.id);
      const entry = { at: run.createdAt, message: {
        id: run.userMessageId, sessionId, runId: run.id, clientMessageId: item.clientMessageId,
        role: "user" as const, status: "completed" as const,
        content: item.pendingContent.map((part, index) => ({ ...part, id: partId(run.userMessageId, index) })),
      } };
      // Native branch order stays authoritative; insert only undelivered inputs.
      const index = entries.findIndex(existing => existing.at > run.createdAt);
      entries.splice(index < 0 ? entries.length : index, 0, entry);
      present.add(run.userMessageId);
    }
    if (!visibleRuns.has(run.id)) continue;
    // Preserve an already announced assistant ID after a crash, without inventing
    // lost delta content or keeping a second durable assistant transcript.
    for (const link of (linksByRun.get(run.id) ?? []).filter(link => link.role === "assistant" && !link.nativeEntryId)) {
      if (present.has(link.messageId)) continue;
      let index = entries.length;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].message.runId === run.id) { index = i + 1; break; }
      }
      entries.splice(index, 0, { at: run.updatedAt, message: {
        id: link.messageId, sessionId, runId: run.id, role: "assistant", content: [],
        status: run.status === "failed" || run.status === "cancelled" ? run.status : "interrupted",
      } });
      present.add(link.messageId);
    }
  }
  return { confirmedLinks, record: {
    descriptor: metadata.descriptor, messageLinks: details.links,
    snapshot: { session: metadata.session, lastSeq: 0, messages: entries.map(entry => entry.message),
      runs: details.runs.filter(item => visibleRuns.has(item.run.id)).map(item => item.run), tools: [], approvals: [] },
  } };
}
