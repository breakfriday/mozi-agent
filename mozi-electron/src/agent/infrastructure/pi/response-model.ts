import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const RESPONSE_MODEL_ENTRY = "mozi.provider-response-model";

export function validResponseModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value) && !value.includes(String.fromCharCode(0));
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Read only documented response fields. Never inspect the requested model or generated text. */
export function responseModelFromEvent(api: string, data: unknown): string | undefined {
  const event = record(data);
  if (!event) return;
  let value: unknown;
  if (api === "openai-completions") value = event.model;
  else if (["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)) value = record(event.response)?.model;
  else if (api === "anthropic-messages" && event.type === "message_start") value = record(event.message)?.model;
  else if (api === "google-generative-ai" || api === "google-vertex") value = event.modelVersion;
  return validResponseModel(value) ? value : undefined;
}

/** Separate evidence per SDK request, including retries and background requests. */
export function observeResponseModels(agent: AgentSession["agent"]) {
  const original = agent.streamFunction;
  const evidence = new WeakMap<object, string>();
  const wrapped: typeof original = async (model, context, options) => {
    let reported: string | undefined;
    let conflict = false;
    let settled = false;
    const stream = await original.call(agent, model, context, { ...options,
      onProviderStreamEvent: async (data, responseModel) => {
        if (!settled) {
          const value = responseModelFromEvent(responseModel.api, data);
          if (value) {
            if (reported && reported !== value) conflict = true;
            reported = value;
          }
        }
        await options?.onProviderStreamEvent?.(data, responseModel);
      },
    });
    // Register before agent-core awaits result(), so evidence is ready at message_end.
    void stream.result().then(message => {
      settled = true;
      if (reported && !conflict) evidence.set(message, reported);
    }).catch(() => { settled = true; });
    return stream;
  };
  agent.streamFunction = wrapped;
  return { get: (message: object) => evidence.get(message),
    dispose() { if (agent.streamFunction === wrapped) agent.streamFunction = original; } };
}
