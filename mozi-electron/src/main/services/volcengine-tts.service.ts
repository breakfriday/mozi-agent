import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";
import WebSocket from "ws";
import { createAgentLogger } from "../../../../shared/agent/logging";
import {
  decodeJsonPayload,
  encodeCancelSessionFrame,
  encodeFinishConnectionFrame,
  encodeFinishSessionFrame,
  encodeStartConnectionFrame,
  encodeStartSessionFrame,
  encodeTaskRequestFrame,
  EventType,
  MsgType,
  unmarshalMessage,
  type VolcProtocolMessage,
} from "./volcengine-tts-protocol";

const log = createAgentLogger("main");
const utf8Decoder = new TextDecoder();

export const DEFAULT_VOLCENGINE_TTS_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection";
export const DEFAULT_VOLCENGINE_TTS_RESOURCE_ID = "seed-tts-2.0";
export const DEFAULT_VOLCENGINE_TTS_SPEAKER = "zh_female_vv_uranus_bigtts";

export const TTS_CONNECT_TIMEOUT_MS = 10_000;
export const TTS_SESSION_START_TIMEOUT_MS = 8_000;
export const TTS_CANCEL_DRAIN_TIMEOUT_MS = 1_500;
export const TTS_FINISH_CONNECTION_TIMEOUT_MS = 2_000;
export const TTS_IDLE_KEEPALIVE_MS = 60_000;
export const TTS_MAX_DELTA_CHARS = 4_000;
export const TTS_MAX_WS_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_SECTION_CACHE_SIZE = 128;

export type VolcengineAudioFormat = "pcm" | "mp3" | "ogg_opus";
export type VolcengineSampleRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

export type VolcengineTtsErrorCode =
  | "UNCONFIGURED"
  | "INVALID_ARGUMENT"
  | "AUTH_FAILED"
  | "QUOTA_EXCEEDED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "PROTOCOL_ERROR";

export class VolcengineTtsError extends Error {
  readonly code: VolcengineTtsErrorCode;
  readonly logId?: string;
  readonly serverCode?: number;

  constructor(
    code: VolcengineTtsErrorCode,
    message: string,
    options?: { logId?: string; serverCode?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "VolcengineTtsError";
    this.code = code;
    this.logId = options?.logId;
    this.serverCode = options?.serverCode;
  }
}

export interface VolcengineTtsConfig {
  /** Default: wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection */
  endpoint?: string;
  /** Default: seed-tts-2.0 (or seed-icl-2.0 for cloned voices) */
  resourceId?: string;
  /** Preferred single-key authentication for Ark Agent Plan & v3 console */
  apiKey?: string;
  /** Legacy dual-key authentication fallback */
  appId?: string;
  accessKey?: string;
  /** Default voice speaker ID */
  speaker?: string;
  /** Default: "pcm" */
  format?: VolcengineAudioFormat;
  /** Default: 24000 */
  sampleRate?: VolcengineSampleRate;
  /** [-50, 100], 0 = 1.0x */
  speechRate?: number;
  /** [-50, 100], 0 = 1.0x */
  loudnessRate?: number;
  /** [-12, 12], optional post-process pitch */
  pitch?: number;
  emotion?: string;
  /** [1, 5] */
  emotionScale?: number;
  /** Default voice instruction passed via additions.context_texts */
  defaultContextText?: string;
  uid?: string;
}

export interface VolcengineTtsStreamOptions {
  /** Logical conversation key (e.g. Mozi sessionId) mapped to a stable UUID section_id */
  sessionKey?: string;
  speaker?: string;
  format?: VolcengineAudioFormat;
  sampleRate?: VolcengineSampleRate;
  speechRate?: number;
  loudnessRate?: number;
  pitch?: number;
  emotion?: string;
  emotionScale?: number;
  /** Per-utterance natural language tone instruction for seed-tts-2.0 */
  contextText?: string;
  /** Only needed for cloned voices (seed-icl-2.0) */
  model?: "seed-tts-2.0-standard" | "seed-tts-2.0-expressive";
}

export interface VolcengineTtsStreamHandlers {
  onStarted?: (info: { streamId: string; volcSessionId: string; logId?: string }) => void;
  onAudio: (
    chunk: Uint8Array,
    meta: { streamId: string; format: VolcengineAudioFormat; sampleRate: VolcengineSampleRate },
  ) => void;
  onSentenceStart?: (info: { streamId: string; text?: string }) => void;
  onSentenceEnd?: (info: { streamId: string; text?: string }) => void;
  onComplete?: (summary: {
    streamId: string;
    audioBytes: number;
    textWords?: number;
    logId?: string;
  }) => void;
  onCancel?: (info: { streamId: string }) => void;
  onError?: (error: VolcengineTtsError) => void;
}

export interface VolcengineTtsStream {
  readonly id: string;
  readonly active: boolean;
  write(textDelta: string): void;
  finish(): void;
  cancel(): void;
}

/** Minimal WebSocket contract allowing zero-network unit testing. */
export interface VolcWebSocketLike {
  readonly readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "upgrade", listener: (response: IncomingMessage) => void): this;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: IncomingMessage) => void,
  ): this;
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: Uint8Array, cb?: (err?: Error) => void): void;
  close(): void;
  terminate(): void;
  removeAllListeners(): this;
}

