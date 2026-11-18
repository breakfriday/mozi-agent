/**
 * 请求与响应负载的纯函数：拼装握手请求头、会话参数，解析服务端返回内容。
 * 不联网、不持有任何状态，给定输入即返回结果。
 */
import {
  VolcengineTtsError,
  type VolcengineAudioFormat,
  type VolcengineSampleRate,
  type VolcengineTtsConfig,
  type VolcengineTtsStreamOptions,
} from "./types";
import { EventType } from "./tts-protocol";

/** 默认接入端点：火山方舟 Agent Plan 双向流式 TTS（普通豆包语音控制台可覆盖为 `/api/v3/tts/bidirection`）。 */
const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection";

/** 默认资源池 ID：「豆包语音合成模型 2.0」（声音复刻 2.0 场景可覆盖为 `seed-icl-2.0`）。 */
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";

/** 默认发音人：Vivi 2.0（官方主打女声，支持 30+ 语种、多种中文方言及 `context_texts` 语气指令）。 */
const DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts";

/** 默认请求体 `user.uid`。 */
const DEFAULT_UID = "volcengine-tts-client";

/**
 * 单帧 `TaskRequest(200)` 最大文本码点数：超长文本（如整条历史消息重听）按 Unicode 码点切分逐帧发送，
 * 避免单包过大，也不会截断 Emoji 等代理对字符。
 */
export const MAX_TEXT_CHUNK_CHARS = 4_000;

/** 单条合成流在建连或等待 `SessionStarted(150)` 期间允许暂存的最大字符数（UTF-16 代码单元）。 */
export const MAX_BUFFERED_TEXT_CHARS = 100_000;

/** `additions` 内置默认值，可被 `VolcengineTtsConfig.additions` 覆盖。 */
const DEFAULT_ADDITIONS: Readonly<Record<string, unknown>> = {
  // 注意官方参数语义反转：true 表示开启服务端 Markdown / Emoji 过滤；false 会把 `**` 念成“星星”
  disable_markdown_filter: true,
  disable_emoji_filter: true,
  enable_auto_language_recognition: true,
  enable_language_detector: true,
};

const VOLC_SEGMENT_CACHE_CONFIG = {
  text_type: 1,
  use_cache: true,
  use_segment_cache: true,
} as const;

/** 一次合成会话的已解析参数：音频规格 + 发给服务端的请求模板。 */
export interface SessionParams {
  format: VolcengineAudioFormat;
  sampleRate: VolcengineSampleRate;
  template: {
    user: { uid: string };
    namespace: "BidirectionalTTS";
    req_params: Record<string, unknown>;
  };
}

