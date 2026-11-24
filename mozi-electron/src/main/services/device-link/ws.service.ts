import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  extractRequestPathname,
  normalizeWsPath,
  parseIncomingTextFrame,
  serializeOutgoingTextFrame,
} from "./protocol";
import {
  DEFAULT_DEVICE_LINK_CONFIG,
  DeviceLinkProtocolError,
  type DeviceLinkClientInfo,
  type DeviceLinkDiagnostic,
  type DeviceLinkTextItem,
} from "./types";

interface TrackedClient {
  readonly socket: WebSocket;
  readonly info: DeviceLinkClientInfo;
  alive: boolean;
}

export interface DeviceLinkWsCallbacks {
  onTextFrame?: (item: DeviceLinkTextItem, client: DeviceLinkClientInfo) => void;
  onBinaryFrame?: (chunk: Buffer, client: DeviceLinkClientInfo) => void;
  onClientConnected?: (client: DeviceLinkClientInfo) => void;
  onClientDisconnected?: (client: DeviceLinkClientInfo, code: number) => void;
  onDiagnostic?: (diag: DeviceLinkDiagnostic) => void;
}

export interface DeviceLinkWsOptions {
  readonly path?: string;
  readonly maxTextBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly heartbeatMs?: number;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class DeviceLinkWsService {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, TrackedClient>();
  private wsPath: string;
  private maxTextBytes: number;
  private heartbeatMs: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    options: DeviceLinkWsOptions = {},
    private readonly callbacks: DeviceLinkWsCallbacks = {},
  ) {
    this.wsPath = normalizeWsPath(options.path ?? DEFAULT_DEVICE_LINK_CONFIG.path);
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_DEVICE_LINK_CONFIG.maxTextBytes;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_DEVICE_LINK_CONFIG.heartbeatMs;
    const maxPayload = options.maxPayloadBytes ?? DEFAULT_DEVICE_LINK_CONFIG.maxPayloadBytes;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload,
    });
  }

  configure(options: DeviceLinkWsOptions): void {
    if (options.path !== undefined) {
      this.wsPath = normalizeWsPath(options.path);
    }
    if (options.maxTextBytes !== undefined) {
      this.maxTextBytes = options.maxTextBytes;
    }
    if (options.heartbeatMs !== undefined && options.heartbeatMs !== this.heartbeatMs) {
      this.heartbeatMs = options.heartbeatMs;
      if (this.heartbeatTimer) {
        this.stopHeartbeat();
        this.startHeartbeat();
      }
    }
  }

  getPath(): string {
    return this.wsPath;
  }

  getClients(): DeviceLinkClientInfo[] {
    return Array.from(this.clients.values(), (entry) => entry.info);
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer || this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [clientId, entry] of this.clients) {
        if (!entry.alive) {
          this.clients.delete(clientId);
          this.emitDiagnostic("info", "device_link.ws.heartbeat_timeout", { clientId });
          try {
            entry.socket.terminate();
          } catch {
            // Ignore termination errors on dead sockets.
          }
          continue;
        }
        entry.alive = false;
        try {
          entry.socket.ping();
        } catch {
          // Socket close handler will clean up if broken.
        }
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reqPath = extractRequestPathname(req.url);
    if (reqPath !== this.wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      this.emitDiagnostic("warn", "device_link.ws.path_rejected", {
        expected: this.wsPath,
        actual: reqPath,
      });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attachClient(ws, req);
    });
  }

  broadcastText(
    item: Pick<DeviceLinkTextItem, "id" | "text" | "isLink" | "timestamp">,
    excludeClientId?: string,
  ): number {
    const frame = serializeOutgoingTextFrame(item);
    let delivered = 0;
    for (const [clientId, entry] of this.clients) {
      if (excludeClientId && clientId === excludeClientId) continue;
      if (entry.socket.readyState !== WebSocket.OPEN) continue;
      try {
        entry.socket.send(frame);
        delivered++;
      } catch (error) {
        this.emitDiagnostic("warn", "device_link.ws.send_failed", {
          clientId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return delivered;
  }

  sendTextToClient(
    clientId: string,
    item: Pick<DeviceLinkTextItem, "id" | "text" | "isLink" | "timestamp">,
  ): boolean {
    const entry = this.clients.get(clientId);
    if (!entry || entry.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      entry.socket.send(serializeOutgoingTextFrame(item));
      return true;
    } catch (error) {
      this.emitDiagnostic("warn", "device_link.ws.send_failed", {
        clientId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  closeAll(code = 1001, reason = "Server shutting down"): void {
    this.stopHeartbeat();
    for (const entry of this.clients.values()) {
      try {
        entry.socket.close(code, reason);
      } catch {
        try {
          entry.socket.terminate();
        } catch {
          // Ignore cleanup errors.
        }
      }
    }
    this.clients.clear();
  }

  private attachClient(ws: WebSocket, req: IncomingMessage): void {
    const clientId = `dev_${randomUUID().slice(0, 8)}`;
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    const userAgentHeader = req.headers["user-agent"];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

    const info: DeviceLinkClientInfo = {
      clientId,
      remoteAddress,
      ...(userAgent ? { userAgent } : {}),
      connectedAt: Date.now(),
    };
    const tracked: TrackedClient = { socket: ws, info, alive: true };
    this.clients.set(clientId, tracked);
    this.wss.emit("connection", ws, req);

    this.emitDiagnostic("info", "device_link.ws.connected", {
      clientId,
      remoteAddress,
    });
    this.callbacks.onClientConnected?.(info);

    ws.on("pong", () => {
      tracked.alive = true;
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      tracked.alive = true;
      const buf = rawDataToBuffer(data);

      if (isBinary) {
        this.callbacks.onBinaryFrame?.(buf, info);
        return;
      }

      try {
        const parsed = parseIncomingTextFrame(buf, {
          maxBytes: this.maxTextBytes,
          client: info,
        });
        this.callbacks.onTextFrame?.(parsed, info);
      } catch (error) {
        if (error instanceof DeviceLinkProtocolError) {
          this.emitDiagnostic("warn", "device_link.ws.invalid_text_frame", {
            clientId,
            code: error.code,
            message: error.message,
          });
        } else {
          this.emitDiagnostic("error", "device_link.ws.frame_error", {
            clientId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    ws.on("error", (error: Error) => {
      this.emitDiagnostic("warn", "device_link.ws.socket_error", {
        clientId,
        message: error.message,
      });
    });

    ws.on("close", (code: number) => {
      const existed = this.clients.delete(clientId);
      if (existed) {
        this.emitDiagnostic("info", "device_link.ws.disconnected", {
          clientId,
          code,
        });
        this.callbacks.onClientDisconnected?.(info, code);
      }
    });
  }

  private emitDiagnostic(
    level: DeviceLinkDiagnostic["level"],
    name: string,
    detail?: Record<string, unknown>,
  ): void {
    this.callbacks.onDiagnostic?.({ level, name, detail });
  }
}
