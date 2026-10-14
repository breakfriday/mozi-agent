import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelCallView } from "../../../../../shared/agent";
import { ResponseModelTracker } from "./response-model";
import { UsageTracker, type ModelCallMessage } from "./usage-monitor";
import { ServerSteps } from "./server-steps";

/** The only owner of Pi's streamFunction hook. Each invocation has isolated trackers. */
export function observeModelCalls(agent: AgentSession["agent"], options: {
  runId: string;
  onCallUpdated: (call: ModelCallView) => void;
}) {
  const original = agent.streamFunction;
  const evidence = new WeakMap<object, string>();
  const pending = new Map<string, () => void>();
  let observerError: unknown;
  let disposed = false;
  const publish = (call: ModelCallView) => {
    try { options.onCallUpdated(structuredClone(call)); }
    catch (error) { observerError ??= error; }
  };

  const wrapped: typeof original = async (model, context, streamOptions) => {
    if (disposed) return original.call(agent, model, context, streamOptions);
    const start = Date.now();
    const call: ModelCallView = {
      id: randomUUID(), runId: options.runId, provider: model.provider, model: model.id,
      thinkingLevel: streamOptions?.reasoning ?? "off", startedAt: new Date(start).toISOString(), status: "running",
    };
    const responseModel = new ResponseModelTracker();
    const usage = new UsageTracker(start);
    const serverSteps = new ServerSteps();
    let settled = false;

    // Completion, failure and disposal all pass here; late results cannot settle twice.
    const settleCall = (message?: ModelCallMessage, interrupted = false) => {
      if (settled) return;
      settled = true;
      pending.delete(call.id);
      Object.assign(call, usage.finish(message, { cancelled: streamOptions?.signal?.aborted, interrupted }));
      const responseModelId = responseModel.result();
      if (responseModelId) {
        call.responseModelId = responseModelId;
        if (message) evidence.set(message, responseModelId);
      }
      for (const [field, source, type] of [["webSearch", "webSearchSource", "web_search"], ["webExtractor", "webExtractorSource", "web_extractor"]] as const) {
        const count = serverSteps.count(type);
        if (call[field] === undefined && count !== undefined) {
          call[field] = count;
          call[source] = "events";
        }
      }
      if (serverSteps.steps.length) call.steps = serverSteps.steps;
      if (serverSteps.truncated) call.stepsTruncated = true;
      publish(call);
    };
    pending.set(call.id, () => settleCall(undefined, true));
    publish(call);

    try {
      const stream = await original.call(agent, model, context, {
        ...streamOptions,
        // Pi calls this with parsed provider events BEFORE normalizing them.
        // Observe only; preserve the original SDK callback and its await semantics.
        onProviderStreamEvent: async (data, providerModel) => {
          if (!settled) {
            responseModel.observe(providerModel.api, data);
            usage.observe(data);
            serverSteps.observe(data);
          }
          await streamOptions?.onProviderStreamEvent?.(data, providerModel);
        },
      });
      // Register before agent-core awaits result(): model evidence must exist at message_end.
      // Do not iterate the stream; Pi remains its consumer.
      void stream.result().then(message => settleCall(message), () => settleCall())
        .catch(error => { observerError ??= error; });
      return stream;
    } catch (error) {
      settleCall();
      throw error;
    }
  };

  agent.streamFunction = wrapped;
  return {
    getResponseModel: (message: object) => evidence.get(message),
    get error() { return observerError; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (agent.streamFunction === wrapped) agent.streamFunction = original;
      for (const interrupt of pending.values()) interrupt();
    },
  };
}
