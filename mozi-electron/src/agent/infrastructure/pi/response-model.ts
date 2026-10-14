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

/** Evidence for one model call; never falls back to the requested model. */
export class ResponseModelCollector {
  private reported?: string;
  private conflict = false;

  collect(api: string, data: unknown): void {
    const value = responseModelFromEvent(api, data);
    if (!value) return;
    if (this.reported && this.reported !== value) this.conflict = true;
    this.reported = value;
  }

  result(): string | undefined {
    return this.conflict ? undefined : this.reported;
  }
}
