import type { ModelCallView, TokenUsage } from "../../../../../shared/agent";

export const USAGE_ENTRY = "mozi.model-call-usage";
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Zero-initialized SDK usage is not evidence that an unsuccessful request was free. */
export function normalizeUsage(value: unknown, usageReported = false, reasoningReported = false): TokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => isNonNegativeSafeInteger(usage[key]))) return;
  if (!usageReported && usage.totalTokens === 0) return;
  const result: TokenUsage = { input: usage.input as number, output: usage.output as number,
    cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number, totalTokens: usage.totalTokens as number };
  if (isNonNegativeSafeInteger(usage.reasoning) && (reasoningReported || usage.reasoning > 0)) result.reasoning = usage.reasoning;
  return result;
}

export type ModelCallMessage = { usage?: unknown; stopReason?: string };
type CallUsage = Pick<ModelCallView, "usage" | "status" | "durationMs" | "webSearch" | "webSearchSource" | "webExtractor" | "webExtractorSource">;

/** Collects per-call usage evidence, then finalizes statistics. Owns no Pi hooks or event delivery. */
export class UsageCollector {
  private usageReported = false;
  private reasoningReported = false;
  private webSearchCount?: number;
  private webExtractorCount?: number;

  constructor(private readonly startedAt: number) {}

  collect(providerEvent: unknown): void {
    const event = asRecord(providerEvent);
    if (!event) return;
    const response = asRecord(event.response);
    const usage = asRecord(response?.usage) ?? asRecord(event.usage) ?? asRecord(asRecord(event.message)?.usage) ?? asRecord(event.usageMetadata);
    if (!usage) return;
    this.usageReported = true;
    const detail = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
    this.reasoningReported ||= isNonNegativeSafeInteger(detail?.reasoning_tokens) || isNonNegativeSafeInteger(usage.thoughtsTokenCount);
    const tools = asRecord(usage.x_tools);
    const searchCount = asRecord(tools?.web_search)?.count, extractorCount = asRecord(tools?.web_extractor)?.count;
    if (isNonNegativeSafeInteger(searchCount)) this.webSearchCount = searchCount;
    if (isNonNegativeSafeInteger(extractorCount)) this.webExtractorCount = extractorCount;
  }

  finalize(message: ModelCallMessage | undefined, state: { cancelled?: boolean; interrupted?: boolean }): CallUsage {
    const result: CallUsage = {
      status: state.interrupted ? "interrupted"
        : message?.stopReason === "aborted" || state.cancelled ? "cancelled"
          : !message || message.stopReason === "error" ? "failed" : "completed",
      durationMs: Math.max(0, Date.now() - this.startedAt),
    };
    const usage = normalizeUsage(message?.usage, this.usageReported, this.reasoningReported);
    if (usage) result.usage = usage;
    if (this.webSearchCount !== undefined) { result.webSearch = this.webSearchCount; result.webSearchSource = "provider"; }
    if (this.webExtractorCount !== undefined) { result.webExtractor = this.webExtractorCount; result.webExtractorSource = "provider"; }
    return result;
  }
}
