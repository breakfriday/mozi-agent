import type { ModelCallView, TokenUsage } from "../../../../../shared/agent";

export const USAGE_ENTRY = "mozi.model-call-usage";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Zero-initialized SDK usage is not evidence that an unsuccessful request was free. */
export function normalizeUsage(value: unknown, reported = false, reasoningReported = false): TokenUsage | undefined {
  const usage = record(value);
  if (!usage || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => count(usage[key]))) return;
  if (!reported && usage.totalTokens === 0) return;
  const result: TokenUsage = { input: usage.input as number, output: usage.output as number,
    cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, totalTokens: usage.totalTokens as number };
  if (count(usage.reasoning) && (reasoningReported || usage.reasoning > 0)) result.reasoning = usage.reasoning;
  return result;
}

export type ModelCallMessage = { usage?: unknown; stopReason?: string };
type CallUsage = Pick<ModelCallView, "usage" | "status" | "durationMs" | "webSearch" | "webSearchSource" | "webExtractor" | "webExtractorSource">;

/** Per-call usage evidence and timing. No Pi hooks, persistence or event delivery. */
export class UsageTracker {
  private reported = false;
  private reasoningReported = false;
  private webSearch?: number;
  private webExtractor?: number;

  constructor(private readonly startedAt: number) {}

  observe(data: unknown): void {
    const event = record(data);
    if (!event) return;
    const response = record(event.response);
    const usage = record(response?.usage) ?? record(event.usage) ?? record(record(event.message)?.usage) ?? record(event.usageMetadata);
    if (!usage) return;
    this.reported = true;
    const detail = record(usage.output_tokens_details) ?? record(usage.completion_tokens_details);
    this.reasoningReported ||= count(detail?.reasoning_tokens) || count(usage.thoughtsTokenCount);
    const tools = record(usage.x_tools);
    const search = record(tools?.web_search)?.count, extractor = record(tools?.web_extractor)?.count;
    if (count(search)) this.webSearch = search;
    if (count(extractor)) this.webExtractor = extractor;
  }

  finish(message: ModelCallMessage | undefined, state: { cancelled?: boolean; interrupted?: boolean }): CallUsage {
    const result: CallUsage = {
      status: state.interrupted ? "interrupted"
        : message?.stopReason === "aborted" || state.cancelled ? "cancelled"
          : !message || message.stopReason === "error" ? "failed" : "completed",
      durationMs: Math.max(0, Date.now() - this.startedAt),
    };
    const usage = normalizeUsage(message?.usage, this.reported, this.reasoningReported);
    if (usage) result.usage = usage;
    if (this.webSearch !== undefined) { result.webSearch = this.webSearch; result.webSearchSource = "provider"; }
    if (this.webExtractor !== undefined) { result.webExtractor = this.webExtractor; result.webExtractorSource = "provider"; }
    return result;
  }
}
