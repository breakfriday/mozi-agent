export const TTS_PROVIDER_IDS = ["volcengine"] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export const TTS_VOLC_AUTH_MODES = ["api_key", "legacy_app"] as const;
export type TtsVolcAuthMode = (typeof TTS_VOLC_AUTH_MODES)[number];

export const TTS_VOLC_DIALECT_IDS = [
  "yue",
  "sichuan",
  "dongbei",
  "shanghai",
  "beijing",
  "tianjin",
  "shaanxi",
  "henan",
] as const;
export type TtsVolcDialect = (typeof TTS_VOLC_DIALECT_IDS)[number];

export type TtsErrorCode =
  | "UNCONFIGURED"
  | "INVALID_ARGUMENT"
  | "AUTH_FAILED"
  | "QUOTA_EXCEEDED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "PROTOCOL_ERROR";

export interface TtsEndpointPreset {
  id: string;
  label: string;
  endpoint: string;
}

export interface TtsModelOption {
  id: string;
  name: string;
  resourceId: string;
  subModel?: "seed-tts-2.0-standard" | "seed-tts-2.0-expressive";
  description: string;
}

export interface TtsSpeakerPreset {
  id: string;
  label: string;
  tag: string;
}

export interface TtsDialectOption {
  id: TtsVolcDialect | "";
  label: string;
}

export interface TtsProviderDescriptor {
  id: TtsProviderId;
  name: string;
  description: string;
  endpointPresets: readonly TtsEndpointPreset[];
  models: readonly TtsModelOption[];
  presetSpeakers: readonly TtsSpeakerPreset[];
  dialects: readonly TtsDialectOption[];
}

export const DEFAULT_VOLC_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection";
export const STANDARD_VOLC_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
export const DEFAULT_VOLC_MODEL_ID = "seed-tts-2.0";
export const DEFAULT_VOLC_SPEAKER = "zh_female_vv_uranus_bigtts";

