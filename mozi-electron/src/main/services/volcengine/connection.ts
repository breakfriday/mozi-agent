/**
 * 请求底座：管理一条与火山引擎的 WebSocket 连接。
 *
 * 职责只有连接本身——握手、建连确认、收发二进制帧、关闭；
 * 不认识“会话”和“合成流”，收到的会话类消息原样交给监听者处理。
 */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import WebSocket from "ws";
import { classifyServerFailure, extractErrorMessage } from "./payload";
import {
  decodeJsonPayload,
  encodeFinishConnectionFrame,
  encodeStartConnectionFrame,
  EventType,
  MsgType,
  unmarshalMessage,
  type VolcProtocolMessage,
} from "./tts-protocol";
import { VolcengineTtsError, type VolcengineTtsErrorCode, type VolcWebSocketLike } from "./types";

/** WebSocket 单帧接收上限：10 MiB，对齐官方 SDK 示例，避免较大音频块触发 `ws` 默认帧大小保护而断开。 */
const MAX_WS_PAYLOAD_BYTES = 10 * 1024 * 1024;

const WS_OPEN = 1;
const utf8Decoder = new TextDecoder();

/** 连接向外产出的三类结果。 */
export interface VolcConnectionListener {
  /** 收到 `ConnectionStarted(50)`，连接可以承载会话。 */
  onReady(info: { connectId?: string; logId?: string }): void;
  /** 收到会话类或音频类消息（连接类消息已在内部处理）。 */
  onFrame(message: VolcProtocolMessage): void;
  /** 连接已结束：`error` 为空表示服务端正常关闭。最多触发一次。 */
  onClosed(error?: VolcengineTtsError): void;
}

export interface VolcConnectionOptions {
  url: string;
  headers: Record<string, string>;
  createSocket: (url: string, headers: Record<string, string>) => VolcWebSocketLike;
  connectTimeoutMs: number;
  finishTimeoutMs: number;
  listener: VolcConnectionListener;
}

