import { AGENT_MAX_MESSAGE_BYTES, AGENT_PROTOCOL_VERSION } from "./channels";
import { APP_ERROR_CODES, RUN_STATUSES, TERMINAL_RUN_STATUSES, MESSAGE_STATUSES, TOOL_STATUSES, TOOL_OUTCOMES, APPROVAL_STATUSES } from "./models";
import type { ApiResult, ParamsOf, ResultOf } from "./api";
import type {
  AppError, ApprovalView, InputPart, MessagePart, MessageView, RunOutcome,
  RunView, SessionSnapshot, SessionSummary, ToolView,
} from "./models";
import type {
  AgentEvent, AgentRequest, EventPayload, Method, ResponseFor, RuntimeControl,
  RuntimeNotice, RuntimeShutdown,
} from "./protocol";

type Guard<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

const string: Guard<string> = (value): value is string => typeof value === "string";
const boolean: Guard<boolean> = (value): value is boolean => typeof value === "boolean";
const id: Guard<string> = (value): value is string =>
  string(value) && value.trim().length > 0 && value.length <= 256;
const sequence: Guard<number> = (value): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date: Guard<string> = (value): value is string =>
  string(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): Guard<T[number]> {
  return (value): value is T[number] => values.some((item) => item === value);
}

function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

function array<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

