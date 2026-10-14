import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelCallView } from "../../../../../shared/agent";
import { ModelCallRecorder, type ModelCallEndState } from "./model-call-recorder";
import type { ModelCallMessage } from "./usage-monitor";

/** The only owner of Pi's streamFunction hook. Each invocation has isolated collection state. */
export function observeModelCalls(agent: AgentSession["agent"], options: {
  runId: string;
  onCallUpdated: (call: ModelCallView) => void;
}) {
  const baseStreamFn = agent.streamFunction;
  const evidence = new WeakMap<object, string>();
  const pending = new Set<ModelCallRecorder>();
  let observerError: unknown;
  let disposed = false;
  const publish = (call: ModelCallView) => {
    try { options.onCallUpdated(structuredClone(call)); }
    catch (error) { observerError ??= error; }
  };
  const finalizeAndPublish = (recorder: ModelCallRecorder, message: ModelCallMessage | undefined, state: ModelCallEndState) => {
    const call = recorder.finalize(message, state);
    if (!call) return;
    pending.delete(recorder);
    if (message && call.responseModelId) evidence.set(message, call.responseModelId);
    publish(call);
  };

  const observedStreamFn: typeof baseStreamFn = async (model, context, streamOptions) => {
    if (disposed) return baseStreamFn.call(agent, model, context, streamOptions);
    const recorder = new ModelCallRecorder({
      runId: options.runId, provider: model.provider, model: model.id,
      thinkingLevel: streamOptions?.reasoning,
    });
    pending.add(recorder);
    publish(recorder.getStartRecord());

    try {
      const stream = await baseStreamFn.call(agent, model, context, {
        ...streamOptions,
        // Pi calls this with parsed provider events BEFORE normalizing them.
        // Observe only; preserve the original SDK callback and its await semantics.
        onProviderStreamEvent: async (data, providerModel) => {
          recorder.collect(providerModel.api, data);
          await streamOptions?.onProviderStreamEvent?.(data, providerModel);
        },
      });
      // Register before agent-core awaits result(): model evidence must exist at message_end.
      // Do not iterate the stream; Pi remains its consumer.
      void stream.result().then(
        message => finalizeAndPublish(recorder, message, { cancelled: streamOptions?.signal?.aborted }),
        () => finalizeAndPublish(recorder, undefined, { cancelled: streamOptions?.signal?.aborted }),
      )
        .catch(error => { observerError ??= error; });
      return stream;
    } catch (error) {
      finalizeAndPublish(recorder, undefined, { cancelled: streamOptions?.signal?.aborted });
      throw error;
    }
  };

  agent.streamFunction = observedStreamFn;
  return {
    getResponseModel: (message: object) => evidence.get(message),
    get error() { return observerError; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (agent.streamFunction === observedStreamFn) agent.streamFunction = baseStreamFn;
      for (const recorder of pending) finalizeAndPublish(recorder, undefined, { interrupted: true });
    },
  };
}
