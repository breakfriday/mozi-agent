import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelCallView, TokenUsage } from "../../../../../shared/agent";
import { responseModelFromEvent } from "./response-model";
import { ServerSteps } from "./server-steps";

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

/** One record per SDK generation, including retry attempts; no prompt, key or reasoning text. */
export function observeUsage(agent: AgentSession["agent"], runId: string, publish: (call: ModelCallView) => void) {
  const original = agent.streamFunction;
  const pending = new Map<string, ModelCallView>();
  let observerError: unknown;
  const send = (call: ModelCallView) => {
    try { publish(structuredClone(call)); } catch (error) { observerError ??= error; }
  };
  const wrapped: typeof original = async (model, context, options) => {
    const start = Date.now();
    const call: ModelCallView = { id: randomUUID(), runId, provider: model.provider, model: model.id,
      thinkingLevel: options?.reasoning ?? "off", startedAt: new Date(start).toISOString(), status: "running" };
    pending.set(call.id, call); send(call);
    let reported = false, reasoningReported = false, modelConflict = false, settled = false;
    const serverSteps = new ServerSteps();
    const finish = (message?: { usage?: unknown; stopReason?: string }) => {
      if (settled) return;
      settled = true;
      call.status = message?.stopReason === "aborted" || options?.signal?.aborted ? "cancelled"
        : !message || message.stopReason === "error" ? "failed" : "completed";
      call.durationMs = Math.max(0, Date.now() - start);
      const usage = normalizeUsage(message?.usage, reported, reasoningReported);
      if (usage) call.usage = usage;
      if (modelConflict) delete call.responseModelId;
      for (const [field, source, type] of [["webSearch", "webSearchSource", "web_search"], ["webExtractor", "webExtractorSource", "web_extractor"]] as const) {
        if (call[field] === undefined && serverSteps.count(type) !== undefined) {
          call[field] = serverSteps.count(type); call[source] = "events";
        }
      }
      if (serverSteps.steps.length) call.steps = serverSteps.steps;
      if (serverSteps.truncated) call.stepsTruncated = true;
      pending.delete(call.id); send(call);
    };
    try {
      const stream = await original.call(agent, model, context, { ...options,
        onProviderStreamEvent: async (data, responseModel) => {
          const event = record(data);
          if (!settled && event) {
            serverSteps.observe(event);
            const response = record(event.response);
            const rawUsage = record(response?.usage) ?? record(event.usage) ?? record(record(event.message)?.usage) ?? record(event.usageMetadata);
            if (rawUsage) {
              reported = true;
              const detail = record(rawUsage.output_tokens_details) ?? record(rawUsage.completion_tokens_details);
              reasoningReported ||= count(detail?.reasoning_tokens) || count(rawUsage.thoughtsTokenCount);
              const tools = record(rawUsage.x_tools);
              const search = record(tools?.web_search)?.count, extractor = record(tools?.web_extractor)?.count;
              if (count(search)) { call.webSearch = search; call.webSearchSource = "provider"; }
              if (count(extractor)) { call.webExtractor = extractor; call.webExtractorSource = "provider"; }
            }
            const actual = responseModelFromEvent(responseModel.api, data);
            if (actual) {
              if (call.responseModelId && call.responseModelId !== actual) modelConflict = true;
              call.responseModelId = actual;
            }
          }
          await options?.onProviderStreamEvent?.(data, responseModel);
        },
      });
      void stream.result().then(finish, () => finish());
      return stream;
    } catch (error) { finish(); throw error; }
  };
  agent.streamFunction = wrapped;
  return {
    get error() { return observerError; },
    dispose() {
      if (agent.streamFunction === wrapped) agent.streamFunction = original;
      for (const call of pending.values()) send({ ...call, status: "interrupted",
        durationMs: Math.max(0, Date.now() - Date.parse(call.startedAt)) });
      pending.clear();
    },
  };
}
