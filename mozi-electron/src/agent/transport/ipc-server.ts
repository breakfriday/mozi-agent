import { AGENT_PROTOCOL_VERSION, AGENT_MAX_PENDING_REQUESTS, isAgentRequest, isAgentEvent, isRecord, responseMatchesRequest } from "../../../../shared/agent";
import type { AgentEvent, RuntimePacket, RuntimeRequest, RuntimeResponse } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import { appError, failure } from "../application/errors";
import type { AgentController } from "./agent-controller";
const log = createAgentLogger("agent-service");
export class IpcServer {
  private readonly pending = new Set<string>();
  constructor(private readonly controller: AgentController, private readonly send: (packet: RuntimePacket) => void) {}
  async receive(value: unknown): Promise<void> {
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
}
