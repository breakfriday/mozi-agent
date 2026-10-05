import { ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  AGENT_CHANNELS, AGENT_MAX_PENDING_REQUESTS, AGENT_MAX_SUBSCRIPTIONS_PER_WINDOW,
  AGENT_PROTOCOL_VERSION, isAgentRequest, isRecord, isResponseFor,
} from "../../../shared/agent";
import type { AgentRequest, AgentResponse, RuntimeNotice } from "../../../shared/agent";
import type { RendererEntry } from "../env_config.types";
import type { WindowService } from "./services/window.service";
import { AgentTransport, errorResponse } from "./agent/transport";
import { createAgentLogger } from "../../../shared/agent/logging";

const log = createAgentLogger("main");

type Client = {
  sender: WebContents;
  frame: WebFrameMain;
  subscriptions: Map<string, string>;
  requestIds: Set<string>;
  cleanup(): void;
};

function success<T>(requestId: string, result: T) {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, kind: "response", requestId, ok: true, result } as const;
}

export function registerAgentIpc(
  windowService: WindowService,
  entry: RendererEntry,
  transport = new AgentTransport(),
  // Single-user desktop default: all owned, trusted windows may access local sessions.
  canAccessSession: (sender: WebContents, sessionId: string) => boolean = () => true,
): { transport: AgentTransport; dispose(): void } {
  const clients = new Map<WebContents, Client>();
  const activeRequests = new Map<string, Client>();
  let generation = 0;
  let disposed = false;
  const allowedUrl = new URL(entry.type === "url" ? entry.url : pathToFileURL(entry.filePath).href);

  function trusted(sender: WebContents, frame: WebFrameMain | null): frame is WebFrameMain {
    if (disposed || sender.isDestroyed() || !frame || frame !== sender.mainFrame
      || !windowService.getWindowForWebContents(sender)) return false;
    try {
      const url = new URL(frame.url);
      // HTTP directory entries host SPA routes (e.g. /mozi_app/chat).
      // Keep the trailing slash boundary; file entries still require an exact path.
      const matchesPath = url.pathname === allowedUrl.pathname
        || (['http:', 'https:'].includes(allowedUrl.protocol)
          && allowedUrl.pathname.endsWith('/') && url.pathname.startsWith(allowedUrl.pathname));
      return url.protocol === allowedUrl.protocol && url.host === allowedUrl.host
        && matchesPath;
    } catch { return false; }
  }

  function release(client: Client): void {
    if (clients.get(client.sender) !== client) return;
    log.debug("client.released", { windowId: client.sender.id, subscriptions: client.subscriptions.size, pendingRequests: client.requestIds.size });
    clients.delete(client.sender);
    client.cleanup();
    client.subscriptions.clear();
    for (const requestId of client.requestIds) {
      if (activeRequests.get(requestId) === client) activeRequests.delete(requestId);
      transport.cancelRequest(requestId);
    }
    client.requestIds.clear();
  }

  function getClient(sender: WebContents, frame: WebFrameMain): Client {
    const existing = clients.get(sender);
    if (existing && existing.frame === frame) return existing;
    if (existing) release(existing);
    const client: Client = { sender, frame, subscriptions: new Map(), requestIds: new Set(), cleanup: () => {} };
    const close = () => release(client);
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) release(client);
    };
    sender.on("destroyed", close);
    sender.on("render-process-gone", close);
    sender.on("did-start-navigation", navigate);
    client.cleanup = () => {
      sender.removeListener("destroyed", close);
      sender.removeListener("render-process-gone", close);
      sender.removeListener("did-start-navigation", navigate);
    };
    clients.set(sender, client);
    return client;
  }

  function send(client: Client, channel: string, payload: unknown): boolean {
    if (!trusted(client.sender, client.frame)) { release(client); return false; }
    try {
      client.sender.send(channel, payload);
      log.debug(channel === AGENT_CHANNELS.event ? "event.forward" : "runtime.forward", payload, { windowId: client.sender.id });
      return true;
    } catch {
      log.warn("delivery.failed", payload, { windowId: client.sender.id });
      release(client);
      return false;
    }
  }

  const offState = transport.onState((notice: RuntimeNotice) => {
    log.info("runtime.changed", notice, { generation });
    if (notice.state === "unavailable") {
      generation++;
      for (const client of clients.values()) client.subscriptions.clear();
    }
    // A single main-process path orders unavailable, ready, then new events.
    for (const client of clients.values()) send(client, AGENT_CHANNELS.runtime, notice);
  });
  const offEvent = transport.onEvent((event) => {
    let delivered = 0;
    for (const client of clients.values()) {
      if ([...client.subscriptions.values()].includes(event.sessionId)
        && canAccessSession(client.sender, event.sessionId)
        && send(client, AGENT_CHANNELS.event, event)) delivered++;
    }
    if (!delivered) log.debug("event.dropped", event, { stage: "no_authorized_subscriber" });
  });

  async function dispatch(request: AgentRequest, client: Client): Promise<AgentResponse> {
    if (request.method === "runtime.getState") return success(request.requestId, transport.getState());
    if (request.method === "session.unsubscribe") {
      const removed = client.subscriptions.delete(request.params.subscriptionId);
      log.debug("subscription.removed", request, { removed, windowId: client.sender.id, subscriptions: client.subscriptions.size });
      return success(request.requestId, { removed });
    }
    if ("sessionId" in request.params && !canAccessSession(client.sender, request.params.sessionId)) {
      return errorResponse(request.requestId, "PERMISSION_DENIED", "Session access denied.");
    }
    if (transport.getState().state !== "ready") {
      return errorResponse(request.requestId, "RUNTIME_UNAVAILABLE", "Agent runtime is not ready.");
    }
    if (request.method === "session.subscribe") {
      if (client.subscriptions.size >= AGENT_MAX_SUBSCRIPTIONS_PER_WINDOW) {
        return errorResponse(request.requestId, "CAPACITY_EXCEEDED", "Too many session subscriptions.");
      }
      const subscriptionId = randomUUID();
      client.subscriptions.set(subscriptionId, request.params.sessionId);
      log.debug("subscription.added", request, { subscriptionId, windowId: client.sender.id, subscriptions: client.subscriptions.size });
      // Delivery is installed before acknowledgement. The subsequent snapshot
      // verifies session existence and establishes the authoritative cursor.
      return success(request.requestId, { subscriptionId, sessionId: request.params.sessionId });
    }
    log.debug("request.forward", request, { windowId: client.sender.id });
    const response = await transport.request(request);
    if (request.method === "session.list" && isResponseFor("session.list", response) && response.ok) {
      return success(request.requestId, {
        ...response.result,
        items: response.result.items.filter((item) => canAccessSession(client.sender, item.sessionId)),
      });
    }
    return response;
  }

  ipcMain.handle(AGENT_CHANNELS.request, async (event: IpcMainInvokeEvent, value: unknown): Promise<AgentResponse> => {
    const startedAt = Date.now();
    const windowId = event.sender.id;
    log.debug("request.received", value, { windowId });
    const requestId = isRecord(value) && typeof value.requestId === "string" && value.requestId.length <= 256
      && value.requestId.trim() ? value.requestId : "invalid-request";
    const reply = (response: AgentResponse): AgentResponse => {
      log[response.ok ? "debug" : "warn"]("response.return", response, { windowId, durationMs: Date.now() - startedAt });
      return response;
    };
    if (!trusted(event.sender, event.senderFrame)) return reply(errorResponse(requestId, "PERMISSION_DENIED", "Untrusted Agent IPC sender."));
    if (!isAgentRequest(value)) {
      const mismatch = isRecord(value) && value.protocolVersion !== AGENT_PROTOCOL_VERSION;
      log.warn("request.rejected", value, { windowId, stage: "contract_validation" });
      return reply(errorResponse(requestId, mismatch ? "PROTOCOL_MISMATCH" : "INVALID_ARGUMENT", "Invalid Agent request contract."));
    }
    log.debug("request.validated", { requestId, method: value.method, windowId });
    if (activeRequests.has(requestId)) return reply(errorResponse(requestId, "INVALID_ARGUMENT", "Request ID is already active."));
    if (activeRequests.size >= AGENT_MAX_PENDING_REQUESTS) return reply(errorResponse(requestId, "CAPACITY_EXCEEDED", "Too many pending requests."));
    const client = getClient(event.sender, event.senderFrame);
    const token = generation;
    activeRequests.set(requestId, client);
    client.requestIds.add(requestId);
    try {
      const response = await dispatch(value, client);
      if (disposed || token !== generation || clients.get(event.sender) !== client || !trusted(client.sender, client.frame)) {
        log.warn("response.dropped", response, { windowId, stage: "old_connection" });
        return reply(errorResponse(requestId, "RUNTIME_UNAVAILABLE", "Request connection changed; resynchronize before continuing."));
      }
      return reply(response);
    } catch {
      return reply(errorResponse(requestId, "INTERNAL_ERROR", "Agent request could not be processed."));
    } finally {
      if (activeRequests.get(requestId) === client) activeRequests.delete(requestId);
      client.requestIds.delete(requestId);
    }
  });

  log.info("ipc.registered");
  return {
    transport,
    dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler(AGENT_CHANNELS.request);
      offEvent();
      offState();
      for (const client of clients.values()) release(client);
      transport.dispose();
      log.info("ipc.disposed");
    },
  };
}
