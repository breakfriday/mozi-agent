import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extractRequestPathname, parseIncomingTextFrame } from "./protocol";
import {
  DEFAULT_DEVICE_LINK_CONFIG,
  DeviceLinkProtocolError,
  type DeviceLinkClientInfo,
  type DeviceLinkTextItem,
} from "./types";

export interface DeviceLinkHttpCallbacks {
  onShareText?: (item: DeviceLinkTextItem) => void;
}

export interface DeviceLinkHttpOptions {
  readonly maxTextBytes?: number;
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(payload.byteLength));
  res.end(payload);
}

export class DeviceLinkHttpService {
  private maxTextBytes: number;

  constructor(
    options: DeviceLinkHttpOptions = {},
    private readonly callbacks: DeviceLinkHttpCallbacks = {},
  ) {
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_DEVICE_LINK_CONFIG.maxTextBytes;
  }

  configure(options: DeviceLinkHttpOptions): void {
    if (options.maxTextBytes !== undefined) {
      this.maxTextBytes = options.maxTextBytes;
    }
  }

  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = extractRequestPathname(req.url);

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "device-link" });
      return;
    }

    if (method === "POST" && pathname === "/share") {
      this.handleSharePost(req, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
  }

  private handleSharePost(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buf.byteLength;
      if (receivedBytes > this.maxTextBytes) {
        aborted = true;
        sendJson(res, 413, { ok: false, code: "PAYLOAD_TOO_LARGE", error: "文本内容超过大小限制。" });
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (aborted) return;
      try {
        const remoteAddress = req.socket.remoteAddress ?? "unknown";
        const pseudoClient: DeviceLinkClientInfo = {
          clientId: "http_share",
          remoteAddress,
          connectedAt: Date.now(),
        };
        const item = parseIncomingTextFrame(Buffer.concat(chunks), {
          maxBytes: this.maxTextBytes,
          client: pseudoClient,
        });
        this.callbacks.onShareText?.(item);
        sendJson(res, 200, { ok: true, id: item.id });
      } catch (error) {
        if (error instanceof DeviceLinkProtocolError) {
          const status = error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
          sendJson(res, status, { ok: false, code: error.code, error: error.message });
          return;
        }
        sendJson(res, 500, { ok: false, error: "INTERNAL_ERROR" });
      }
    });

    req.on("error", () => {
      if (!res.headersSent) {
        sendJson(res, 400, { ok: false, error: "REQUEST_STREAM_ERROR" });
      }
    });
  }
}
