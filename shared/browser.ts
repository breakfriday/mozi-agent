/** Mozi's browser boundary. No Electron objects or Pi tool formats cross it. */
export const BROWSER_TIMEOUT_MS = 120_000;
export const BROWSER_MAX_PENDING = 16;
export const BROWSER_MAX_TEXT = 24_000;
export const BROWSER_MAX_ELEMENTS = 100;
export const BROWSER_MAX_INPUT_TEXT = 10_000;
export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type BrowserKey = typeof BROWSER_KEYS[number];

/** Checked against a fresh observed input immediately before sending an interaction. */
export type BrowserInputExpectation = { elementId: string; text: string };

export type BrowserOperation =
  | { action: "search"; query: string; limit?: number }
  | { action: "read"; url: string; target?: never }
  | { action: "read"; target: "current"; url?: never }
  | { action: "inspect"; query?: string; filter?: "inputs" }
  | { action: "click"; elementId: string; expect?: BrowserInputExpectation }
  | { action: "fill"; elementId: string; text: string }
  | { action: "press"; elementId: string; key: BrowserKey; expect?: BrowserInputExpectation };

const inputExpectationSchema = {
  type: "object", required: ["elementId", "text"], additionalProperties: false,
  properties: {
    elementId: { type: "string", minLength: 1, maxLength: 100, description: "与操作目标来自同一次最新 inspect 的输入框编号" },
    text: { type: "string", maxLength: BROWSER_MAX_INPUT_TEXT, description: "提交前必须仍然存在于输入框的完整文本；站内搜索使用用户要求的关键词，不能使用占位热词" },
  },
  description: "click/press 提交站内搜索时必须携带。发送事件前核对指定输入框的实际内容；不匹配则拒绝操作。普通链接/菜单操作可省略。",
};
const operationFields = {
  action: { type: "string", enum: ["search", "read", "inspect", "click", "fill", "press"], description: "search 搜索互联网；read 读取网页；inspect 查看当前页可交互元素；click 点击元素；fill 替换输入内容；press 对元素按键" },
  filter: { type: "string", enum: ["inputs"], description: "inspect 按输入控件筛选；查找站内搜索框时先用 filter=inputs 且不加 query，避免热搜占位词导致漏掉输入框" },
  expect: inputExpectationSchema,
  query: { type: "string", minLength: 1, maxLength: 1000, description: "search 的搜索词；inspect 可选的元素名称或占位提示过滤词" },
  limit: { type: "integer", minimum: 1, maximum: 10, description: "搜索结果数量，默认 5，仅用于 search" },
  url: { type: "string", minLength: 1, maxLength: 4096, description: "打开并读取此 HTTP(S) 网址；不可与 target 同时提供" },
  target: { type: "string", enum: ["current"], description: "直接读取 MoziBrowser 当前页面，不导航、不刷新；不可与 url 同时提供" },
  elementId: { type: "string", minLength: 1, maxLength: 100, description: "最近一次 inspect 返回的元素编号；不可猜测；每次 click/fill/press 后需重新 inspect" },
  text: { type: "string", maxLength: BROWSER_MAX_INPUT_TEXT, description: "fill 替换全部输入内容，空字符串清空；不会提交表单" },
  key: { type: "string", enum: [...BROWSER_KEYS], description: "press 的按键；先重新 inspect 获取目标，Enter 可提交搜索，方向键可操作建议列表" },
};
/** Model-facing schema and host validation describe the same operations. */
export const BROWSER_OPERATION_SCHEMA = {
  type: "object", properties: operationFields, required: ["action"], additionalProperties: false,
  oneOf: [
    { properties: { action: { const: "search" }, query: operationFields.query, limit: operationFields.limit }, required: ["query"], additionalProperties: false },
    { properties: { action: { const: "read" }, url: operationFields.url }, required: ["url"], additionalProperties: false },
    { properties: { action: { const: "read" }, target: operationFields.target }, required: ["target"], additionalProperties: false },
    { properties: { action: { const: "inspect" }, query: operationFields.query, filter: operationFields.filter }, additionalProperties: false },
    { properties: { action: { const: "click" }, elementId: operationFields.elementId, expect: operationFields.expect }, required: ["elementId"], additionalProperties: false },
    { properties: { action: { const: "fill" }, elementId: operationFields.elementId, text: operationFields.text }, required: ["elementId", "text"], additionalProperties: false },
    { properties: { action: { const: "press" }, elementId: operationFields.elementId, key: operationFields.key, expect: operationFields.expect }, required: ["elementId", "key"], additionalProperties: false },
  ],
};
export type BrowserScope = { sessionId: string; runId: string; toolCallId: string };
export type BrowserProgress = { stage: "queued" | "loading" | "extracting" | "interacting" | "waiting_user"; message: string };
export type BrowserElement = { elementId: string; role: string; name: string; disabled: boolean; href?: string;
  editable?: boolean; readOnly?: boolean; inputType?: string; placeholder?: string; focused?: boolean; hasValue?: boolean };
