import { randomUUID } from "node:crypto";
import type { ModelCallView } from "../../../../../../shared/agent";
import { ResponseModelCollector } from "./response-model-collector";
import { UsageCollector, type ModelCallMessage } from "./usage-collector";
import { ServerStepsCollector } from "./server-steps-collector";

export type ModelCallEndState = { cancelled?: boolean; interrupted?: boolean };

/** Records one model call. Owns collection and finalization, but no Pi hooks or callbacks. */
export class ModelCallRecorder {
  private readonly startRecord: ModelCallView;
  private readonly responseModelCollector = new ResponseModelCollector();
  private readonly usageCollector: UsageCollector;
  private readonly serverStepsCollector = new ServerStepsCollector();
  private settled = false;

  constructor(context: { runId: string; provider: string; model: string; thinkingLevel?: string }) {
    const startedAt = Date.now();
    this.startRecord = {
      ...context, id: randomUUID(), thinkingLevel: context.thinkingLevel ?? "off",
      startedAt: new Date(startedAt).toISOString(), status: "running",
    };
    this.usageCollector = new UsageCollector(startedAt);
  }

  getStartRecord(): ModelCallView {
    return { ...this.startRecord };
  }

  collect(providerApi: string, providerEvent: unknown): void {
    if (this.settled) return;
    this.responseModelCollector.collect(providerApi, providerEvent);
    this.usageCollector.collect(providerEvent);
    this.serverStepsCollector.collect(providerEvent);
  }

  /** Returns a final record once; subsequent finalization and late events are ignored. */
  finalize(message: ModelCallMessage | undefined, state: ModelCallEndState): ModelCallView | undefined {
    if (this.settled) return;
    this.settled = true;
    const call: ModelCallView = { ...this.startRecord, ...this.usageCollector.finalize(message, state) };
    const responseModelId = this.responseModelCollector.result();
    if (responseModelId) call.responseModelId = responseModelId;

    // Provider counts, including explicit zero, take precedence over completed tool events.
    for (const [field, source, type] of [["webSearch", "webSearchSource", "web_search"], ["webExtractor", "webExtractorSource", "web_extractor"]] as const) {
      const count = this.serverStepsCollector.count(type);
      if (call[field] === undefined && count !== undefined) {
        call[field] = count;
        call[source] = "events";
      }
    }
    const steps = this.serverStepsCollector.steps;
    if (steps.length) call.steps = steps;
    if (this.serverStepsCollector.truncated) call.stepsTruncated = true;
    return call;
  }
}