// The mapped type requires a validator for every field, including optional fields.
// Adding or changing a contract field therefore also checks its validator at build time.
function object<T extends object>(shape: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> {
  const fields = Object.entries(shape) as [string, Guard<unknown>][];
  return (value): value is T => isRecord(value)
    && Object.keys(value).every((key) => Object.prototype.hasOwnProperty.call(shape, key))
    && fields.every(([key, guard]) => guard(Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined));
}

/** Reject non-data objects, cycles, accessors, excessive nesting and oversized messages. */
export function isWirePayload(value: unknown): boolean {
  const seen = new Set<object>();
  let remaining = 100_000;
  function visit(item: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    if (!Array.isArray(item) && !isRecord(item)) return false;
    seen.add(item);
    if (Object.getOwnPropertySymbols(item).length) return false;
    if (Array.isArray(item) && (Object.keys(item).length !== item.length
      || !Object.keys(item).every((key, index) => key === String(index)))) return false;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      // Optional object fields are omitted by JSON serialization.
      if (!Array.isArray(item) && descriptor.value === undefined) continue;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  }
  try {
    return visit(value, 0)
      && new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

export const isAppError = object<AppError>({
  code: oneOf(...APP_ERROR_CODES),
  message: string,
});

const terminalStatus = oneOf(...TERMINAL_RUN_STATUSES);
const inputPart = object<InputPart>({ type: oneOf("text"), text: string });
const messagePart = object<MessagePart>({ id, type: oneOf("text"), text: string });
const runView = object<RunView>({
  id, sessionId: id, userMessageId: id,
  status: oneOf(...RUN_STATUSES),
  createdAt: date, updatedAt: date, error: optional(isAppError), interruptionReason: optional(string),
});
const messageView = object<MessageView>({
  id, sessionId: id, runId: optional(id), role: oneOf("user", "assistant"),
  content: array(messagePart), clientMessageId: optional(id),
  status: oneOf(...MESSAGE_STATUSES),
});
const toolView = object<ToolView>({
  toolCallId: id, runId: id, toolName: id,
  status: oneOf(...TOOL_STATUSES),
  inputText: string, outputText: string, outputTruncated: boolean, summary: optional(string),
});
const approvalView = object<ApprovalView>({
  id, sessionId: id, runId: id, toolCallId: id, title: string, description: string,
  status: oneOf(...APPROVAL_STATUSES),
  createdAt: date, resolvedAt: optional(date),
});
const sessionSummary = object<SessionSummary>({ sessionId: id, title: string, createdAt: date, updatedAt: date });
const snapshot = object<SessionSnapshot>({
  session: sessionSummary, lastSeq: sequence, messages: array(messageView), tools: array(toolView),
  runs: array(runView), approvals: array(approvalView),
});
export const isRuntimeNotice = object<RuntimeNotice>({ state: oneOf("unavailable", "ready"), reason: optional(string) });
export const isRuntimeControl = object<RuntimeControl>({
  protocolVersion: oneOf(AGENT_PROTOCOL_VERSION), kind: oneOf("runtime"),
  state: oneOf("unavailable", "ready"), reason: optional(string),
});
export const isRuntimeShutdown = object<RuntimeShutdown>({
  protocolVersion: oneOf(AGENT_PROTOCOL_VERSION), kind: oneOf("control"), action: oneOf("shutdown"),
});

const outcomeValidators = {
  completed: object<Extract<RunOutcome, { status: "completed" }>>({ status: oneOf("completed") }),
  cancelled: object<Extract<RunOutcome, { status: "cancelled" }>>({ status: oneOf("cancelled") }),
  failed: object<Extract<RunOutcome, { status: "failed" }>>({ status: oneOf("failed"), error: isAppError }),
  interrupted: object<Extract<RunOutcome, { status: "interrupted" }>>({ status: oneOf("interrupted"), reason: string }),
} satisfies { [S in RunOutcome["status"]]: Guard<Extract<RunOutcome, { status: S }>> };
const runOutcome: Guard<RunOutcome> = (value): value is RunOutcome =>
  isRecord(value) && terminalStatus(value.status) && outcomeValidators[value.status](value);

const paramsValidators = {
  "runtime.getState": object<ParamsOf<"runtime.getState">>({}),
  "session.create": object<ParamsOf<"session.create">>({ clientOperationId: id, title: optional(string) }),
  "session.list": object<ParamsOf<"session.list">>({
    cursor: optional(id), limit: optional((value): value is number => sequence(value) && value > 0 && value <= 100),
  }),
  "session.rename": object<ParamsOf<"session.rename">>({ sessionId: id,
    title: (value): value is string => string(value) && value.trim().length > 0 && value.length <= 200,
  }),
  "session.delete": object<ParamsOf<"session.delete">>({ sessionId: id }),
  "session.snapshot": object<ParamsOf<"session.snapshot">>({ sessionId: id }),
  "session.subscribe": object<ParamsOf<"session.subscribe">>({ sessionId: id }),
  "session.unsubscribe": object<ParamsOf<"session.unsubscribe">>({ subscriptionId: id }),
  "run.start": object<ParamsOf<"run.start">>({
    sessionId: id, clientMessageId: id,
    content: (value): value is InputPart[] => array(inputPart)(value)
      && value.length > 0 && value.some((part) => part.text.trim().length > 0),
  }),
  "run.cancel": object<ParamsOf<"run.cancel">>({ sessionId: id, runId: id }),
  "run.get": object<ParamsOf<"run.get">>({ sessionId: id, runId: id }),
  "approval.respond": object<ParamsOf<"approval.respond">>({
    sessionId: id, runId: id, approvalId: id, decision: oneOf("approve", "deny"),
  }),
} satisfies { [M in Method]: Guard<ParamsOf<M>> };

const cancelRequested = object<Extract<ResultOf<"run.cancel">, { disposition: "requested" }>>({
  sessionId: id, runId: id, disposition: oneOf("requested"),
});
const cancelFinished = object<Extract<ResultOf<"run.cancel">, { disposition: "already_finished" }>>({
  sessionId: id, runId: id, disposition: oneOf("already_finished"), status: terminalStatus,
});
const resultValidators = {
  "runtime.getState": isRuntimeNotice,
  "session.create": object<ResultOf<"session.create">>({ sessionId: id }),
  "session.list": object<ResultOf<"session.list">>({ items: array(sessionSummary), nextCursor: optional(id) }),
  "session.rename": object<ResultOf<"session.rename">>({ session: sessionSummary }),
  "session.delete": object<ResultOf<"session.delete">>({ sessionId: id }),
  "session.snapshot": snapshot,
  "session.subscribe": object<ResultOf<"session.subscribe">>({ subscriptionId: id, sessionId: id }),
  "session.unsubscribe": object<ResultOf<"session.unsubscribe">>({ removed: boolean }),
  "run.start": object<ResultOf<"run.start">>({
    sessionId: id, runId: id, clientMessageId: id, messageId: id, disposition: oneOf("accepted", "duplicate"),
  }),
  "run.cancel": (value: unknown): value is ResultOf<"run.cancel"> => cancelRequested(value) || cancelFinished(value),
  "run.get": runView,
  "approval.respond": object<ResultOf<"approval.respond">>({ approval: approvalView, disposition: oneOf("applied", "already_resolved") }),
} satisfies { [M in Method]: Guard<ResultOf<M>> };

export function isMethod(value: unknown): value is Method {
  return string(value) && Object.prototype.hasOwnProperty.call(paramsValidators, value);
}

export function isParamsFor<M extends Method>(method: M, value: unknown): value is ParamsOf<M> {
  return isWirePayload(value) && paramsValidators[method](value);
}

export function isAgentRequest(value: unknown): value is AgentRequest {
  return isWirePayload(value) && isRecord(value)
    && Object.keys(value).every((key) => ["protocolVersion", "kind", "requestId", "method", "params"].includes(key))
    && value.protocolVersion === AGENT_PROTOCOL_VERSION && value.kind === "request"
    && id(value.requestId) && isMethod(value.method) && paramsValidators[value.method](value.params);
}

export function isApiResultFor<M extends Method>(method: M, value: unknown): value is ApiResult<ResultOf<M>> {
  if (!isWirePayload(value) || !isRecord(value)) return false;
  return value.ok === true
    ? Object.keys(value).every((key) => key === "ok" || key === "result") && resultValidators[method](value.result)
    : value.ok === false && Object.keys(value).every((key) => key === "ok" || key === "error") && isAppError(value.error);
}

export function isResponseFor<M extends Method>(method: M, value: unknown): value is ResponseFor<M> {
  if (!isWirePayload(value) || !isRecord(value)
    || value.protocolVersion !== AGENT_PROTOCOL_VERSION || value.kind !== "response" || !id(value.requestId)) return false;
  const { protocolVersion: _version, kind: _kind, requestId: _id, ...result } = value;
  return isApiResultFor(method, result);
}

/** Validate identifiers as well as shape before routing a result to its caller. */
export function responseMatchesRequest(request: AgentRequest, value: unknown): boolean {
  if (!isResponseFor(request.method, value) || value.requestId !== request.requestId) return false;
  if (!value.ok) return true;
  const result: unknown = value.result;
  if (!isRecord(result)) return false;
  switch (request.method) {
    case "run.start": return result.sessionId === request.params.sessionId
      && result.clientMessageId === request.params.clientMessageId;
    case "run.cancel": return result.sessionId === request.params.sessionId && result.runId === request.params.runId;
    case "run.get": return result.sessionId === request.params.sessionId && result.id === request.params.runId;
    case "session.delete": return result.sessionId === request.params.sessionId;
    case "session.rename":
    case "session.snapshot": return isRecord(result.session) && result.session.sessionId === request.params.sessionId;
    case "session.subscribe": return result.sessionId === request.params.sessionId;
    case "approval.respond": return isRecord(result.approval) && result.approval.sessionId === request.params.sessionId
      && result.approval.runId === request.params.runId && result.approval.id === request.params.approvalId;
    default: return true;
  }
}

type EventData<T extends EventPayload["type"]> = Extract<EventPayload, { type: T }>["data"];
const eventValidators = {
  "run.started": object<EventData<"run.started">>({}),
  "run.updated": object<EventData<"run.updated">>({ run: runView }),
  "message.accepted": object<EventData<"message.accepted">>({ message: messageView }),
  "message.started": object<EventData<"message.started">>({ messageId: id, role: oneOf("assistant") }),
  "message.text.delta": object<EventData<"message.text.delta">>({ messageId: id, partId: id, delta: string }),
  "message.completed": object<EventData<"message.completed">>({ messageId: id, content: array(messagePart) }),
  "tool.updated": object<EventData<"tool.updated">>({ tool: toolView }),
  "tool.input.delta": object<EventData<"tool.input.delta">>({ toolCallId: id, delta: string }),
  "tool.output.delta": object<EventData<"tool.output.delta">>({ toolCallId: id, delta: string }),
  "tool.started": object<EventData<"tool.started">>({ toolCallId: id, toolName: id }),
  "tool.completed": object<EventData<"tool.completed">>({
    toolCallId: id, outcome: oneOf(...TOOL_OUTCOMES), tool: toolView,
  }),
  "approval.requested": object<EventData<"approval.requested">>({ approval: approvalView }),
  "approval.resolved": object<EventData<"approval.resolved">>({ approval: approvalView }),
  "run.finished": runOutcome,
} satisfies { [T in EventPayload["type"]]: Guard<EventData<T>> };

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isWirePayload(value) || !isRecord(value)
    || !Object.keys(value).every((key) => ["protocolVersion", "kind", "sessionId", "runId", "seq", "type", "data"].includes(key))
    || value.protocolVersion !== AGENT_PROTOCOL_VERSION || value.kind !== "event"
    || !id(value.sessionId) || !id(value.runId) || !sequence(value.seq) || value.seq === 0
    || !string(value.type) || !Object.prototype.hasOwnProperty.call(eventValidators, value.type)) return false;
  if (!eventValidators[value.type as EventPayload["type"]](value.data)) return false;
  const event = value as AgentEvent;
  switch (event.type) {
    case "run.updated": return event.data.run.id === event.runId && event.data.run.sessionId === event.sessionId;
    case "message.accepted": return event.data.message.sessionId === event.sessionId
      && event.data.message.runId === event.runId;
    case "tool.updated": return event.data.tool.runId === event.runId;
    case "tool.completed": return event.data.tool.runId === event.runId
      && event.data.toolCallId === event.data.tool.toolCallId && event.data.outcome === event.data.tool.status;
    case "approval.requested":
    case "approval.resolved": return event.data.approval.sessionId === event.sessionId
      && event.data.approval.runId === event.runId
      && (event.type === "approval.requested" ? event.data.approval.status === "pending" : event.data.approval.status !== "pending");
    default: return true;
  }
}