export type BrowserResult =
  | { kind: "search"; query: string; url: string; results: { title: string; url: string; snippet: string }[] }
  | { kind: "read"; title: string; url: string; content: string; truncated: boolean }
  | { kind: "inspect"; title: string; url: string; elements: BrowserElement[]; truncated: boolean }
  | { kind: "click" | "fill" | "press"; title: string; url: string; elementId: string; dispatched: true; inputVerified?: true };
export type BrowserErrorCode = "INVALID_ARGUMENT" | "UNAVAILABLE" | "CAPACITY_EXCEEDED" | "CANCELLED"
  | "TIMEOUT" | "WINDOW_CLOSED" | "NAVIGATION_CHANGED" | "LOAD_FAILED" | "EXTRACTION_FAILED" | "STALE_ELEMENT" | "ELEMENT_NOT_INTERACTABLE" | "INPUT_MISMATCH";
export type BrowserError = { code: BrowserErrorCode; message: string };
export class BrowserFailure extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) { super(message); this.name = "BrowserFailure"; }
}
export type BrowserCallContext = BrowserScope & {
  requestId: string;
  signal: AbortSignal;
  onProgress(progress: BrowserProgress): void;
};
/** An injected capability; IPC and in-process implementations share these semantics. */
export type BrowserCall = (operation: BrowserOperation, context: Omit<BrowserCallContext, "requestId">) => Promise<BrowserResult>;
export type BrowserHandler = (operation: BrowserOperation, context: BrowserCallContext) => Promise<BrowserResult>;