/** 默认 WebSocket 工厂：使用 `ws` 库，可携带自定义握手请求头。 */
export function createDefaultWebSocket(url: string, headers: Record<string, string>): VolcWebSocketLike {
  return new WebSocket(url, { headers, skipUTF8Validation: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
}

export class VolcConnection {
  private socket?: VolcWebSocketLike;
  /** 调用 `close()` 或连接失败后置空，此后不再向外产出任何结果。 */
  private listener?: VolcConnectionListener;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private logId?: string;

  constructor(private readonly options: VolcConnectionOptions) {
    this.listener = options.listener;
  }

  /** 发起握手；成功后自动发送 `StartConnection(1)` 并等待 `ConnectionStarted(50)`。 */
  open(): void {
    const { url, headers, createSocket, connectTimeoutMs } = this.options;
    let socket: VolcWebSocketLike;
    try {
      socket = createSocket(url, headers);
    } catch (err) {
      this.fail("NETWORK_ERROR", `创建语音 WebSocket 失败：${errorText(err)}`, err);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => this.fail("TIMEOUT", "连接火山语音合成服务超时。"), connectTimeoutMs);

    socket.on("upgrade", (res) => {
      this.logId = headerValue(res, "x-tt-logid");
    });
    socket.on("open", () => this.send(encodeStartConnectionFrame()));
    socket.on("unexpected-response", (_req, res) => this.handleHandshakeRejected(res));
    socket.on("message", (raw, isBinary) => this.handleMessage(raw, isBinary));
    socket.on("error", (err) => this.fail("NETWORK_ERROR", `语音连接网络错误：${err.message}`, err));
    socket.on("close", (code, reason) => {
      const reasonText = reason?.length ? `, reason=${reason.toString("utf8")}` : "";
      this.fail("NETWORK_ERROR", `语音连接意外断开 (code=${code}${reasonText})`, undefined, code);
    });
  }

  /** 发送一帧二进制数据；发送失败视为连接失败。 */
  send(frame: Uint8Array): void {
    const socket = this.socket;
    if (!socket || !this.listener || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(frame, (err) => {
        if (err) this.fail("NETWORK_ERROR", `发送语音数据帧失败：${err.message}`, err);
      });
    } catch (err) {
      this.fail("NETWORK_ERROR", `发送语音数据帧异常：${errorText(err)}`, err);
    }
  }

  /**
   * 主动关闭连接，调用后不再向外产出任何结果。
   * - `graceful = true`：发送 `FinishConnection(2)`，等待 `ConnectionFinished(52)` 或超时后关闭
   * - `graceful = false`：立即销毁
   */
  close(graceful: boolean): void {
    const socket = this.detach();
    if (!socket) return;
    if (!graceful || socket.readyState !== WS_OPEN) {
      destroySocket(socket);
      return;
    }

    const timer = setTimeout(() => destroySocket(socket), this.options.finishTimeoutMs);
    timer.unref?.();
    const finish = () => {
      clearTimeout(timer);
      socket.close();
    };
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) return finish();
      try {
        if (unmarshalMessage(toBytes(raw)).event === EventType.ConnectionFinished) finish();
      } catch {
        finish();
      }
    });
    socket.on("error", () => clearTimeout(timer));
    socket.on("close", () => clearTimeout(timer));
    try {
      socket.send(encodeFinishConnectionFrame());
    } catch {
      finish();
    }
  }

  private handleHandshakeRejected(res: IncomingMessage): void {
    const status = res.statusCode ?? 0;
    const logId = headerValue(res, "x-tt-logid");
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").trim();
      const detail = body ? ` (${body.slice(0, 240)})` : "";
      const code: VolcengineTtsErrorCode =
        status === 401 || status === 403 ? "AUTH_FAILED" : status === 429 ? "QUOTA_EXCEEDED" : "NETWORK_ERROR";
      this.failWith(new VolcengineTtsError(code, `语音服务握手失败 HTTP ${status}${detail}`, { logId, serverCode: status }));
    });
  }

  private handleMessage(raw: WebSocket.RawData, isBinary: boolean): void {
    const bytes = toBytes(raw);

    // 官方文档：文本帧用于反馈网关层异常
    if (!isBinary) {
      const text = utf8Decoder.decode(bytes).trim();
      this.failWith(classifyServerFailure(undefined, text || "收到服务端异常文本帧", this.logId));
      return;
    }

    let message: VolcProtocolMessage;
    try {
      message = unmarshalMessage(bytes);
    } catch (err) {
      this.fail("PROTOCOL_ERROR", `解析火山二进制帧失败：${errorText(err)}`, err);
      return;
    }

    if (message.type === MsgType.Error) {
      const text =
        extractErrorMessage(safeJson(message)) ||
        utf8Decoder.decode(message.payload).trim() ||
        `服务端返回错误帧 (code=${message.errorCode ?? "unknown"})`;
      this.failWith(classifyServerFailure(message.errorCode, text, this.logId));
      return;
    }

    switch (message.event) {
      case EventType.ConnectionStarted:
        clearTimeout(this.connectTimer);
        this.listener?.onReady({ connectId: message.connectId, logId: this.logId });
        return;
      case EventType.ConnectionFailed: {
        const text = extractErrorMessage(safeJson(message)) || "火山语音服务拒绝建立连接。";
        this.failWith(classifyServerFailure(undefined, text, this.logId));
        return;
      }
      case EventType.ConnectionFinished: {
        // 服务端主动结束连接：正常关闭，不带错误
        const listener = this.listener;
        const socket = this.detach();
        if (socket) destroySocket(socket);
        listener?.onClosed();
        return;
      }
      default:
        this.listener?.onFrame(message);
    }
  }

  private fail(code: VolcengineTtsErrorCode, message: string, cause?: unknown, serverCode?: number): void {
    this.failWith(new VolcengineTtsError(code, message, { logId: this.logId, cause, serverCode }));
  }

  private failWith(error: VolcengineTtsError): void {
    const listener = this.listener;
    const socket = this.detach();
    if (socket) destroySocket(socket);
    listener?.onClosed(error);
  }

  /** 断开与监听者的关联并清理定时器，返回底层 socket 供调用方处置。 */
  private detach(): VolcWebSocketLike | undefined {
    const socket = this.socket;
    this.socket = undefined;
    this.listener = undefined;
    clearTimeout(this.connectTimer);
    socket?.removeAllListeners();
    return socket;
  }
}

/** 立即销毁 socket；保留一个空 error 监听，避免销毁后迟到的 error 事件导致进程未捕获异常。 */
function destroySocket(socket: VolcWebSocketLike): void {
  socket.removeAllListeners();
  socket.on("error", () => {});
  try {
    socket.terminate();
  } catch {
    /* 已关闭的 socket 可能抛错，忽略 */
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  return data as Uint8Array;
}

function headerValue(res: IncomingMessage, name: string): string | undefined {
  const value = res.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeJson(message: VolcProtocolMessage): Record<string, unknown> | undefined {
  try {
    return decodeJsonPayload(message);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
