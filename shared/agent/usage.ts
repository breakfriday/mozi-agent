/** Pi counts: input excludes cache; output includes reasoning. */
export type TokenUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  reasoning?: number;
};
/** Provider output items, not internal model invocations or per-step token accounting. */
export type ServerStepView = {
  id: string;
  type: "reasoning" | "message" | "web_search" | "web_extractor";
  status: "running" | "completed" | "failed" | "incomplete" | "unknown";
  observed: "stream" | "final";
  queries?: string[];
  sources?: string[];
  urls?: string[];
};
export type ModelCallView = {
  id: string;
  runId?: string;
  provider: string;
  model: string;
  responseModelId?: string;
  thinkingLevel?: string;
  startedAt: string;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  usage?: TokenUsage;
  webSearch?: number;
  webExtractor?: number;
  webSearchSource?: "provider" | "events";
  webExtractorSource?: "provider" | "events";
  steps?: ServerStepView[];
  stepsTruncated?: boolean;
  nativeEntryId?: string;
};
export type UsageTotals = TokenUsage & {
  calls: number; reportedCalls: number; pendingCalls: number; unknownCalls: number; reasoningCalls: number;
  webSearch?: number; webExtractor?: number;
};
export type UsageMonitorView = {
  calls: ModelCallView[];
  total: UsageTotals;
  runs: { runId: string; total: UsageTotals }[];
};
export function summarizeUsage(calls: readonly ModelCallView[]): UsageTotals {
  const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    calls: calls.length, reportedCalls: 0, pendingCalls: 0, unknownCalls: 0, reasoningCalls: 0 };
  for (const call of calls) {
    if (call.status === "running") total.pendingCalls++;
    if (call.usage) {
      total.reportedCalls++;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += call.usage[key];
      if (call.usage.reasoning !== undefined) {
        total.reasoning = (total.reasoning ?? 0) + call.usage.reasoning;
        total.reasoningCalls++;
      }
    } else if (call.status !== "running") total.unknownCalls++;
    if (call.webSearch !== undefined) total.webSearch = (total.webSearch ?? 0) + call.webSearch;
    if (call.webExtractor !== undefined) total.webExtractor = (total.webExtractor ?? 0) + call.webExtractor;
  }
  return total;
}
/** Replace by call ID before summing: replays and final revisions never double count. */
export function buildUsageMonitor(records: readonly ModelCallView[]): UsageMonitorView {
  const calls = [...new Map(records.map(call => [call.id, call])).values()];
  const byRun = new Map<string, ModelCallView[]>();
  for (const call of calls) if (call.runId) {
    const group = byRun.get(call.runId) ?? [];
    group.push(call); byRun.set(call.runId, group);
  }
  return { calls, total: summarizeUsage(calls),
    runs: [...byRun].map(([runId, group]) => ({ runId, total: summarizeUsage(group) })) };
}