export interface VolcengineTtsDependencies {
  createWebSocket?: (url: string, headers: Record<string, string>) => VolcWebSocketLike;
  timeouts?: Partial<{
    connectMs: number;
    sessionStartMs: number;
    cancelDrainMs: number;
    finishConnectionMs: number;
    idleKeepaliveMs: number;
    maxDeltaChars: number;
  }>;
}

type ConnectionState = "disconnected" | "connecting" | "ready";
type RunPhase = "queued" | "starting" | "streaming" | "finishing" | "cancelling" | "settled";

interface ResolvedRunParams {
  speaker: string;
  format: VolcengineAudioFormat;
  sampleRate: VolcengineSampleRate;
  requestTemplate: {
    user: { uid: string };
    namespace: "BidirectionalTTS";
    req_params: Record<string, unknown>;
  };
}

interface InternalRun {
  readonly streamId: string;
  readonly volcSessionId: string;
  readonly params: ResolvedRunParams;
  readonly handlers: VolcengineTtsStreamHandlers;
  phase: RunPhase;
  hasWrittenText: boolean;
  finishRequested: boolean;
  pendingTexts: string[];
  audioBytes: number;
  latestTextWords?: number;
}

const WS_OPEN = 1;

function defaultCreateWebSocket(url: string, headers: Record<string, string>): VolcWebSocketLike {
  return new WebSocket(url, {
    headers,
    skipUTF8Validation: true,
    maxPayload: TTS_MAX_WS_PAYLOAD_BYTES,
  });
}

function clampRange(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Splits long strings without breaking UTF-16 surrogate pairs (emojis). */
export function splitTextByCodePoints(text: string, maxCodePoints: number): string[] {
  if (!text) return [];
  if (text.length <= maxCodePoints) return [text];
  const chars = Array.from(text);
  if (chars.length <= maxCodePoints) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += maxCodePoints) {
    chunks.push(chars.slice(i, i + maxCodePoints).join(""));
  }
  return chunks;
}

function validateEndpoint(rawEndpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new VolcengineTtsError("INVALID_ARGUMENT", `无效的语音服务端点 URL：${rawEndpoint}`);
  }
  if (parsed.username || parsed.password) {
    throw new VolcengineTtsError("INVALID_ARGUMENT", "语音服务端点 URL 不允许内嵌凭据。");
  }
  if (parsed.protocol === "wss:") return parsed.href;
  const isLocalWs =
    parsed.protocol === "ws:" &&
    (parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]");
  if (isLocalWs) return parsed.href;
  throw new VolcengineTtsError(
    "INVALID_ARGUMENT",
    "语音服务端点仅支持 wss://（本地调试仅允许 ws://127.0.0.1 或 ws://localhost）。",
  );
}

function rawDataToUint8Array(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  return data as Uint8Array;
}

function classifyServerFailure(
  serverCode: number | undefined,
  message: string,
  logId?: string,
): VolcengineTtsError {
  const lower = message.toLowerCase();
  if (
    serverCode === 401 ||
    serverCode === 403 ||
    serverCode === 45000000 ||
    /auth|token|api[-_ ]?key|app[-_ ]?id|forbidden|unauthorized|permission|resource.*not.*allowed|鉴权|密钥|无权限/.test(
      lower,
    )
  ) {
    return new VolcengineTtsError("AUTH_FAILED", message, { logId, serverCode });
  }
  if (
    serverCode === 429 ||
    /quota|rate\s*limit|exceed|concurrency|balance|arrears|额度|欠费|并发|限流/.test(lower)
  ) {
    return new VolcengineTtsError("QUOTA_EXCEEDED", message, { logId, serverCode });
  }
  return new VolcengineTtsError("PROTOCOL_ERROR", message, { logId, serverCode });
}

/**
 * Stateful SDK wrapper for Volcengine V3 bidirectional streaming TTS (`seed-tts-2.0`).
 * Hides connection reuse, keep-alive, serial session gating, pre-ready buffering and cancellation.
 */
export class VolcengineTtsService {
  private config: VolcengineTtsConfig;
  private readonly createSocket: (url: string, headers: Record<string, string>) => VolcWebSocketLike;
  private readonly timeouts: {
    connectMs: number;
    sessionStartMs: number;
    cancelDrainMs: number;
    finishConnectionMs: number;
    idleKeepaliveMs: number;
    maxDeltaChars: number;
  };

  private ws?: VolcWebSocketLike;
  private connState: ConnectionState = "disconnected";
  private currentLogId?: string;
  private connectionStale = false;
  private disposed = false;

  private activeRun?: InternalRun;
  private queuedRun?: InternalRun;

  private connectTimer?: ReturnType<typeof setTimeout>;
  private sessionStartTimer?: ReturnType<typeof setTimeout>;
  private cancelDrainTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;

  private readonly sectionIds = new Map<string, string>();

