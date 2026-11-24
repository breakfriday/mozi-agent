import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DEVICE_LINK_SETTINGS,
  parseDeviceLinkSettings,
  type DeviceLinkSettings,
  type DeviceLinkSettingsSaveInput,
} from "../../../../shared/device-link";

export class DeviceLinkSettingsStore {
  private readonly filePath: string;
  private current: DeviceLinkSettings;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "device-link-settings.json");
    this.current = this.loadFromDisk();
  }

  private loadFromDisk(): DeviceLinkSettings {
    if (!fs.existsSync(this.filePath)) {
      return { ...DEFAULT_DEVICE_LINK_SETTINGS, enabled: false };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      const parsed = parseDeviceLinkSettings(raw, DEFAULT_DEVICE_LINK_SETTINGS);
      // 服务启动默认保持关闭，仅恢复持久化的端口与路径配置
      return { ...parsed, enabled: false };
    } catch {
      return { ...DEFAULT_DEVICE_LINK_SETTINGS, enabled: false };
    }
  }

  get(): DeviceLinkSettings {
    return { ...this.current };
  }

  setEnabled(enabled: boolean): DeviceLinkSettings {
    this.current = { ...this.current, enabled };
    return this.get();
  }

  save(input: DeviceLinkSettingsSaveInput): DeviceLinkSettings {
    const next = parseDeviceLinkSettings(
      {
        enabled: input.enabled ?? this.current.enabled,
        port: input.port ?? this.current.port,
        path: input.path ?? this.current.path,
      },
      this.current,
    );
    this.current = next;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ port: next.port, path: next.path }, null, 2),
      "utf8",
    );
    return this.get();
  }
}