/** 校验并返回 WebSocket 地址：仅允许 `wss://`，本机调试允许 `ws://127.0.0.1 | localhost | [::1]`。 */
export function resolveEndpoint(config: VolcengineTtsConfig): string {
  const raw = config.endpoint?.trim() || DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VolcengineTtsError("INVALID_ARGUMENT", `无效的语音服务端点 URL：${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new VolcengineTtsError("INVALID_ARGUMENT", "语音服务端点 URL 不允许内嵌凭据。");
  }
  if (parsed.protocol === "wss:") return parsed.href;
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "ws:" && isLoopback) return parsed.href;
  throw new VolcengineTtsError(
    "INVALID_ARGUMENT",
    "语音服务端点仅支持 wss://（本地调试仅允许 ws://127.0.0.1 或 ws://localhost）。",
  );
}

/** 拼装 WebSocket 握手请求头；未配置任何密钥时抛出 `UNCONFIGURED`。 */
export function buildAuthHeaders(config: VolcengineTtsConfig, connectId: string): Record<string, string> {
  const resourceId = config.resourceId?.trim() || DEFAULT_RESOURCE_ID;
  const common = {
    "X-Api-Resource-Id": resourceId,
    // 每次新建连接都必须使用新的 ID，重连不可复用
    "X-Api-Connect-Id": connectId,
    // 让 SessionFinished(152) 附带 usage.text_words 计费字数
    "X-Control-Require-Usage-Tokens-Return": "*",
  };

  const apiKey = config.apiKey?.trim();
  if (apiKey) return { "X-Api-Key": apiKey, ...common };

  const appId = config.appId?.trim();
  const accessKey = config.accessKey?.trim();
  if (appId && accessKey) {
    // 同时写入 X-Api-App-Key（官方 TS Demo）与 X-Api-App-Id（新版文档），兼容新旧网关
    return { "X-Api-App-Key": appId, "X-Api-App-Id": appId, "X-Api-Access-Key": accessKey, ...common };
  }

  throw new VolcengineTtsError("UNCONFIGURED", "尚未配置火山引擎语音 API Key，请先在设置中填写密钥。");
}

/**
 * 影响握手的配置指纹：指纹变化时需要重建连接，其余配置下一轮会话直接生效。
 * 口径与 `resolveEndpoint` / `buildAuthHeaders` 保持一致（例如已配置 `apiKey` 时忽略未启用的 `appId/accessKey`）。
 */
export function handshakeFingerprint(config: VolcengineTtsConfig): string {
  let endpointKey: string;
  try {
    endpointKey = resolveEndpoint(config);
  } catch {
    endpointKey = `invalid:${config.endpoint?.trim() ?? ""}`;
  }

  const resourceId = config.resourceId?.trim() || DEFAULT_RESOURCE_ID;
  const apiKey = config.apiKey?.trim();
  let authKey: string[];
  if (apiKey) {
    authKey = ["api_key", apiKey];
  } else {
    const appId = config.appId?.trim();
    const accessKey = config.accessKey?.trim();
    authKey = appId && accessKey ? ["legacy_app", appId, accessKey] : ["unconfigured"];
  }

  return JSON.stringify([endpointKey, resourceId, authKey]);
}

/** 合并全局配置与单次选项，生成一次会话的请求参数。 */
export function buildSessionParams(
  config: VolcengineTtsConfig,
  options: VolcengineTtsStreamOptions,
  sectionId?: string,
): SessionParams {
  const speaker = (options.speaker ?? config.speaker ?? DEFAULT_SPEAKER).trim();
  if (!speaker) throw new VolcengineTtsError("INVALID_ARGUMENT", "发音人 speaker 不能为空。");

  const format = options.format ?? config.format ?? "pcm";
  const sampleRate = options.sampleRate ?? config.sampleRate ?? 24000;
  if (format === "ogg_opus" && sampleRate !== 48000) {
    throw new VolcengineTtsError("INVALID_ARGUMENT", "ogg_opus 音频格式仅支持 48000Hz 采样率。");
  }
  const emotion = (options.emotion ?? config.emotion)?.trim();
  const emotionScale = options.emotionScale ?? config.emotionScale;
  const pitch = options.pitch ?? config.pitch;
  const contextText = (options.contextText ?? config.defaultContextText)?.trim();
  const dialect = options.dialect === "" ? undefined : (options.dialect ?? config.dialect);
  const enableCache = options.enableCache ?? config.enableCache;

  const audioParams: Record<string, unknown> = {
    format,
    sample_rate: sampleRate,
    speech_rate: clamp(options.speechRate ?? config.speechRate, -50, 100, 0),
    loudness_rate: clamp(options.loudnessRate ?? config.loudnessRate, -50, 100, 0),
  };
  // MP3 / Ogg 不显式指定比特率时服务端可能回退到 8kbps，音质损耗严重；PCM 不支持该字段
  if (format === "mp3" || format === "ogg_opus") audioParams.bit_rate = 64000;
  if (emotion) {
    audioParams.emotion = emotion;
    if (emotionScale !== undefined && Number.isFinite(emotionScale)) {
      audioParams.emotion_scale = clamp(emotionScale, 1, 5, 4);
    }
  }

  // 优先级：内置默认 < 全局 config.additions < 本次合成计算出的字段
  const additions: Record<string, unknown> = { ...DEFAULT_ADDITIONS, ...config.additions };
  if (enableCache === true) {
    additions.cache_config = VOLC_SEGMENT_CACHE_CONFIG;
  } else if (enableCache === false) {
    delete additions.cache_config;
  }
  if (pitch !== undefined && Number.isFinite(pitch) && pitch !== 0) {
    additions.post_process = { pitch: clamp(pitch, -12, 12, 0) };
  }
  if (dialect) additions.explicit_dialect = dialect;
  if (contextText) additions.context_texts = [contextText];
  if (sectionId) additions.section_id = sectionId;

  const reqParams: Record<string, unknown> = {
    speaker,
    audio_params: audioParams,
    additions: JSON.stringify(additions),
  };
  if (options.model) reqParams.model = options.model;

  return {
    format,
    sampleRate,
    template: {
      user: { uid: config.uid?.trim() || DEFAULT_UID },
      namespace: "BidirectionalTTS",
      req_params: reqParams,
    },
  };
}

/** `StartSession(100)` 的 JSON 负载。 */
export function buildStartSessionPayload(params: SessionParams): Record<string, unknown> {
  return { ...params.template, event: EventType.StartSession, req_params: { ...params.template.req_params } };
}

/** `TaskRequest(200)` 的 JSON 负载：与官方 Demo 一致，保留完整 `req_params` 外壳并填入本段文本。 */
export function buildTaskRequestPayload(params: SessionParams, text: string): Record<string, unknown> {
  return { ...params.template, event: EventType.TaskRequest, req_params: { ...params.template.req_params, text } };
}

/** 按 Unicode 码点切分长文本，不会截断 Emoji 等 UTF-16 代理对。 */
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

/** 根据服务端错误码与错误文本，归类为结构化错误。 */
export function classifyServerFailure(
  serverCode: number | undefined,
  message: string,
  logId?: string,
): VolcengineTtsError {
  const text = message.toLowerCase();
  const isAuth =
    serverCode === 401 ||
    serverCode === 403 ||
    serverCode === 45000000 ||
    /auth|token|api[-_ ]?key|app[-_ ]?id|forbidden|unauthorized|permission|resource.*not.*allowed|鉴权|密钥|无权限/.test(text);
  if (isAuth) return new VolcengineTtsError("AUTH_FAILED", message, { logId, serverCode });

  const isQuota =
    serverCode === 429 || /quota|rate\s*limit|exceed|concurrency|balance|arrears|额度|欠费|并发|限流/.test(text);
  if (isQuota) return new VolcengineTtsError("QUOTA_EXCEEDED", message, { logId, serverCode });

  return new VolcengineTtsError("PROTOCOL_ERROR", message, { logId, serverCode });
}

/** 从服务端 JSON 负载中提取可读的错误描述。 */
export function extractErrorMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  for (const key of ["message", "error", "err_msg", "status_message", "detail"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 从服务端 JSON 负载中提取 `usage.text_words` 计费字数。 */
export function extractUsageTextWords(payload: Record<string, unknown> | undefined): number | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const words = (usage as Record<string, unknown>).text_words;
  return typeof words === "number" && Number.isFinite(words) ? words : undefined;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