  constructor(config: VolcengineTtsConfig = {}, deps: VolcengineTtsDependencies = {}) {
    this.config = { ...config };
    this.createSocket = deps.createWebSocket ?? defaultCreateWebSocket;
    this.timeouts = {
      connectMs: deps.timeouts?.connectMs ?? TTS_CONNECT_TIMEOUT_MS,
      sessionStartMs: deps.timeouts?.sessionStartMs ?? TTS_SESSION_START_TIMEOUT_MS,
      cancelDrainMs: deps.timeouts?.cancelDrainMs ?? TTS_CANCEL_DRAIN_TIMEOUT_MS,
      finishConnectionMs: deps.timeouts?.finishConnectionMs ?? TTS_FINISH_CONNECTION_TIMEOUT_MS,
      idleKeepaliveMs: deps.timeouts?.idleKeepaliveMs ?? TTS_IDLE_KEEPALIVE_MS,
      maxDeltaChars: deps.timeouts?.maxDeltaChars ?? TTS_MAX_DELTA_CHARS,
    };
  }

  /** Updates configuration; rotates the pooled connection only when handshake headers change. */
  configure(patch: Partial<VolcengineTtsConfig>): void {
    if (this.disposed) return;
    const prev = this.config;
    const next: VolcengineTtsConfig = { ...prev, ...patch };
    const handshakeChanged =
      (prev.endpoint ?? DEFAULT_VOLCENGINE_TTS_ENDPOINT) !==
        (next.endpoint ?? DEFAULT_VOLCENGINE_TTS_ENDPOINT) ||
      (prev.resourceId ?? DEFAULT_VOLCENGINE_TTS_RESOURCE_ID) !==
        (next.resourceId ?? DEFAULT_VOLCENGINE_TTS_RESOURCE_ID) ||
      (prev.apiKey ?? "") !== (next.apiKey ?? "") ||
      (prev.appId ?? "") !== (next.appId ?? "") ||
      (prev.accessKey ?? "") !== (next.accessKey ?? "");

    this.config = next;
    if (handshakeChanged && this.connState !== "disconnected") {
      if (!this.activeRun && !this.queuedRun) {
        this.gracefulCloseSocket();
      } else {
        this.connectionStale = true;
      }
    }
  }

  /**
   * Synchronously creates a streaming TTS handle.
   * Preempts and cancels any unfinished previous stream automatically.
   */
  startStream(
    options: VolcengineTtsStreamOptions = {},
    handlers: VolcengineTtsStreamHandlers,
  ): VolcengineTtsStream {
    const streamId = randomUUID();

    if (this.disposed) {
      void Promise.resolve().then(() => {
        handlers.onError?.(new VolcengineTtsError("NETWORK_ERROR", "语音合成服务已关闭。"));
      });
      return this.createInertHandle(streamId);
    }

    // Preempt any queued or running stream first so old audio stops immediately.
    this.cancelCurrent();

    let endpoint: string;
    let headers: Record<string, string>;
    let params: ResolvedRunParams;
    try {
      endpoint = validateEndpoint(this.config.endpoint?.trim() || DEFAULT_VOLCENGINE_TTS_ENDPOINT);
      headers = this.buildAuthHeaders();
      params = this.buildRunParams(options);
    } catch (err) {
      const ttsErr =
        err instanceof VolcengineTtsError
          ? err
          : new VolcengineTtsError("INVALID_ARGUMENT", err instanceof Error ? err.message : String(err));
      void Promise.resolve().then(() => handlers.onError?.(ttsErr));
      return this.createInertHandle(streamId);
    }

    const run: InternalRun = {
      streamId,
      volcSessionId: randomUUID(),
      params,
      handlers,
      phase: "queued",
      hasWrittenText: false,
      finishRequested: false,
      pendingTexts: [],
      audioBytes: 0,
    };

    this.queuedRun = run;
    this.clearIdleTimer();

    // Warm up the WebSocket immediately so TLS handshake overlaps with LLM token arrival.
    if (this.connState === "disconnected") {
      this.openConnection(endpoint, headers);
    } else if (this.connState === "ready" && this.connectionStale && !this.activeRun) {
      this.gracefulCloseSocket();
      this.openConnection(endpoint, headers);
    }

    return {
      id: streamId,
      get active() {
        return run.phase !== "cancelling" && run.phase !== "settled";
      },
      write: (textDelta: string) => this.writeToRun(run, textDelta),
      finish: () => this.finishRun(run),
      cancel: () => this.cancelRun(run),
    };
  }

  /** One-shot helper for full-sentence preview or historical message replay. */
  speak(
    text: string,
    options: VolcengineTtsStreamOptions = {},
    handlers: VolcengineTtsStreamHandlers,
  ): VolcengineTtsStream {
    const stream = this.startStream(options, handlers);
    if (text) stream.write(text);
    stream.finish();
    return stream;
  }

  /** Aborts any active or queued stream immediately. */
  cancelCurrent(): void {
    if (this.queuedRun) {
      const queued = this.queuedRun;
      this.queuedRun = undefined;
      queued.phase = "settled";
      queued.pendingTexts.length = 0;
      this.safeInvoke(() => queued.handlers.onCancel?.({ streamId: queued.streamId }));
    }
    if (this.activeRun && this.activeRun.phase !== "cancelling" && this.activeRun.phase !== "settled") {
      this.transitionActiveToCancelling(this.activeRun);
    }
  }