export const TTS_PROVIDER_CATALOG: readonly TtsProviderDescriptor[] = [
  {
    id: "volcengine",
    name: "火山引擎 · 豆包语音",
    description: "火山引擎 V3 双向流式 WebSocket 语音合成服务（支持边发文字边收 24kHz PCM 音频）",
    endpointPresets: [
      {
        id: "ark_plan",
        label: "火山方舟 Agent Plan（默认推荐）",
        endpoint: DEFAULT_VOLC_ENDPOINT,
      },
      {
        id: "openspeech_standard",
        label: "豆包语音标准控制台",
        endpoint: STANDARD_VOLC_ENDPOINT,
      },
    ],
    models: [
      {
        id: "seed-tts-2.0",
        name: "豆包语音合成模型 2.0 (seed-tts-2.0)",
        resourceId: "seed-tts-2.0",
        description: "官方主力大模型音色池，支持跨句自然韵律、中英混读与语气指令",
      },
      {
        id: "seed-icl-2.0-expressive",
        name: "声音复刻 2.0 · 表现力版 (seed-icl-2.0)",
        resourceId: "seed-icl-2.0",
        subModel: "seed-tts-2.0-expressive",
        description: "复刻专属音色并支持 context_texts 语气指令（需填入复刻音色 ID）",
      },
      {
        id: "seed-icl-2.0-standard",
        name: "声音复刻 2.0 · 标准低时延版 (seed-icl-2.0)",
        resourceId: "seed-icl-2.0",
        subModel: "seed-tts-2.0-standard",
        description: "复刻专属音色标准合成，首包响应更快（需填入复刻音色 ID）",
      },
    ],
    presetSpeakers: [
      { id: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0", tag: "通用温暖女声 · 多语种/方言" },
      { id: "zh_female_xiaohe_uranus_bigtts", label: "小何 2.0", tag: "自然亲切女声" },
      { id: "zh_male_m191_uranus_bigtts", label: "云舟 2.0", tag: "沉稳磁性男声" },
      { id: "zh_male_taocheng_uranus_bigtts", label: "小天 2.0", tag: "阳光青年男声" },
    ],
    dialects: [
      { id: "", label: "默认（标准普通话 / 自动识别语种）" },
      { id: "yue", label: "粤语 (yue)" },
      { id: "sichuan", label: "四川话 (sichuan)" },
      { id: "dongbei", label: "东北话 (dongbei)" },
      { id: "shanghai", label: "上海话 (shanghai)" },
      { id: "beijing", label: "北京话 (beijing)" },
      { id: "tianjin", label: "天津话 (tianjin)" },
      { id: "shaanxi", label: "陕西话 (shaanxi)" },
      { id: "henan", label: "河南话 (henan)" },
    ],
  },
] as const;

export interface TtsVolcengineProviderSettings {
  authMode: TtsVolcAuthMode;
  endpoint: string;
  modelId: string;
  speaker: string;
  dialect: TtsVolcDialect | "";
  speechRate: number;
  loudnessRate: number;
  pitch: number;
  defaultContextText: string;
  enableCache: boolean;
}

export interface TtsSettings {
  activeProviderId: TtsProviderId;
  providers: {
    volcengine: TtsVolcengineProviderSettings;
  };
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  activeProviderId: "volcengine",
  providers: {
    volcengine: {
      authMode: "api_key",
      endpoint: DEFAULT_VOLC_ENDPOINT,
      modelId: DEFAULT_VOLC_MODEL_ID,
      speaker: DEFAULT_VOLC_SPEAKER,
      dialect: "",
      speechRate: 0,
      loudnessRate: 0,
      pitch: 0,
      defaultContextText: "",
      enableCache: false,
    },
  },
};

export interface TtsVolcengineCredentialStatus {
  configured: boolean;
  hasApiKey: boolean;
  hasLegacyApp: boolean;
  appId?: string;
}

export interface TtsSettingsView {
  settings: TtsSettings;
  credentials: {
    volcengine: TtsVolcengineCredentialStatus;
  };
  catalog: readonly TtsProviderDescriptor[];
}

/**
 * 保存输入契约：
 * - `credentials.volcengine.apiKey / appId / accessKey` 为 Write-only：
 *   传 `undefined` 表示保留原密钥不变；传 `""`（空串）表示清除；传非空字符串表示覆盖更新。
 */
export interface TtsSettingsSaveInput {
  settings: TtsSettings;
  credentials?: {
    volcengine?: {
      apiKey?: string;
      appId?: string;
      accessKey?: string;
    };
  };
}

export type TtsCommand =
  | { type: "start"; utteranceId: string; sessionKey?: string; contextText?: string }
  | { type: "delta"; utteranceId: string; text: string }
  | { type: "finish"; utteranceId: string }
  | { type: "speak"; utteranceId: string; text: string; sessionKey?: string; contextText?: string }
  | { type: "cancel"; utteranceId?: string };

export type TtsEvent =
  | { type: "started"; utteranceId: string; logId?: string }
  | { type: "audio"; utteranceId: string; pcm: Uint8Array; sampleRate: number }
  | { type: "sentenceStart"; utteranceId: string; text?: string }
  | { type: "sentenceEnd"; utteranceId: string; text?: string }
  | { type: "finished"; utteranceId: string; audioBytes: number; textWords?: number; logId?: string }
  | { type: "cancelled"; utteranceId: string }
  | { type: "error"; utteranceId?: string; code: TtsErrorCode; message: string; logId?: string };

export interface TtsBridgeApi {
  getState(): Promise<TtsSettingsView>;
  saveSettings(input: TtsSettingsSaveInput): Promise<TtsSettingsView>;
  openSettings(): Promise<boolean>;
  sendCommand(command: TtsCommand): void;
  onEvent(listener: (event: TtsEvent) => void): () => void;
}

export const TTS_CHANNELS = {
  getState: "tts-settings:get",
  saveSettings: "tts-settings:save",
  openSettings: "tts-settings:open",
  command: "tts:command",
  event: "tts:event",
} as const;

export function resolveVolcModelOption(modelId: string): {
  modelId: string;
  resourceId: string;
  subModel?: "seed-tts-2.0-standard" | "seed-tts-2.0-expressive";
} {
  const volc = TTS_PROVIDER_CATALOG.find((item) => item.id === "volcengine")!;
  const matched = volc.models.find((m) => m.id === modelId);
  if (matched) {
    return { modelId: matched.id, resourceId: matched.resourceId, subModel: matched.subModel };
  }
  const trimmed = modelId.trim() || DEFAULT_VOLC_MODEL_ID;
  return { modelId: trimmed, resourceId: trimmed };
}

export function parseTtsSettings(value: unknown): TtsSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid TTS settings");
  }
  const root = value as Record<string, unknown>;
  if (!TTS_PROVIDER_IDS.includes(root.activeProviderId as TtsProviderId)) {
    throw new Error("Unsupported TTS provider");
  }
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("Missing TTS provider settings");
  }
  const volc = (providers as Record<string, unknown>).volcengine;
  if (!volc || typeof volc !== "object" || Array.isArray(volc)) {
    throw new Error("Missing Volcengine TTS settings");
  }
  const v = volc as Record<string, unknown>;
  if (!TTS_VOLC_AUTH_MODES.includes(v.authMode as TtsVolcAuthMode)) {
    throw new Error("Invalid Volcengine authMode");
  }
  const endpoint = expectBoundedString(v.endpoint, "endpoint", 1, 1024).trim();
  const modelId = expectBoundedString(v.modelId, "modelId", 1, 128).trim();
  const speaker = expectBoundedString(v.speaker, "speaker", 1, 256).trim();
  const rawDialect = v.dialect === undefined ? "" : v.dialect;
  if (rawDialect !== "" && !TTS_VOLC_DIALECT_IDS.includes(rawDialect as TtsVolcDialect)) {
    throw new Error("Invalid Volcengine dialect");
  }
  const defaultContextText = expectBoundedString(v.defaultContextText ?? "", "defaultContextText", 0, 500).trim();
  const enableCache = v.enableCache === undefined ? false : expectBoolean(v.enableCache, "enableCache");
  const speechRate = expectRangeInt(v.speechRate, "speechRate", -50, 100);
  const loudnessRate = expectRangeInt(v.loudnessRate, "loudnessRate", -50, 100);
  const pitch = expectRangeInt(v.pitch, "pitch", -12, 12);

  return {
    activeProviderId: root.activeProviderId as TtsProviderId,
    providers: {
      volcengine: {
        authMode: v.authMode as TtsVolcAuthMode,
        endpoint,
        modelId,
        speaker,
        dialect: rawDialect as TtsVolcDialect | "",
        speechRate,
        loudnessRate,
        pitch,
        defaultContextText,
        enableCache,
      },
    },
  };
}

