/** Local diagnostics only. These records never enter the Agent business protocol. */
export type AgentLogScope = "renderer" | "preload" | "main" | "transport" | "agent-service";
export type AgentLogLevel = "debug" | "info" | "warn" | "error";
export interface AgentLogConfig {
  enabled: boolean;
  level: AgentLogLevel;
  deltas: boolean;
  payloads: boolean;
  maxPayloadChars: number;
  scopes: readonly AgentLogScope[];
}

// One source switch for all bundles. Restart/rebuild the app after editing.
export const AGENT_LOG_DEFAULTS: AgentLogConfig = {
  enabled: true,
  level: "debug",
  deltas: false,
  payloads: true,
  maxPayloadChars: 32_000,
  scopes: ["renderer", "preload", "main", "transport", "agent-service"],
};

export type AgentLogFields = Partial<Record<
  "requestId" | "sessionId" | "runId" | "clientMessageId" | "clientOperationId"
  | "messageId" | "partId" | "toolCallId" | "approvalId" | "subscriptionId"
  | "method" | "eventType" | "kind" | "status" | "state" | "code" | "disposition"
  | "stage" | "listenerType",
  string
>> & Partial<Record<
  "protocolVersion" | "seq" | "lastSeq" | "windowId" | "generation" | "durationMs"
  | "listeners" | "subscriptions" | "pendingRequests",
  number
>> & { ok?: boolean; removed?: boolean };

export type AgentLogRecord = Readonly<AgentLogFields & {
  timestamp: string;
  scope: AgentLogScope;
  level: AgentLogLevel;
  action: string;
  payload?: string;
  payloadTruncated?: boolean;
}>;
export type AgentLogSink = (record: AgentLogRecord) => void;

const priorities: Record<AgentLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const consoleSink: AgentLogSink = (record) => console[record.level]("[mozi.agent]", record);
let config: AgentLogConfig = { ...AGENT_LOG_DEFAULTS, scopes: [...AGENT_LOG_DEFAULTS.scopes] };
let sink: AgentLogSink = consoleSink;

/** Affects existing loggers in this JS context; other processes have their own instance. */
export function configureAgentLogging(options: Partial<AgentLogConfig>, nextSink?: AgentLogSink): void {
  config = { ...config, ...options, scopes: [...(options.scopes ?? config.scopes)] };
  if (nextSink) sink = nextSink;
}

export function resetAgentLogging(): void {
  config = { ...AGENT_LOG_DEFAULTS, scopes: [...AGENT_LOG_DEFAULTS.scopes] };
  sink = consoleSink;
}

const strings: readonly (keyof AgentLogFields)[] = [
  "requestId", "sessionId", "runId", "clientMessageId", "clientOperationId", "messageId",
  "partId", "toolCallId", "approvalId", "subscriptionId", "method", "eventType", "kind",
  "status", "state", "code", "disposition", "stage", "listenerType",
];
const numbers: readonly (keyof AgentLogFields)[] = [
  "protocolVersion", "seq", "lastSeq", "windowId", "generation", "durationMs",
  "listeners", "subscriptions", "pendingRequests",
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Read own data properties only. Logging malformed input must not invoke getters.
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function summarize(value: unknown, output: Record<string, string | number | boolean>, depth = 0): void {
  if (!record(value) || depth > 3) return;
  for (const key of strings) {
    const item = field(value, key);
    if (typeof item === "string") output[key] = item.replace(/[\r\n\t]/g, " ").slice(0, 256);
  }
  for (const key of numbers) {
    const item = field(value, key);
    if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
  }
  for (const key of ["ok", "removed"]) {
    const item = field(value, key);
    if (typeof item === "boolean") output[key] = item;
  }
  const type = field(value, "type");
  if (typeof type === "string") output.eventType = type.slice(0, 128);
  // Deliberately never traverse content, text, delta, inputText, outputText,
  // description, reason, error.message, credentials, URLs, or whole snapshots.
  for (const key of ["params", "result", "data", "error", "session", "message", "run", "tool", "approval"]) {
    const item = field(value, key);
    summarize(item, output, depth + 1);
    const identity = record(item) ? field(item, "id") : undefined;
    if (typeof identity === "string" && ["message", "run", "approval"].includes(key)) {
      output[`${key}Id`] = identity.replace(/[\r\n\t]/g, " ").slice(0, 256);
    }
  }
}

function capturePayload(sources: unknown[]): { payload: string; payloadTruncated: boolean } {
  const limit = Math.max(256, Math.min(1_000_000, config.maxPayloadChars));
  let budget = limit;
  let truncated = false;
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 16) { truncated = true; return "[truncated]"; }
    if (typeof value === "string") {
      const text = value.slice(0, Math.max(0, budget));
      budget -= text.length;
      if (text.length !== value.length) truncated = true;
      return text;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return `[${typeof value}]`;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (budget <= 0) { truncated = true; break; }
      budget -= key.length;
      result[key] = /^(apiKey|authorization|credentials|password|secret|accessToken|refreshToken)$/i.test(key)
        ? "[redacted]" : "value" in descriptor ? copy(descriptor.value, depth + 1) : "[accessor omitted]";
    }
    seen.delete(value);
    return Array.isArray(value) ? Object.values(result) : result;
  }
  const json = JSON.stringify(copy(sources, 0));
  return { payload: json.slice(0, limit), payloadTruncated: truncated || json.length > limit };
}

export interface AgentLogger {
  debug(action: string, ...sources: unknown[]): void;
  info(action: string, ...sources: unknown[]): void;
  warn(action: string, ...sources: unknown[]): void;
  error(action: string, ...sources: unknown[]): void;
}

export function createAgentLogger(scope: AgentLogScope): AgentLogger {
  function write(level: AgentLogLevel, action: string, sources: unknown[]): void {
    if (!config.enabled || priorities[level] < priorities[config.level] || !config.scopes.includes(scope)) return;
    try {
      const fields: Record<string, string | number | boolean> = {};
      for (const source of sources) summarize(source, fields);
      // Successful token deltas are noisy. Validation failures are always visible.
      if (!config.deltas && level === "debug" && typeof fields.eventType === "string"
        && fields.eventType.endsWith(".delta")) return;
      const payload = config.payloads ? capturePayload(sources) : {};
      sink(Object.freeze({ ...fields, ...payload, timestamp: new Date().toISOString(), scope, level, action }));
    } catch {
      // A diagnostic sink or hostile payload must never change request/event behavior.
    }
  }
  return {
    debug: (action, ...sources) => write("debug", action, sources),
    info: (action, ...sources) => write("info", action, sources),
    warn: (action, ...sources) => write("warn", action, sources),
    error: (action, ...sources) => write("error", action, sources),
  };
}