  /** Releases all timers and closes the underlying WebSocket immediately. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelCurrent();
    this.clearAllTimers();
    this.sectionIds.clear();
    if (this.ws) {
      const socket = this.ws;
      this.ws = undefined;
      this.connState = "disconnected";
      socket.removeAllListeners();
      try {
        socket.terminate();
      } catch {
        /* Ignore teardown errors on closing socket. */
      }
    }
  }

  private createInertHandle(id: string): VolcengineTtsStream {
    return {
      id,
      active: false,
      write() {},
      finish() {},
      cancel() {},
    };
  }

  private writeToRun(run: InternalRun, textDelta: string): void {
    if (this.disposed || run.phase === "cancelling" || run.phase === "settled" || run.finishRequested) {
      return;
    }
    if (!textDelta) return;

    run.hasWrittenText = true;
    if (run.phase === "streaming" && this.connState === "ready" && this.ws?.readyState === WS_OPEN) {
      this.sendTaskChunks(run, textDelta);
      return;
    }

    run.pendingTexts.push(textDelta);
    this.pump();
  }

  private finishRun(run: InternalRun): void {
    if (this.disposed || run.phase === "cancelling" || run.phase === "settled" || run.finishRequested) {
      return;
    }
    run.finishRequested = true;

    // Short-circuit empty utterances (e.g. pure code blocks) without opening a remote session.
    if (run.phase === "queued" && !run.hasWrittenText) {
      if (this.queuedRun === run) this.queuedRun = undefined;
      run.phase = "settled";
      void Promise.resolve().then(() => {
        this.safeInvoke(() =>
          run.handlers.onComplete?.({
            streamId: run.streamId,
            audioBytes: 0,
            textWords: 0,
            logId: this.currentLogId,
          }),
        );
      });
      this.scheduleIdleIfEmpty();
      return;
    }

    if (run.phase === "streaming" && this.connState === "ready" && this.ws?.readyState === WS_OPEN) {
      this.flushPendingTexts(run);
      run.phase = "finishing";
      this.sendBinary(encodeFinishSessionFrame(run.volcSessionId), run);
      return;
    }

    this.pump();
  }

  private cancelRun(run: InternalRun): void {
    if (run.phase === "cancelling" || run.phase === "settled") return;

    if (this.queuedRun === run) {
      this.queuedRun = undefined;
      run.phase = "settled";
      run.pendingTexts.length = 0;
      this.safeInvoke(() => run.handlers.onCancel?.({ streamId: run.streamId }));
      this.scheduleIdleIfEmpty();
      return;
    }

    if (this.activeRun === run) {
      this.transitionActiveToCancelling(run);
    }
  }

  private transitionActiveToCancelling(run: InternalRun): void {
    this.clearSessionStartTimer();
    run.phase = "cancelling";
    run.pendingTexts.length = 0;
    this.safeInvoke(() => run.handlers.onCancel?.({ streamId: run.streamId }));

    if (this.connState === "ready" && this.ws?.readyState === WS_OPEN) {
      this.sendBinary(encodeCancelSessionFrame(run.volcSessionId));
      this.clearCancelDrainTimer();
      this.cancelDrainTimer = setTimeout(() => {
        if (this.activeRun !== run) return;
        log.warn("tts.session.cancel_timeout", {
          volcSessionId: run.volcSessionId,
          logId: this.currentLogId,
        });
        this.activeRun = undefined;
        this.dropCurrentSocket();
        this.pump();
      }, this.timeouts.cancelDrainMs);
    } else {
      this.activeRun = undefined;
      this.pump();
    }
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.activeRun) return;
    const next = this.queuedRun;
    if (!next || !next.hasWrittenText) return;

    if (this.connState === "ready" && this.connectionStale) {
      this.gracefulCloseSocket();
    }

    if (this.connState === "disconnected") {
      try {
        const endpoint = validateEndpoint(
          this.config.endpoint?.trim() || DEFAULT_VOLCENGINE_TTS_ENDPOINT,
        );
        const headers = this.buildAuthHeaders();
        this.openConnection(endpoint, headers);
      } catch (err) {
        this.failRun(
          next,
          err instanceof VolcengineTtsError
            ? err
            : new VolcengineTtsError("NETWORK_ERROR", String(err)),
        );
      }
      return;
    }

    if (this.connState !== "ready" || !this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    // Promote queuedRun -> activeRun and dispatch StartSession(100).
    this.queuedRun = undefined;
    this.activeRun = next;
    next.phase = "starting";
    this.clearIdleTimer();

    const startPayload = {
      user: next.params.requestTemplate.user,
      namespace: next.params.requestTemplate.namespace,
      event: EventType.StartSession,
      req_params: { ...next.params.requestTemplate.req_params },
    };

    this.clearSessionStartTimer();
    this.sessionStartTimer = setTimeout(() => {
      if (this.activeRun !== next || next.phase !== "starting") return;
      const err = new VolcengineTtsError("TIMEOUT", "等待火山语音会话启动超时。", {
        logId: this.currentLogId,
      });
      this.activeRun = undefined;
      this.dropCurrentSocket();
      this.failRun(next, err);
      this.pump();
    }, this.timeouts.sessionStartMs);

    this.sendBinary(encodeStartSessionFrame(next.volcSessionId, startPayload), next);
  }

  private openConnection(endpoint: string, headers: Record<string, string>): void {
    this.clearIdleTimer();
    this.clearConnectTimer();
    this.connState = "connecting";
    this.connectionStale = false;
    this.currentLogId = undefined;

    let socket: VolcWebSocketLike;
    try {
      socket = this.createSocket(endpoint, headers);
    } catch (err) {
      this.connState = "disconnected";
      this.failPendingConnection(
        new VolcengineTtsError(
          "NETWORK_ERROR",
          `创建语音 WebSocket 失败：${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      );
      return;
    }

    this.ws = socket;

    this.connectTimer = setTimeout(() => {
      if (this.ws !== socket || this.connState !== "connecting") return;
      const err = new VolcengineTtsError("TIMEOUT", "连接火山语音合成服务超时。", {
        logId: this.currentLogId,
      });
      this.dropCurrentSocket();
      this.failPendingConnection(err);
    }, this.timeouts.connectMs);

    socket.on("upgrade", (res) => {
      if (this.ws !== socket) return;
      const logId = res.headers["x-tt-logid"];
      this.currentLogId = Array.isArray(logId) ? logId[0] : logId;
    });

    socket.on("open", () => {
      if (this.ws !== socket) return;
      try {
        socket.send(encodeStartConnectionFrame(), (err) => {
          if (err && this.ws === socket) {
            this.handleSocketFailure(
              socket,
              new VolcengineTtsError("NETWORK_ERROR", `发送建连帧失败：${err.message}`, {
                logId: this.currentLogId,
                cause: err,
              }),
            );
          }
        });
      } catch (err) {
        this.handleSocketFailure(
          socket,
          new VolcengineTtsError(
            "NETWORK_ERROR",
            `发送建连帧异常：${err instanceof Error ? err.message : String(err)}`,
            { logId: this.currentLogId, cause: err },
          ),
        );
      }
    });

    socket.on("unexpected-response", (_req, res) => {
      if (this.ws !== socket) return;
      const status = res.statusCode ?? 0;
      const logIdHeader = res.headers["x-tt-logid"];
      const logId = Array.isArray(logIdHeader) ? logIdHeader[0] : logIdHeader;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        if (this.ws !== socket) return;
        const bodyText = Buffer.concat(chunks).toString("utf8").trim();
        const detail = bodyText ? ` (${bodyText.slice(0, 240)})` : "";
        const code: VolcengineTtsErrorCode =
          status === 401 || status === 403
            ? "AUTH_FAILED"
            : status === 429
              ? "QUOTA_EXCEEDED"
              : "NETWORK_ERROR";
        this.handleSocketFailure(
          socket,
          new VolcengineTtsError(code, `语音服务握手失败 HTTP ${status}${detail}`, {
            logId,
            serverCode: status,
          }),
        );
      });
    });

    socket.on("message", (raw, isBinary) => {
      if (this.ws !== socket) return;
      this.handleIncomingFrame(socket, raw, isBinary);
    });

    socket.on("error", (err) => {
      if (this.ws !== socket) return;
      this.handleSocketFailure(
        socket,
        new VolcengineTtsError("NETWORK_ERROR", `语音连接网络错误：${err.message}`, {
          logId: this.currentLogId,
          cause: err,
        }),
      );
    });

    socket.on("close", (code, reason) => {
      if (this.ws !== socket) return;
      const reasonText = reason?.length ? reason.toString("utf8") : "";
      this.handleSocketFailure(
        socket,
        new VolcengineTtsError(
          "NETWORK_ERROR",
          `语音连接意外断开 (code=${code}${reasonText ? `, reason=${reasonText}` : ""})`,
          { logId: this.currentLogId, serverCode: code },
        ),
      );
    });
  }

  private handleIncomingFrame(
    socket: VolcWebSocketLike,
    raw: WebSocket.RawData,
    isBinary: boolean,
  ): void {
    const bytes = rawDataToUint8Array(raw);

    // Volcengine V3 doc 2.2: text frames report unexpected gateway errors.
    if (!isBinary) {
      const text = utf8Decoder.decode(bytes).trim();
      const err = classifyServerFailure(undefined, text || "收到服务端异常文本帧", this.currentLogId);
      this.handleSocketFailure(socket, err);
      return;
    }

    let msg: VolcProtocolMessage;
    try {
      msg = unmarshalMessage(bytes);
    } catch (err) {
      const protoErr = new VolcengineTtsError(
        "PROTOCOL_ERROR",
        `解析火山二进制帧失败：${err instanceof Error ? err.message : String(err)}`,
        { logId: this.currentLogId, cause: err },
      );
      this.handleSocketFailure(socket, protoErr);
      return;
    }

    if (msg.type === MsgType.Error) {
      const payloadObj = this.tryParsePayload(msg);
      const errText =
        this.extractErrorMessage(payloadObj) ||
        utf8Decoder.decode(msg.payload).trim() ||
        `服务端返回错误帧 (code=${msg.errorCode ?? "unknown"})`;
      const ttsErr = classifyServerFailure(msg.errorCode, errText, this.currentLogId);
      // Error frames leave session state indeterminate; drop connection and report.
      this.handleSocketFailure(socket, ttsErr);
      return;
    }

    if (msg.type === MsgType.AudioOnlyServer) {
      this.handleAudioFrame(msg);
      return;
    }

    if (msg.type === MsgType.FullServerResponse) {
      this.handleServerEvent(socket, msg);
    }
  }

  private handleAudioFrame(msg: VolcProtocolMessage): void {
    const run = this.activeRun;
    if (!run) return;
    if (run.phase !== "streaming" && run.phase !== "finishing") return;
    if (msg.sessionId && msg.sessionId !== run.volcSessionId) return;
    if (msg.payload.byteLength === 0) return;

    run.audioBytes += msg.payload.byteLength;
    this.safeInvoke(() =>
      run.handlers.onAudio(msg.payload, {
        streamId: run.streamId,
        format: run.params.format,
        sampleRate: run.params.sampleRate,
      }),
    );
  }

  private handleServerEvent(socket: VolcWebSocketLike, msg: VolcProtocolMessage): void {
    switch (msg.event) {
      case EventType.ConnectionStarted: {
        this.clearConnectTimer();
        this.connState = "ready";
        log.info("tts.ws.connected", {
          connectId: msg.connectId,
          logId: this.currentLogId,
        });
        this.pump();
        if (!this.activeRun && !this.queuedRun) {
          this.scheduleIdleIfEmpty();
        }
        return;
      }

      case EventType.ConnectionFailed: {
        const payload = this.tryParsePayload(msg);
        const text = this.extractErrorMessage(payload) || "火山语音服务拒绝建立连接。";
        this.handleSocketFailure(socket, classifyServerFailure(undefined, text, this.currentLogId));
        return;
      }

      case EventType.ConnectionFinished: {
        this.dropCurrentSocket();
        this.pump();
        return;
      }

      case EventType.SessionStarted: {
        const run = this.activeRun;
        if (!run || (msg.sessionId && msg.sessionId !== run.volcSessionId)) return;
        this.clearSessionStartTimer();
        if (run.phase === "cancelling") return;

        run.phase = "streaming";
        this.safeInvoke(() =>
          run.handlers.onStarted?.({
            streamId: run.streamId,
            volcSessionId: run.volcSessionId,
            logId: this.currentLogId,
          }),
        );

        this.flushPendingTexts(run);
        if (run.finishRequested && run.phase === "streaming") {
          run.phase = "finishing";
          this.sendBinary(encodeFinishSessionFrame(run.volcSessionId), run);
        }
        return;
      }

      case EventType.TTSSentenceStart: {
        const run = this.activeRun;
        if (!run || run.phase === "cancelling" || (msg.sessionId && msg.sessionId !== run.volcSessionId)) {
          return;
        }
        const payload = this.tryParsePayload(msg);
        const text = typeof payload?.text === "string" ? payload.text : undefined;
        this.safeInvoke(() => run.handlers.onSentenceStart?.({ streamId: run.streamId, text }));
        return;
      }

      case EventType.TTSSentenceEnd: {
        const run = this.activeRun;
        if (!run || run.phase === "cancelling" || (msg.sessionId && msg.sessionId !== run.volcSessionId)) {
          return;
        }
        const payload = this.tryParsePayload(msg);
        const text = typeof payload?.text === "string" ? payload.text : undefined;
        this.safeInvoke(() => run.handlers.onSentenceEnd?.({ streamId: run.streamId, text }));
        return;
      }

      case EventType.UsageResponse: {
        const run = this.activeRun;
        if (!run || (msg.sessionId && msg.sessionId !== run.volcSessionId)) return;
        const words = this.extractUsageTextWords(this.tryParsePayload(msg));
        if (words !== undefined) run.latestTextWords = words;
        return;
      }

      case EventType.SessionFinished: {
        const run = this.activeRun;
        if (!run || (msg.sessionId && msg.sessionId !== run.volcSessionId)) return;
        this.clearSessionStartTimer();
        this.clearCancelDrainTimer();
        this.activeRun = undefined;

        const wasCancelling = run.phase === "cancelling";
        run.phase = "settled";

        if (!wasCancelling) {
          const words =
            this.extractUsageTextWords(this.tryParsePayload(msg)) ?? run.latestTextWords;
          this.safeInvoke(() =>
            run.handlers.onComplete?.({
              streamId: run.streamId,
              audioBytes: run.audioBytes,
              textWords: words,
              logId: this.currentLogId,
            }),
          );
        }

        this.afterSessionReleased();
        return;
      }

      case EventType.SessionCanceled: {
        const run = this.activeRun;
        if (!run || (msg.sessionId && msg.sessionId !== run.volcSessionId)) return;
        this.clearSessionStartTimer();
        this.clearCancelDrainTimer();
        this.activeRun = undefined;
        run.phase = "settled";
        this.afterSessionReleased();
        return;
      }

      case EventType.SessionFailed: {
        const run = this.activeRun;
        if (!run || (msg.sessionId && msg.sessionId !== run.volcSessionId)) return;
        this.clearSessionStartTimer();
        this.clearCancelDrainTimer();
        this.activeRun = undefined;

        const wasCancelling = run.phase === "cancelling";
        run.phase = "settled";

        if (!wasCancelling) {
          const payload = this.tryParsePayload(msg);
          const text = this.extractErrorMessage(payload) || "语音合成会话失败。";
          const codeNum =
            typeof payload?.status_code === "number" ? payload.status_code : undefined;
          const err = classifyServerFailure(codeNum, text, this.currentLogId);
          log.warn("tts.session.failed", {
            volcSessionId: run.volcSessionId,
            code: err.code,
            logId: this.currentLogId,
            message: err.message,
          });
          this.safeInvoke(() => run.handlers.onError?.(err));
        }

        this.afterSessionReleased();
        return;
      }

      default:
        return;
    }
  }

  private afterSessionReleased(): void {
    if (this.connectionStale) {
      this.gracefulCloseSocket();
    }
    this.pump();
    this.scheduleIdleIfEmpty();
  }

  private flushPendingTexts(run: InternalRun): void {
    if (run.pendingTexts.length === 0) return;
    const combined = run.pendingTexts.join("");
    run.pendingTexts.length = 0;
    this.sendTaskChunks(run, combined);
  }

  private sendTaskChunks(run: InternalRun, text: string): void {
    const chunks = splitTextByCodePoints(text, this.timeouts.maxDeltaChars);
    for (const chunk of chunks) {
      const taskPayload = {
        user: run.params.requestTemplate.user,
        namespace: run.params.requestTemplate.namespace,
        event: EventType.TaskRequest,
        req_params: {
          ...run.params.requestTemplate.req_params,
          text: chunk,
        },
      };
      this.sendBinary(encodeTaskRequestFrame(run.volcSessionId, taskPayload), run);
    }
  }

  private sendBinary(frame: Uint8Array, ownerRun?: InternalRun): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(frame, (err) => {
        if (err && this.ws === socket) {
          this.handleSocketFailure(
            socket,
            new VolcengineTtsError("NETWORK_ERROR", `发送语音数据帧失败：${err.message}`, {
              logId: this.currentLogId,
              cause: err,
            }),
          );
        }
      });
    } catch (err) {
      const ttsErr = new VolcengineTtsError(
        "NETWORK_ERROR",
        `发送语音数据帧异常：${err instanceof Error ? err.message : String(err)}`,
        { logId: this.currentLogId, cause: err },
      );
      if (ownerRun && this.activeRun === ownerRun) {
        this.handleSocketFailure(socket, ttsErr);
      }
    }
  }

  private handleSocketFailure(socket: VolcWebSocketLike, error: VolcengineTtsError): void {
    if (this.ws !== socket) return;
    log.warn("tts.ws.failed", {
      code: error.code,
      logId: error.logId ?? this.currentLogId,
      message: error.message,
    });

    this.dropCurrentSocket();

    const active = this.activeRun;
    this.activeRun = undefined;
    if (active && active.phase !== "cancelling" && active.phase !== "settled") {
      this.failRun(active, error);
    } else if (active) {
      active.phase = "settled";
    }

    // If connection itself failed (e.g. AUTH_FAILED / handshake error), fail queuedRun instead of looping.
    if (this.queuedRun) {
      if (
        error.code === "AUTH_FAILED" ||
        error.code === "QUOTA_EXCEEDED" ||
        error.code === "INVALID_ARGUMENT" ||
        !active
      ) {
        const queued = this.queuedRun;
        this.queuedRun = undefined;
        this.failRun(queued, error);
      } else {
        // Active run crashed mid-flight while a newer preempting run was queued; give queuedRun a fresh connection.
        this.pump();
      }
    }
  }

  private failPendingConnection(error: VolcengineTtsError): void {
    if (this.queuedRun) {
      const queued = this.queuedRun;
      this.queuedRun = undefined;
      this.failRun(queued, error);
    }
  }

  private failRun(run: InternalRun, error: VolcengineTtsError): void {
    if (run.phase === "settled") return;
    run.phase = "settled";
    run.pendingTexts.length = 0;
    this.safeInvoke(() => run.handlers.onError?.(error));
  }

  private scheduleIdleIfEmpty(): void {
    if (this.disposed || this.activeRun || this.queuedRun || this.connState !== "ready") return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeRun || this.queuedRun || this.connState !== "ready") return;
      this.gracefulCloseSocket();
    }, this.timeouts.idleKeepaliveMs);
    this.idleTimer.unref?.();
  }

  /** Detaches the current socket immediately while sending best-effort FinishConnection(2) in background. */
  private gracefulCloseSocket(): void {
    const socket = this.ws;
    if (!socket) return;
    this.ws = undefined;
    this.connState = "disconnected";
    this.connectionStale = false;
    this.clearAllTimers();
    socket.removeAllListeners();

    if (socket.readyState === WS_OPEN) {
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          /* Ignore */
        }
      }, this.timeouts.finishConnectionMs);
      timer.unref?.();

      socket.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        try {
          const msg = unmarshalMessage(rawDataToUint8Array(raw));
          if (msg.event === EventType.ConnectionFinished) {
            clearTimeout(timer);
            socket.close();
          }
        } catch {
          clearTimeout(timer);
          socket.close();
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
      });
      socket.on("close", () => {
        clearTimeout(timer);
      });
      try {
        socket.send(encodeFinishConnectionFrame());
      } catch {
        clearTimeout(timer);
        socket.close();
      }
    } else {
      try {
        socket.terminate();
      } catch {
        /* Ignore */
      }
    }
  }

  private dropCurrentSocket(): void {
    const socket = this.ws;
    this.ws = undefined;
    this.connState = "disconnected";
    this.connectionStale = false;
    this.clearAllTimers();
    if (!socket) return;
    socket.removeAllListeners();
    try {
      socket.terminate();
    } catch {
      /* Ignore */
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    const resourceId = this.config.resourceId?.trim() || DEFAULT_VOLCENGINE_TTS_RESOURCE_ID;
    const apiKey = this.config.apiKey?.trim();
    const appId = this.config.appId?.trim();
    const accessKey = this.config.accessKey?.trim();

    if (apiKey) {
      return {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Connect-Id": randomUUID(),
        "X-Control-Require-Usage-Tokens-Return": "*",
      };
    }

    if (appId && accessKey) {
      return {
        "X-Api-App-Key": appId,
        "X-Api-App-Id": appId,
        "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Connect-Id": randomUUID(),
        "X-Control-Require-Usage-Tokens-Return": "*",
      };
    }

    throw new VolcengineTtsError(
      "UNCONFIGURED",
      "尚未配置火山引擎语音 API Key，请先在设置中填写密钥。",
    );
  }

  private buildRunParams(options: VolcengineTtsStreamOptions): ResolvedRunParams {
    const speaker = (options.speaker ?? this.config.speaker ?? DEFAULT_VOLCENGINE_TTS_SPEAKER).trim();
    if (!speaker) {
      throw new VolcengineTtsError("INVALID_ARGUMENT", "发音人 speaker 不能为空。");
    }

    const format: VolcengineAudioFormat = options.format ?? this.config.format ?? "pcm";
    const sampleRate: VolcengineSampleRate = options.sampleRate ?? this.config.sampleRate ?? 24000;
    const speechRate = clampRange(options.speechRate ?? this.config.speechRate, -50, 100, 0);
    const loudnessRate = clampRange(options.loudnessRate ?? this.config.loudnessRate, -50, 100, 0);
    const pitch = options.pitch ?? this.config.pitch;
    const emotion = (options.emotion ?? this.config.emotion)?.trim();
    const emotionScale = options.emotionScale ?? this.config.emotionScale;
    const contextText = (options.contextText ?? this.config.defaultContextText)?.trim();

    const audioParams: Record<string, unknown> = {
      format,
      sample_rate: sampleRate,
      speech_rate: speechRate,
      loudness_rate: loudnessRate,
    };
    if (format === "mp3" || format === "ogg_opus") {
      audioParams.bit_rate = 64000;
    }
    if (emotion) {
      audioParams.emotion = emotion;
      if (emotionScale !== undefined && Number.isFinite(emotionScale)) {
        audioParams.emotion_scale = clampRange(emotionScale, 1, 5, 4);
      }
    }

    const additions: Record<string, unknown> = {
      disable_markdown_filter: true,
      enable_language_detector: true,
      cache_config: {
        text_type: 1,
        use_cache: true,
        use_segment_cache: true,
      },
    };
    if (pitch !== undefined && Number.isFinite(pitch) && pitch !== 0) {
      additions.post_process = { pitch: clampRange(pitch, -12, 12, 0) };
    }
    if (contextText) {
      additions.context_texts = [contextText];
    }
    if (options.sessionKey) {
      additions.section_id = this.resolveSectionUuid(options.sessionKey);
    }

    const reqParams: Record<string, unknown> = {
      speaker,
      audio_params: audioParams,
      additions: JSON.stringify(additions),
    };
    if (options.model) {
      reqParams.model = options.model;
    }

    return {
      speaker,
      format,
      sampleRate,
      requestTemplate: {
        user: { uid: this.config.uid?.trim() || "mozi-desktop" },
        namespace: "BidirectionalTTS",
        req_params: reqParams,
      },
    };
  }

  private resolveSectionUuid(sessionKey: string): string {
    const existing = this.sectionIds.get(sessionKey);
    if (existing) {
      // Refresh insertion order for simple LRU eviction.
      this.sectionIds.delete(sessionKey);
      this.sectionIds.set(sessionKey, existing);
      return existing;
    }
    const created = randomUUID();
    if (this.sectionIds.size >= MAX_SECTION_CACHE_SIZE) {
      const oldestKey = this.sectionIds.keys().next().value;
      if (oldestKey !== undefined) this.sectionIds.delete(oldestKey);
    }
    this.sectionIds.set(sessionKey, created);
    return created;
  }

  private tryParsePayload(msg: VolcProtocolMessage): Record<string, unknown> | undefined {
    try {
      return decodeJsonPayload(msg);
    } catch {
      return undefined;
    }
  }

  private extractErrorMessage(payload: Record<string, unknown> | undefined): string | undefined {
    if (!payload) return undefined;
    for (const key of ["message", "error", "err_msg", "status_message", "detail"]) {
      const val = payload[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    return undefined;
  }

  private extractUsageTextWords(payload: Record<string, unknown> | undefined): number | undefined {
    if (!payload) return undefined;
    const usage = payload.usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      const words = (usage as Record<string, unknown>).text_words;
      if (typeof words === "number" && Number.isFinite(words)) return words;
    }
    return undefined;
  }

  private safeInvoke(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error(
        "tts.callback.failed",
        { stage: "callback" },
        { message: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private clearSessionStartTimer(): void {
    if (this.sessionStartTimer) {
      clearTimeout(this.sessionStartTimer);
      this.sessionStartTimer = undefined;
    }
  }

  private clearCancelDrainTimer(): void {
    if (this.cancelDrainTimer) {
      clearTimeout(this.cancelDrainTimer);
      this.cancelDrainTimer = undefined;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearAllTimers(): void {
    this.clearConnectTimer();
    this.clearSessionStartTimer();
    this.clearCancelDrainTimer();
    this.clearIdleTimer();
  }
}
