import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TTS_SETTINGS,
  parseTtsSettings,
  parseTtsSettingsSaveInput,
  resolveVolcModelOption,
  TTS_PROVIDER_CATALOG,
  type TtsSettings,
  type TtsSettingsSaveInput,
  type TtsSettingsView,
} from "../../../../shared/tts";
import type { VolcengineTtsConfig, VolcengineTtsStreamOptions } from "../services/volcengine";

interface StoredVolcCredentials {
  apiKey?: string;
  appId?: string;
  accessKey?: string;
}

interface StoredTtsAuthFile {
  volcengine?: StoredVolcCredentials;
}

export class TtsSettingsStore {
  private readonly settingsPath: string;
  private readonly authPath: string;
  private settings: TtsSettings;
  private auth: StoredTtsAuthFile;

  constructor(userDataDir: string) {
    this.settingsPath = path.join(userDataDir, "tts-settings.json");
    this.authPath = path.join(userDataDir, "tts-auth.json");
    this.settings = this.loadSettings();
    this.auth = this.loadAuth();
  }

  getView(): TtsSettingsView {
    const volcSettings = this.settings.providers.volcengine;
    const volcCreds = this.auth.volcengine ?? {};
    const hasApiKey = Boolean(volcCreds.apiKey);
    const hasLegacyApp = Boolean(volcCreds.appId && volcCreds.accessKey);
    const configured = volcSettings.authMode === "api_key" ? hasApiKey : hasLegacyApp;

    return {
      settings: structuredClone(this.settings),
      credentials: {
        volcengine: {
          configured,
          hasApiKey,
          hasLegacyApp,
          ...(volcCreds.appId ? { appId: volcCreds.appId } : {}),
        },
      },
      catalog: TTS_PROVIDER_CATALOG,
    };
  }

  save(rawInput: unknown): TtsSettingsView {
    const input: TtsSettingsSaveInput = parseTtsSettingsSaveInput(rawInput);
    this.settings = input.settings;
    this.writeSettings(this.settings);

    if (input.credentials?.volcengine) {
      const patch = input.credentials.volcengine;
      const next: StoredVolcCredentials = { ...this.auth.volcengine };
      if (patch.apiKey !== undefined) {
        if (patch.apiKey) next.apiKey = patch.apiKey;
        else delete next.apiKey;
      }
      if (patch.appId !== undefined) {
        if (patch.appId) next.appId = patch.appId;
        else delete next.appId;
      }
      if (patch.accessKey !== undefined) {
        if (patch.accessKey) next.accessKey = patch.accessKey;
        else delete next.accessKey;
      }
      this.auth = { ...this.auth, volcengine: next };
      this.writeAuthAtomically(this.auth);
    }

    return this.getView();
  }

  /** 将当前持久化的配置与凭据转换为 `VolcengineTtsService` 运行时配置。 */
  toVolcengineConfig(): VolcengineTtsConfig {
    const v = this.settings.providers.volcengine;
    const creds = this.auth.volcengine ?? {};
    const { resourceId } = resolveVolcModelOption(v.modelId);

    return {
      endpoint: v.endpoint,
      resourceId,
      ...(v.authMode === "api_key"
        ? { apiKey: creds.apiKey ?? "", appId: "", accessKey: "" }
        : { apiKey: "", appId: creds.appId ?? "", accessKey: creds.accessKey ?? "" }),
      speaker: v.speaker,
      dialect: v.dialect || undefined,
      format: "pcm",
      sampleRate: 24000,
      speechRate: v.speechRate,
      loudnessRate: v.loudnessRate,
      pitch: v.pitch,
      defaultContextText: v.defaultContextText || undefined,
      enableCache: v.enableCache,
    };
  }

  /** 获取当前所选模型的附加单次合成选项（如声音复刻 2.0 的 `standard` / `expressive` 子模型）。 */
  defaultStreamOptions(): Pick<VolcengineTtsStreamOptions, "model"> {
    const { subModel } = resolveVolcModelOption(this.settings.providers.volcengine.modelId);
    return subModel ? { model: subModel } : {};
  }

  private loadSettings(): TtsSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULT_TTS_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      return parseTtsSettings(parsed);
    } catch {
      return structuredClone(DEFAULT_TTS_SETTINGS);
    }
  }

  private loadAuth(): StoredTtsAuthFile {
    if (!existsSync(this.authPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf8")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const vc = parsed.volcengine;
      if (!vc || typeof vc !== "object" || Array.isArray(vc)) return {};
      const v = vc as Record<string, unknown>;
      return {
        volcengine: {
          ...(typeof v.apiKey === "string" && v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}),
          ...(typeof v.appId === "string" && v.appId.trim() ? { appId: v.appId.trim() } : {}),
          ...(typeof v.accessKey === "string" && v.accessKey.trim() ? { accessKey: v.accessKey.trim() } : {}),
        },
      };
    } catch {
      return {};
    }
  }

  private writeSettings(settings: TtsSettings): void {
    mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  /** `0600` 权限临时文件原子落盘，与 `CredentialRepository` 保持一致。 */
  private writeAuthAtomically(auth: StoredTtsAuthFile): void {
    mkdirSync(path.dirname(this.authPath), { recursive: true });
    const temp = `${this.authPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(auth, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.authPath);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}