type Envelope = { protocolVersion: 1; requestId: string };
export type BrowserRequest = Envelope & { kind: "browser.request"; operation: BrowserOperation; scope: BrowserScope };
export type BrowserCancel = Envelope & { kind: "browser.cancel" };
export type BrowserResponse = Envelope & { kind: "browser.response" } & (
  | { ok: true; result: BrowserResult } | { ok: false; error: BrowserError }
);
export type BrowserProgressPacket = Envelope & { kind: "browser.progress"; progress: BrowserProgress };
export type BrowserToMain = BrowserRequest | BrowserCancel;
export type BrowserToAgent = BrowserResponse | BrowserProgressPacket;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && v.length <= max && (empty || !!v.trim());
export function isBrowserUrl(value: unknown): value is string {
  if (!text(value, 4096)) return false;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
export function isBrowserOperation(v: unknown): v is BrowserOperation {
  if (!record(v)) return false;
  const expectation = v.expect === undefined || record(v.expect) && Object.keys(v.expect).every(key => ["elementId", "text"].includes(key))
    && text(v.expect.elementId, 100) && text(v.expect.text, BROWSER_MAX_INPUT_TEXT, true);
  const only = (...keys: string[]) => Object.keys(v).every(key => keys.includes(key));
  if (v.action === "search") return only("action", "query", "limit") && text(v.query, 1000)
    && (v.limit === undefined || Number.isInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 10);
  if (v.action === "read") return v.target === "current"
    ? only("action", "target") : only("action", "url") && isBrowserUrl(v.url);
  if (v.action === "inspect") return only("action", "query", "filter") && (v.query === undefined || text(v.query, 1000)) && (v.filter === undefined || v.filter === "inputs");
  if (v.action === "click") return only("action", "elementId", "expect") && text(v.elementId, 100) && expectation;
  if (v.action === "fill") return only("action", "elementId", "text") && text(v.elementId, 100) && text(v.text, BROWSER_MAX_INPUT_TEXT, true);
  if (v.action === "press") return only("action", "elementId", "key", "expect") && text(v.elementId, 100) && BROWSER_KEYS.includes(v.key as BrowserKey) && expectation;
  return false;
}
export function isBrowserResult(v: unknown): v is BrowserResult {
  if (!record(v) || !isBrowserUrl(v.url)) return false;
  if (v.kind === "search") return text(v.query, 1000) && Array.isArray(v.results) && v.results.length <= 10
    && v.results.every(r => record(r) && text(r.title, 1000) && isBrowserUrl(r.url) && text(r.snippet, 2000, true));
  if (!text(v.title, 1000, true)) return false;
  if (v.kind === "read") return text(v.content, BROWSER_MAX_TEXT) && typeof v.truncated === "boolean";
  if (v.kind === "click" || v.kind === "fill" || v.kind === "press") return text(v.elementId, 100) && v.dispatched === true && (v.inputVerified === undefined || v.inputVerified === true);
  return v.kind === "inspect" && typeof v.truncated === "boolean" && Array.isArray(v.elements) && v.elements.length <= BROWSER_MAX_ELEMENTS
    && v.elements.every(e => record(e) && text(e.elementId, 100) && text(e.role, 100) && text(e.name, 400, true)
      && typeof e.disabled === "boolean" && (e.href === undefined || isBrowserUrl(e.href))
      && ["editable", "readOnly", "focused", "hasValue"].every(key => e[key] === undefined || typeof e[key] === "boolean")
      && (e.inputType === undefined || text(e.inputType, 100)) && (e.placeholder === undefined || text(e.placeholder, 400, true)));
}
const envelope = (v: unknown): v is Record<string, unknown> => record(v) && v.protocolVersion === 1 && text(v.requestId, 256);
export function isBrowserToMain(v: unknown): v is BrowserToMain {
  return envelope(v) && (v.kind === "browser.cancel" || v.kind === "browser.request" && isBrowserOperation(v.operation)
    && record(v.scope) && [v.scope.sessionId, v.scope.runId, v.scope.toolCallId].every(id => text(id, 256)));
}
export function isBrowserToAgent(v: unknown): v is BrowserToAgent {
  if (!envelope(v)) return false;
  if (v.kind === "browser.progress") return record(v.progress) && ["queued", "loading", "extracting", "interacting", "waiting_user"].includes(String(v.progress.stage))
    && text(v.progress.message, 1000);
  return v.kind === "browser.response" && (v.ok === true ? isBrowserResult(v.result) : v.ok === false && record(v.error)
    && ["INVALID_ARGUMENT", "UNAVAILABLE", "CAPACITY_EXCEEDED", "CANCELLED", "TIMEOUT", "WINDOW_CLOSED", "NAVIGATION_CHANGED", "LOAD_FAILED", "EXTRACTION_FAILED", "STALE_ELEMENT", "ELEMENT_NOT_INTERACTABLE", "INPUT_MISMATCH"].includes(String(v.error.code))
    && text(v.error.message, 1000));
}
export function browserError(error: unknown): BrowserError {
  return error instanceof BrowserFailure ? { code: error.code, message: error.message.slice(0, 1000) }
    : { code: "UNAVAILABLE", message: "Mozi 浏览器调用失败。" };
}
