import { AGENT_PROTOCOL_VERSION, AGENT_MAX_PENDING_REQUESTS, isAgentRequest, isAgentEvent, isRecord, isWirePayload, responseMatchesRequest } from "../../../../shared/agent";
import { randomUUID } from "node:crypto";
import { BROWSER_MAX_PENDING, BROWSER_TIMEOUT_MS, BrowserFailure, isBrowserOperation, isBrowserToAgent, isBrowserToMain,
  type BrowserCall, type BrowserRequest, type BrowserToMain, type BrowserToAgent } from "../../../../shared/browser";
import type { AgentEvent, RuntimePacket, RuntimeRequest, RuntimeResponse } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import { appError, failure } from "../errors";
import type { AgentController } from "./agent-controller";
const log = createAgentLogger("agent-service");
export class IpcServer {
  private readonly pending = new Set<string>();
  private readonly browserPending = new Map<string, { request: BrowserRequest; receive(packet: BrowserToAgent): void; cancel(error: Error): void }>();
  private disposed = false;
  constructor(private readonly controller: AgentController, private readonly send: (packet: RuntimePacket | BrowserToMain) => void) {}
  readonly callBrowser: BrowserCall = (operation, context) => {
    if (this.disposed) return Promise.reject(new BrowserFailure("UNAVAILABLE", "Agent 通信已关闭。"));
    if (!isBrowserOperation(operation)) return Promise.reject(new BrowserFailure("INVALID_ARGUMENT", "浏览器参数无效。"));
    if (context.signal.aborted) return Promise.reject(new BrowserFailure("CANCELLED", "浏览器任务已取消。"));
    if (this.browserPending.size >= BROWSER_MAX_PENDING) return Promise.reject(new BrowserFailure("CAPACITY_EXCEEDED", "浏览器任务过多。"));
    const request: BrowserRequest = { protocolVersion: 1, kind: "browser.request", requestId: randomUUID(), operation,
      scope: { sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId } };
    if (!isBrowserToMain(request)) return Promise.reject(new BrowserFailure("INVALID_ARGUMENT", "浏览器执行上下文无效。"));
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); this.browserPending.delete(request.requestId); };
      const cancel = (error: Error) => {
        if (!this.browserPending.has(request.requestId)) return;
        clean();
        try { this.send({ protocolVersion: 1, kind: "browser.cancel", requestId: request.requestId }); }
        catch { /* A disconnected host cannot receive cancellation. */ }
        reject(error);
      };
      const abort = () => cancel(new BrowserFailure("CANCELLED", "浏览器任务已取消。"));
      // Host timeout normally returns first; this also covers a lost host response.
      const timer = setTimeout(() => cancel(new BrowserFailure("TIMEOUT", "等待浏览器响应超时。")), BROWSER_TIMEOUT_MS + 5000);
      this.browserPending.set(request.requestId, { request, cancel, receive: packet => {
        if (packet.kind === "browser.progress") {
          try { context.onProgress(packet.progress); }
          catch { cancel(new BrowserFailure("UNAVAILABLE", "浏览器进度处理失败。")); }
          return;
        }
        clean();
        if (!packet.ok) reject(new BrowserFailure(packet.error.code, packet.error.message));
        else if (packet.result.kind !== operation.action) reject(new BrowserFailure("UNAVAILABLE", "浏览器结果与请求不匹配。"));
        else resolve(packet.result);
      } });
      context.signal.addEventListener("abort", abort, { once: true });
      try { this.send(request); }
      catch { clean(); reject(new BrowserFailure("UNAVAILABLE", "无法发送浏览器请求。")); }
    });
  };
  async receive(value: unknown): Promise<void> {
    if (isRecord(value) && typeof value.kind === "string" && value.kind.startsWith("browser.")) {
      if (!isWirePayload(value) || !isBrowserToAgent(value)) {
        this.dispose();
        throw failure("PROTOCOL_MISMATCH", "浏览器响应未通过共享契约校验。");
      }
      this.browserPending.get(value.requestId)?.receive(value);
      return;
    }
    const requestId = isRecord(value) && typeof value.requestId === "string" && value.requestId.trim() && value.requestId.length <= 256 ? value.requestId : "invalid-request";
    log.debug("request.received", value);
    let response: RuntimeResponse;
    let owned = false;
    try {
      if (!isAgentRequest(value)) throw failure("INVALID_ARGUMENT", "请求未通过共享契约校验。");
      if (["runtime.getState", "session.subscribe", "session.unsubscribe"].includes(value.method)) throw failure("INVALID_ARGUMENT", "此方法由主进程处理。");
      if (this.pending.has(requestId)) throw failure("INVALID_ARGUMENT", "requestId 已在处理中。");
      if (this.pending.size >= AGENT_MAX_PENDING_REQUESTS) throw failure("CAPACITY_EXCEEDED", "待处理请求过多。");
      this.pending.add(requestId); owned = true;
      const request = value as RuntimeRequest;
      log.debug("request.validated", request);
      const result = await this.controller.dispatch(request);
      response = { protocolVersion: AGENT_PROTOCOL_VERSION, kind: "response", requestId, ok: true, result } as RuntimeResponse;
      if (!responseMatchesRequest(request, response)) throw failure("CAPACITY_EXCEEDED", "响应超过容量或不符合共享契约。");
    } catch (error) {
      response = { protocolVersion: AGENT_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: appError(error) };
    } finally { if (owned) this.pending.delete(requestId); }
    log[response.ok ? "debug" : "warn"]("response.send", response);
    this.send(response);
  }
  event(event: AgentEvent): void {
    if (!isAgentEvent(event)) throw failure("PROTOCOL_MISMATCH", "后台生成了无效事件。");
    log.debug("event.send", event); this.send(event);
  }
  dispose(): void {
    this.disposed = true;
    for (const pending of [...this.browserPending.values()]) pending.cancel(new BrowserFailure("UNAVAILABLE", "Agent 正在关闭。"));
  }
}
