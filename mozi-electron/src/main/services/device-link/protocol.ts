import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_DEVICE_LINK_CONFIG,
  DeviceLinkProtocolError,
  type DeviceLinkClientInfo,
  type DeviceLinkTextItem,
} from "./types";

const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;

export function normalizeWsPath(rawPath?: string): string {
  const trimmed = (rawPath ?? "/").trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
}

export function extractRequestPathname(rawUrl?: string): string {
  const pathname = (rawUrl ?? "/").split("?", 1)[0]?.split("#", 1)[0] || "/";
  return normalizeWsPath(pathname);
}

export function extractFirstHttpUrl(text: string): string | undefined {
  const match = text.match(HTTP_URL_PATTERN);
  return match ? match[0] : undefined;
}

export interface ParseTextFrameOptions {
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly client?: DeviceLinkClientInfo;
}

function defaultTextId(nowMs: number): string {
  return `txt_${nowMs}_${randomUUID().slice(0, 8)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIncomingTextFrame(
  raw: string | Buffer,
  options: ParseTextFrameOptions = {},
): DeviceLinkTextItem {
  const maxBytes = options.maxBytes ?? DEFAULT_DEVICE_LINK_CONFIG.maxTextBytes;
  const byteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (byteLength === 0) {
    throw new DeviceLinkProtocolError("EMPTY_PAYLOAD", "WebSocket 文本帧为空。");
  }
  if (byteLength > maxBytes) {
    throw new DeviceLinkProtocolError(
      "PAYLOAD_TOO_LARGE",
      `文本帧大小 (${byteLength} bytes) 超过上限 (${maxBytes} bytes)。`,
    );
  }

  const decoded = (typeof raw === "string" ? raw : raw.toString("utf8")).trim();
  if (!decoded) {
    throw new DeviceLinkProtocolError("EMPTY_PAYLOAD", "WebSocket 文本帧内容为空白字符。");
  }

  const nowMs = options.now ? options.now() : Date.now();
  const makeId = options.createId ?? (() => defaultTextId(nowMs));

  if (decoded.startsWith("{") && decoded.endsWith("}")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      parsed = undefined;
    }

    if (isPlainRecord(parsed)) {
      const frameType = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "text";
      if (frameType !== "text") {
        throw new DeviceLinkProtocolError(
          "UNSUPPORTED_FRAME_TYPE",
          `当前仅处理 text 文本帧，收到类型: ${frameType}`,
        );
      }

      const rawText =
        typeof parsed.text === "string"
          ? parsed.text
          : typeof parsed.content === "string"
            ? parsed.content
            : undefined;
      const content = rawText?.trim() ?? "";
      if (!content) {
        throw new DeviceLinkProtocolError("MISSING_TEXT_CONTENT", "JSON 文本帧缺少有效的 text/content 字段。");
      }

      const id =
        typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id.trim() : makeId();
      const timestamp =
        typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp) && parsed.timestamp > 0
          ? Math.floor(parsed.timestamp)
          : nowMs;
      const detectedUrl = extractFirstHttpUrl(content);
      const isLink = Boolean(detectedUrl) || parsed.isLink === true;

      return {
        id,
        type: "text",
        direction: "incoming",
        text: content,
        isLink,
        ...(detectedUrl ? { url: detectedUrl } : {}),
        timestamp,
        ...(options.client
          ? { clientId: options.client.clientId, remoteAddress: options.client.remoteAddress }
          : {}),
      };
    }
  }

  const detectedUrl = extractFirstHttpUrl(decoded);
  return {
    id: makeId(),
    type: "text",
    direction: "incoming",
    text: decoded,
    isLink: Boolean(detectedUrl),
    ...(detectedUrl ? { url: detectedUrl } : {}),
    timestamp: nowMs,
    ...(options.client
      ? { clientId: options.client.clientId, remoteAddress: options.client.remoteAddress }
      : {}),
  };
}

export function createOutgoingTextItem(
  rawText: string,
  options: { now?: () => number; createId?: () => string; maxBytes?: number } = {},
): DeviceLinkTextItem {
  const content = rawText.trim();
  if (!content) {
    throw new DeviceLinkProtocolError("EMPTY_PAYLOAD", "待发送的文本内容不能为空。");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_DEVICE_LINK_CONFIG.maxTextBytes;
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > maxBytes) {
    throw new DeviceLinkProtocolError(
      "PAYLOAD_TOO_LARGE",
      `待发送文本大小 (${byteLength} bytes) 超过上限 (${maxBytes} bytes)。`,
    );
  }
  const nowMs = options.now ? options.now() : Date.now();
  const id = options.createId ? options.createId() : defaultTextId(nowMs);
  const detectedUrl = extractFirstHttpUrl(content);
  return {
    id,
    type: "text",
    direction: "outgoing",
    text: content,
    isLink: Boolean(detectedUrl),
    ...(detectedUrl ? { url: detectedUrl } : {}),
    timestamp: nowMs,
  };
}

export function serializeOutgoingTextFrame(
  item: Pick<DeviceLinkTextItem, "id" | "text" | "isLink" | "timestamp">,
): string {
  return JSON.stringify({
    type: "text",
    id: item.id,
    text: item.text,
    isLink: item.isLink,
    timestamp: item.timestamp,
  });
}
