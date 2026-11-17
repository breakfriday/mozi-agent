/**
 * 火山引擎双向流式 TTS 模块的对外契约：配置、流句柄、回调与错误类型。
 * 本文件只有类型与错误定义，不包含任何运行逻辑。
 */
import type { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type WebSocket from "ws";

/** 输出音频编码格式：实时流式低延迟播放推荐使用裸 `pcm`（`pcm_s16le` 单声道小端 16-bit），无容器头拆包与 MP3 句首静音损耗。 */
export type VolcengineAudioFormat = "pcm" | "mp3" | "ogg_opus";

/** 输出音频采样率（Hz）：`seed-tts-2.0` 默认最佳人声采样率为 `24000`（注：`ogg_opus` 格式服务端仅支持 `48000`）。 */
export type VolcengineSampleRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

/** 语音合成结构化错误码，供上层 UI 区分“引导配密钥 / 停自动播报 / 网络瞬断重试”。 */
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
  /** 火山握手响应头 `X-Tt-Logid`，用于服务端问题排查追踪。 */
  readonly logId?: string;
  /** HTTP 状态码或火山二进制错误帧返回的 `errorCode` / `status_code`。 */
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

/** 把任意异常统一转换为 `VolcengineTtsError`。 */
export function toTtsError(error: unknown, fallbackCode: VolcengineTtsErrorCode): VolcengineTtsError {
  if (error instanceof VolcengineTtsError) return error;
  return new VolcengineTtsError(fallbackCode, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

export interface VolcengineTtsConfig {
  /** WebSocket 服务地址，默认火山方舟 Agent Plan 双向流式端点（仅允许 `wss://` 或本机环回 `ws://`）。 */
  endpoint?: string;
  /** 火山资源池 ID，默认 `"seed-tts-2.0"`（声音复刻音色传 `"seed-icl-2.0"`）。 */
  resourceId?: string;
  /** 火山方舟 Agent Plan 及新版控制台单密钥鉴权（映射请求头 `X-Api-Key`，优先使用）。 */
  apiKey?: string;
  /** 旧版豆包语音控制台 AppID（仅在未传 `apiKey` 时与 `accessKey` 组合生效）。 */
  appId?: string;
  /** 旧版豆包语音控制台 Access Token。 */
  accessKey?: string;
  /** 默认发音人 ID（须使用 2.0 音色如 `*_uranus_bigtts`），默认 Vivi 2.0。 */
  speaker?: string;
  /** 默认输出音频编码，默认 `"pcm"`（16-bit 小端单声道）。 */
  format?: VolcengineAudioFormat;
  /** 默认输出采样率（Hz），默认 `24000`。 */
  sampleRate?: VolcengineSampleRate;
  /** 默认语速：`[-50, 100]`，`0` 为 1.0 倍正常语速，`100` 为 2.0 倍，`-50` 为 0.5 倍。 */
  speechRate?: number;
  /** 默认音量：`[-50, 100]`，`0` 为 1.0 倍正常音量，`100` 为 2.0 倍，`-50` 为 0.5 倍。 */
  loudnessRate?: number;
  /** 后处理音调微调：`[-12, 12]`，默认 `0` 不调整。 */
  pitch?: number;
  /** 多情感音色的情绪标识（如 `"happy"`、`"sad"`、`"angry"`，仅支持情感的音色生效）。 */
  emotion?: string;
  /** 情绪强度等级：`[1, 5]`，配合 `emotion` 使用，默认 `4`。 */
  emotionScale?: number;
  /** 默认自然语言语气指令（写入 `additions.context_texts`，仅 2.0 音色生效且该文本不计费）。 */
  defaultContextText?: string;
  /**
   * 覆盖或追加 `req_params.additions` 字段。模块内置默认值为：
   * `disable_markdown_filter: true`、`enable_language_detector: true`、开启分句缓存 `cache_config`。
   * 每次合成计算出的 `context_texts` / `section_id` / `post_process` 优先级高于此处。
   */
  additions?: Record<string, unknown>;
  /** 请求体 `user.uid` 标识，默认 `"volcengine-tts-client"`。 */
  uid?: string;
}

export interface VolcengineTtsStreamOptions {
  /** 业务会话键（如聊天会话 ID）：内部自动映射为稳定 UUID 传入 `additions.section_id`，使多轮对话保持声学上下文连贯。 */
  sessionKey?: string;
  /** 单次覆盖发音人 ID。 */
  speaker?: string;
  /** 单次覆盖音频编码格式。 */
  format?: VolcengineAudioFormat;
  /** 单次覆盖音频采样率。 */
  sampleRate?: VolcengineSampleRate;
  /** 单次覆盖语速 `[-50, 100]`。 */
  speechRate?: number;
  /** 单次覆盖音量 `[-50, 100]`。 */
  loudnessRate?: number;
  /** 单次覆盖音调 `[-12, 12]`。 */
  pitch?: number;
  /** 单次覆盖情绪类型。 */
  emotion?: string;
  /** 单次覆盖情绪强度 `[1, 5]`。 */
  emotionScale?: number;
  /** 单次自然语言语气指令（如 `"请用温和清晰的语气回答"`），覆盖 `defaultContextText`。 */
  contextText?: string;
  /** 仅当 `speaker` 为声音复刻 2.0 音色时指定：`expressive` 支持 `context_texts` 指令，`standard` 时延更低。 */
  model?: "seed-tts-2.0-standard" | "seed-tts-2.0-expressive";
}

export interface VolcengineTtsStreamHandlers {
  /** 服务端返回 `SessionStarted(150)`、正式开始合成时触发。 */
  onStarted?: (info: { streamId: string; volcSessionId: string; logId?: string }) => void;
  /** 收到 `TTSResponse(352)` 音频块时实时触发，直接输出剥除协议头后的裸音频字节流。 */
  onAudio: (
    chunk: Uint8Array,
    meta: { streamId: string; format: VolcengineAudioFormat; sampleRate: VolcengineSampleRate },
  ) => void;
  /** 收到服务端分句开始事件 `TTSSentenceStart(350)` 时触发。 */
  onSentenceStart?: (info: { streamId: string; text?: string }) => void;
  /** 收到服务端分句结束事件 `TTSSentenceEnd(351)` 时触发。 */
  onSentenceEnd?: (info: { streamId: string; text?: string }) => void;
  /** 收到 `SessionFinished(152)`（或空文本流短路结算）时触发，`textWords` 为本轮服务端计费字数。 */
  onComplete?: (summary: {
    streamId: string;
    audioBytes: number;
    textWords?: number;
    logId?: string;
  }) => void;
  /** 流被主动调用 `cancel()` 或被新流抢占取消时触发（此后该流在途残留音频包将被静默丢弃）。 */
  onCancel?: (info: { streamId: string }) => void;
  /** 鉴权、配额、网络或协议异常导致当前流终止时触发。 */
  onError?: (error: VolcengineTtsError) => void;
}

export interface VolcengineTtsStream {
  /** 本次合成流的唯一标识。 */
  readonly id: string;
  /** 当前流是否仍处于有效未终结状态（未取消、未报错且未完成）。 */
  readonly active: boolean;
  /** 同步非阻塞推入增量文本；建连或等待 `150` 期间自动暂存，就绪后自动合并发送。 */
  write(textDelta: string): void;
  /** 标记本轮文本输入完毕，触发发送 `FinishSession(102)` 冲刷服务端剩余尾音。 */
  finish(): void;
  /** 立即中止本轮合成并向服务端发送 `CancelSession(101)` 停止后续计费。 */
  cancel(): void;
}

/** 模块产出的诊断信息（连接建立、断开、超时等），由外部自行决定是否记录日志。 */
export interface VolcengineTtsDiagnostic {
  level: "info" | "warn" | "error";
  name: string;
  detail: Record<string, unknown>;
}

/** 最小化 WebSocket 契约，默认由 `ws` 库实现，单测可替换为内存假实现。 */
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

/** 各阶段等待上限（毫秒）。 */
export interface VolcengineTtsTimeouts {
  /** WebSocket 建连总超时：从发起 TCP/TLS 握手到收到 `ConnectionStarted(50)`，超时销毁连接并上报 `TIMEOUT`。 */
  connectMs: number;
  /** 会话启动超时：从发送 `StartSession(100)` 到收到 `SessionStarted(150)`，超时熔断当前连接并上报 `TIMEOUT`。 */
  sessionStartMs: number;
  /**
   * 会话收尾无进展超时：发送 `FinishSession(102)` 后等待 `SessionFinished(152)` 的看门狗时长；
   * 期间每收到音频块或分句事件自动续期，停滞超时则熔断当前连接并上报 `TIMEOUT`。
   */
  sessionFinishMs: number;
  /**
   * 取消排空超时：火山单连接不允许同时运行多个 Session，发送 `CancelSession(101)` 后须等服务端回传
   * `151/152/153` 终态才能开下一轮；超时未确认（网络半死）时直接销毁旧连接并新建连接，防止后续语音卡死。
   */
  cancelDrainMs: number;
  /** 优雅关闭超时：发送 `FinishConnection(2)` 后等待 `ConnectionFinished(52)` 的上限，到期强制销毁连接。 */
  finishConnectionMs: number;
  /** 空闲保活时长：无活跃或排队合成任务达到该时长后主动关闭连接；期间新的合成直接复用连接，免去重复握手。 */
  idleKeepaliveMs: number;
}

export const DEFAULT_TTS_TIMEOUTS: VolcengineTtsTimeouts = {
  connectMs: 10_000,
  sessionStartMs: 8_000,
  sessionFinishMs: 15_000,
  cancelDrainMs: 1_500,
  finishConnectionMs: 2_000,
  idleKeepaliveMs: 60_000,
};

export interface VolcengineTtsDependencies {
  /** 自定义 WebSocket 构造工厂（默认使用 `ws` 库）。 */
  createWebSocket?: (url: string, headers: Record<string, string>) => VolcWebSocketLike;
  /** 覆盖默认等待上限（主要用于单测加速定时器验证）。 */
  timeouts?: Partial<VolcengineTtsTimeouts>;
  /** 接收模块产出的诊断信息；不传则不输出任何日志。 */
  onDiagnostic?: (diagnostic: VolcengineTtsDiagnostic) => void;
}