export function parseTtsSettingsSaveInput(value: unknown): TtsSettingsSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid TTS save payload");
  }
  const raw = value as Record<string, unknown>;
  const settings = parseTtsSettings(raw.settings);
  if (raw.credentials === undefined) return { settings };

  if (!raw.credentials || typeof raw.credentials !== "object" || Array.isArray(raw.credentials)) {
    throw new Error("Invalid TTS credentials payload");
  }
  const credsObj = raw.credentials as Record<string, unknown>;
  if (credsObj.volcengine === undefined) return { settings };

  if (!credsObj.volcengine || typeof credsObj.volcengine !== "object" || Array.isArray(credsObj.volcengine)) {
    throw new Error("Invalid Volcengine credentials payload");
  }
  const vc = credsObj.volcengine as Record<string, unknown>;
  const apiKey = optionalSecret(vc.apiKey, "apiKey");
  const appId = optionalSecret(vc.appId, "appId");
  const accessKey = optionalSecret(vc.accessKey, "accessKey");

  return {
    settings,
    credentials: {
      volcengine: {
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(appId !== undefined ? { appId } : {}),
        ...(accessKey !== undefined ? { accessKey } : {}),
      },
    },
  };
}

export function parseTtsCommand(value: unknown): TtsCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid TTS command");
  }
  const cmd = value as Record<string, unknown>;
  switch (cmd.type) {
    case "start": {
      const utteranceId = expectId(cmd.utteranceId, "utteranceId");
      const sessionKey = cmd.sessionKey === undefined ? undefined : expectId(cmd.sessionKey, "sessionKey");
      const contextText =
        cmd.contextText === undefined
          ? undefined
          : expectBoundedString(cmd.contextText, "contextText", 0, 500).trim() || undefined;
      return {
        type: "start",
        utteranceId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(contextText ? { contextText } : {}),
      };
    }
    case "delta": {
      const utteranceId = expectId(cmd.utteranceId, "utteranceId");
      const text = expectBoundedString(cmd.text, "text", 0, 50_000);
      return { type: "delta", utteranceId, text };
    }
    case "finish": {
      const utteranceId = expectId(cmd.utteranceId, "utteranceId");
      return { type: "finish", utteranceId };
    }
    case "speak": {
      const utteranceId = expectId(cmd.utteranceId, "utteranceId");
      const text = expectBoundedString(cmd.text, "text", 1, 50_000);
      const sessionKey = cmd.sessionKey === undefined ? undefined : expectId(cmd.sessionKey, "sessionKey");
      const contextText =
        cmd.contextText === undefined
          ? undefined
          : expectBoundedString(cmd.contextText, "contextText", 0, 500).trim() || undefined;
      return {
        type: "speak",
        utteranceId,
        text,
        ...(sessionKey ? { sessionKey } : {}),
        ...(contextText ? { contextText } : {}),
      };
    }
    case "cancel": {
      const utteranceId = cmd.utteranceId === undefined ? undefined : expectId(cmd.utteranceId, "utteranceId");
      return { type: "cancel", ...(utteranceId ? { utteranceId } : {}) };
    }
    default:
      throw new Error(`Unsupported TTS command type: ${String(cmd.type)}`);
  }
}

function expectId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || [...trimmed].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new Error(`Invalid ${field}`);
  }
  return trimmed;
}

function expectBoundedString(value: unknown, field: string, minLen: number, maxLen: number): string {
  if (typeof value !== "string" || value.length < minLen || value.length > maxLen) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function expectRangeInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw new Error(`Out of range ${field}`);
  }
  return rounded;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function optionalSecret(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error(`Invalid ${field}`);
  }
  return value.trim();
}
