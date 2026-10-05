export const AGENT_PROTOCOL_VERSION = 1 as const;

export const AGENT_CHANNELS = {
  request: "mozi:agent:request",
  event: "mozi:agent:event",
  runtime: "mozi:agent:runtime",
} as const;

// Limits apply to serialized payloads, not the number of model tokens.
export const AGENT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const AGENT_REQUEST_TIMEOUT_MS = 15_000;
export const AGENT_MAX_PENDING_REQUESTS = 128;
export const AGENT_MAX_SUBSCRIPTIONS_PER_WINDOW = 64;
