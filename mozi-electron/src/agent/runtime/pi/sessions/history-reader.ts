import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimeHistoryMessage, RuntimeTool } from "../../agent-runtime";
import type { ModelCallView } from "../../../../../../shared/agent";
import { displayParts } from "./content-mapper";
import { normalizeUsage } from "../model-call/usage-collector";
import { parseRunEntry, parseUsageEntry, parseResponseModelEntry } from "./session-entries";
import { toolCalls, toolOutput } from "./tool-execution-collector";

/** Converts the selected native branch into displayable history without I/O or mutation. */
export function readHistory(branch: readonly SessionEntry[]): RuntimeHistoryMessage[] {
  const messages: RuntimeHistoryMessage[] = [];
  const calls = new Map<string, RuntimeTool>();
  let runId: string | undefined;
  let ordinal = 0, seenUser = false;
  const responseModels = new Map<string, string>();
  for (const entry of branch) {
    const data = parseResponseModelEntry(entry);
    if (data) responseModels.set(data.nativeEntryId, data.responseModelId);
  }
  for (const entry of branch) {
    const run = parseRunEntry(entry);
    if (run) {
      calls.clear();
      runId = run.runId;
      ordinal = 0; seenUser = false;
    } else if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
      // Native/imported messages need no Mozi marker. An external continuation
      // must not inherit the previous Mozi Run's IDs or ordinal mappings.
      if (entry.message.role === "user") {
        calls.clear();
        if (seenUser) { runId = undefined; ordinal = 0; }
        seenUser = true;
      }
      const stop = entry.message.role === "assistant" ? entry.message.stopReason : undefined;
      const tools = entry.message.role === "assistant" ? toolCalls(entry.message.content) : [];
      for (const tool of tools) {
        tool.status = stop === "aborted" ? "cancelled" : "interrupted";
        calls.set(tool.toolCallId, tool);
      }
      messages.push({ ...(runId ? { runId } : {}), role: entry.message.role,
        ...(tools.length ? { tools } : {}),
        ordinal: entry.message.role === "assistant" ? ordinal++ : 0,
        nativeEntryId: entry.id, createdAt: entry.timestamp,
        status: stop === "error" ? "failed" : stop === "aborted" ? "cancelled" : "completed",
        ...(entry.message.role === "assistant" && responseModels.has(entry.id) ? { responseModelId: responseModels.get(entry.id) } : {}),
        parts: displayParts(entry.message.content, entry.message.role === "assistant") });
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      const tool = calls.get(entry.message.toolCallId);
      if (tool) Object.assign(tool, toolOutput(entry.message), { status: entry.message.isError ? "failed" : "succeeded" });
    }
  }
  return messages;
}

/** Restores usage from all native entries, including calls outside the current branch. */
export function readUsage(entries: readonly SessionEntry[]): ModelCallView[] {
  const calls = new Map<string, ModelCallView>();
  const monitoredRuns = new Set<string>();
  const responseModels = new Map<string, string>();
  for (const entry of entries) {
    const data = parseResponseModelEntry(entry);
    if (data) responseModels.set(data.nativeEntryId, data.responseModelId);
    const call = parseUsageEntry(entry);
    if (!call) continue;
    calls.set(call.id, call.status === "running" ? { ...call, status: "interrupted" } : call);
    if (call.runId) monitoredRuns.add(call.runId);
  }
  let runId: string | undefined, thinkingLevel: string | undefined;
  let seenUser = false;
  for (const entry of entries) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    const run = parseRunEntry(entry);
    if (run) {
      runId = run.runId; seenUser = false;
    }
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      if (seenUser) runId = undefined;
      seenUser = true;
    }
    if (entry.message.role !== "assistant" || (runId && monitoredRuns.has(runId))) continue;
    const message = entry.message;
    const usage = normalizeUsage(message.usage);
    const call: ModelCallView = { id: `native:${entry.id}`, nativeEntryId: entry.id,
      ...(runId ? { runId } : {}), provider: message.provider, model: message.model,
      ...(responseModels.has(entry.id) ? { responseModelId: responseModels.get(entry.id) } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}), startedAt: entry.timestamp,
      status: message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed",
      ...(usage ? { usage } : {}) };
    calls.set(call.id, call);
  }
  return [...calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
