import {
  AGENT_MAX_PENDING_REQUESTS, AGENT_PROTOCOL_VERSION, AGENT_REQUEST_TIMEOUT_MS,
  isAgentEvent, isAgentRequest, isRecord, isRuntimeControl, isWirePayload, responseMatchesRequest,
} from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";

const log = createAgentLogger("transport");
import type {
  AgentEvent, AppError, RuntimeNotice, RuntimeRequest, RuntimeResponse,
} from "../../../../shared/agent";

/** Adapt a utilityProcess here; the router never owns the Agent loop. */
export interface AgentConnection {
  postMessage(request: RuntimeRequest): void;
  onMessage(listener: (packet: unknown) => void): () => void;
  onDisconnect(listener: (reason?: string) => void): () => void;
}

type PendingRequest = {
  request: RuntimeRequest;
  resolve(response: RuntimeResponse): void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
};

export function errorResponse(requestId: string, code: AppError["code"], message: string): RuntimeResponse {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, kind: "response", requestId, ok: false, error: { code, message } };
}

export class AgentTransport {
  private connection?: AgentConnection;
  private generation = 0;
  private notice: RuntimeNotice = { state: "unavailable", reason: "Agent runtime is not connected." };
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly stateListeners = new Set<(notice: RuntimeNotice) => void>();
  private cleanups: (() => void)[] = [];

  constructor(private readonly timeoutMs = AGENT_REQUEST_TIMEOUT_MS) {}

  getState(): RuntimeNotice { return { ...this.notice }; }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    log.debug("listener.added", { listenerType: "event", listeners: this.eventListeners.size });
    return () => {
      if (this.eventListeners.delete(listener)) log.debug("listener.removed", { listenerType: "event", listeners: this.eventListeners.size });
    };
  }

  onState(listener: (notice: RuntimeNotice) => void): () => void {
    this.stateListeners.add(listener);
    log.debug("listener.added", { listenerType: "runtime", listeners: this.stateListeners.size });
    return () => {
      if (this.stateListeners.delete(listener)) log.debug("listener.removed", { listenerType: "runtime", listeners: this.stateListeners.size });
    };
  }

  connect(connection: AgentConnection): void {
    this.disconnect("Connecting to Agent runtime.");
    const generation = this.generation;
    this.connection = connection;
    log.info("connection.opened", { generation });
    this.cleanups = [
      connection.onMessage((packet) => {
        if (generation === this.generation && this.connection === connection) this.receive(packet);
        else log.debug("packet.dropped", packet, { generation, stage: "old_connection" });
      }),
      connection.onDisconnect((reason) => {
        if (generation === this.generation && this.connection === connection) this.disconnect(reason);
      }),
    ];
  }

  disconnect(reason = "Agent runtime disconnected.", code: AppError["code"] = "RUNTIME_UNAVAILABLE"): void {
    this.generation++;
    this.connection = undefined;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.notice = { state: "unavailable", reason };
    log.info("connection.closed", { generation: this.generation, code, pendingRequests: this.pending.size });
    for (const [requestId] of this.pending) this.cancelRequest(requestId, code, reason);
    // Emit even if already unavailable: pending work from a previous connection is invalid.
    for (const listener of this.stateListeners) listener(this.getState());
  }

  request(request: RuntimeRequest): Promise<RuntimeResponse> {
    const requestId = request.requestId;
    const reject = (code: AppError["code"], message: string) => {
      const response = errorResponse(requestId, code, message);
      log.warn("request.rejected", request, response);
      return Promise.resolve(response);
    };
    if (!isAgentRequest(request)) return reject("INVALID_ARGUMENT", "Invalid Agent request.");
    if (!this.connection || this.notice.state !== "ready") {
      return reject("RUNTIME_UNAVAILABLE", this.notice.reason ?? "Agent runtime is unavailable.");
    }
    if (this.pending.has(request.requestId)) {
      return reject("INVALID_ARGUMENT", "Request ID is already active.");
    }
    if (this.pending.size >= AGENT_MAX_PENDING_REQUESTS) {
      return reject("CAPACITY_EXCEEDED", "Too many pending Agent requests.");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn("request.timeout", request, { code: "REQUEST_TIMEOUT" });
        this.cancelRequest(request.requestId, "REQUEST_TIMEOUT", "Agent request timed out; execution may already have been accepted.");
      }, this.timeoutMs);
      this.pending.set(request.requestId, { request, resolve, timer, startedAt: Date.now() });
      try {
        log.debug("request.send", request, { generation: this.generation });
        this.connection!.postMessage(request);
      } catch {
        this.disconnect("Could not send request to Agent runtime.");
      }
    });
  }

  // Cancels only the request wait, never a Run. Used on window close/navigation.
  cancelRequest(requestId: string, code: AppError["code"] = "RUNTIME_UNAVAILABLE", message = "Request connection closed."): void {
    this.complete(requestId, errorResponse(requestId, code, message));
  }

  private complete(requestId: string, response: RuntimeResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    log[response.ok ? "debug" : "warn"]("response.return", response, {
      method: pending.request.method, durationMs: Date.now() - pending.startedAt,
    });
    pending.resolve(response);
  }

  private receive(packet: unknown): void {
    if (!isWirePayload(packet) || !isRecord(packet) || packet.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      log.error("packet.rejected", packet, { code: "PROTOCOL_MISMATCH" });
      this.disconnect("Invalid Agent protocol or oversized packet.", "PROTOCOL_MISMATCH");
      return;
    }
    if (isRuntimeControl(packet)) {
      log.info("runtime.validated", packet);
      if (packet.state === "unavailable") {
        this.disconnect(packet.reason);
      } else if (this.notice.state !== "ready") {
        this.notice = { state: "ready" };
        for (const listener of this.stateListeners) listener(this.getState());
      }
      return;
    }
    if (this.notice.state !== "ready") {
      log.error("packet.rejected", packet, { stage: "before_ready", code: "PROTOCOL_MISMATCH" });
      this.disconnect("Agent sent data before the ready handshake.", "PROTOCOL_MISMATCH");
      return;
    }
    if (packet.kind === "response" && typeof packet.requestId === "string") {
      const pending = this.pending.get(packet.requestId);
      if (!pending) {
        log.debug("response.dropped", packet, { stage: "no_pending_request" });
        return;
      }
      if (!responseMatchesRequest(pending.request, packet)) {
        log.error("response.rejected", packet, { method: pending.request.method, code: "PROTOCOL_MISMATCH" });
        this.disconnect("Agent response does not match its request contract.", "PROTOCOL_MISMATCH");
        return;
      }
      log.debug("response.validated", packet, { method: pending.request.method });
      // The result was checked against the method retained in the pending record.
      this.complete(packet.requestId, packet as RuntimeResponse);
      return;
    }
    if (isAgentEvent(packet)) {
      log.debug("event.validated", packet);
      for (const listener of this.eventListeners) listener(packet);
      return;
    }
    log.error("event.rejected", packet, { code: "PROTOCOL_MISMATCH" });
    this.disconnect("Invalid Agent event or control packet.", "PROTOCOL_MISMATCH");
  }

  dispose(): void {
    this.disconnect("Agent transport disposed.");
    this.eventListeners.clear();
    this.stateListeners.clear();
  }
}
