export const DEVICE_LINK_CHANNELS = {
  getState: "device-link:get-state",
  setEnabled: "device-link:set-enabled",
  saveSettings: "device-link:save-settings",
  openSettings: "device-link:open-settings",
  sendText: "device-link:send-text",
  clearHistory: "device-link:clear-history",
  event: "device-link:event",
} as const;

export interface DeviceLinkSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly path: string;
}

export interface DeviceLinkSettingsSaveInput {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly path?: string;
}

export const DEFAULT_DEVICE_LINK_SETTINGS: DeviceLinkSettings = {
  enabled: false,
  port: 8080,
  path: "/",
};

export interface DeviceLinkPeerView {
  readonly clientId: string;
  readonly remoteAddress: string;
  readonly userAgent?: string;
  readonly connectedAt: number;
}

export interface DeviceLinkMessageView {
  readonly id: string;
  readonly direction: "incoming" | "outgoing";
  readonly text: string;
  readonly isLink: boolean;
  readonly url?: string;
  readonly timestamp: number;
  readonly clientId?: string;
  readonly remoteAddress?: string;
}

export interface DeviceLinkStateView {
  readonly settings: DeviceLinkSettings;
  readonly running: boolean;
  readonly host: string;
  readonly activePort: number;
  readonly path: string;
  readonly lanAddresses: string[];
  readonly wsEndpoints: string[];
  readonly connectedClients: DeviceLinkPeerView[];
  readonly recentMessages: DeviceLinkMessageView[];
  readonly lastError?: string;
}

export type DeviceLinkEvent = {
  readonly type: "stateChanged";
  readonly state: DeviceLinkStateView;
};

export interface DeviceLinkQrPayload {
  readonly app: "mozi-device-link";
  readonly v: 1;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly secure: false;
  readonly ws: string;
}

export interface DeviceLinkBridgeApi {
  getState(): Promise<DeviceLinkStateView>;
  setEnabled(enabled: boolean): Promise<DeviceLinkStateView>;
  saveSettings(input: DeviceLinkSettingsSaveInput): Promise<DeviceLinkStateView>;
  openSettings(): Promise<boolean>;
  sendText(text: string): Promise<{ deliveredCount: number; state: DeviceLinkStateView }>;
  clearHistory(): Promise<DeviceLinkStateView>;
  onEvent(listener: (event: DeviceLinkEvent) => void): () => void;
}

export function normalizeDeviceLinkPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "/") return "/";
  if (/[\s?#]/.test(trimmed)) {
    throw new Error("WebSocket 路径不能包含空格、? 或 #");
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

export function parseDeviceLinkSettings(
  input: unknown,
  fallback: DeviceLinkSettings = DEFAULT_DEVICE_LINK_SETTINGS,
): DeviceLinkSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("无效的互联服务配置格式");
  }
  const raw = input as Record<string, unknown>;

  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled;

  let port = fallback.port;
  if (raw.port !== undefined) {
    const num = typeof raw.port === "number" ? raw.port : Number(raw.port);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new Error("端口号必须是 1–65535 之间的整数");
    }
    port = num;
  }

  let wsPath = fallback.path;
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string") {
      throw new Error("WebSocket 路径必须是字符串");
    }
    wsPath = normalizeDeviceLinkPath(raw.path);
  }

  return {
    enabled,
    port,
    path: wsPath,
  };
}

export function pickPreferredLanIp(addresses: readonly string[]): string {
  if (addresses.length === 0) return "127.0.0.1";
  const private192 = addresses.find((ip) => ip.startsWith("192.168."));
  if (private192) return private192;
  const private10 = addresses.find((ip) => ip.startsWith("10."));
  if (private10) return private10;
  const private172 = addresses.find((ip) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip));
  if (private172) return private172;
  return addresses[0];
}

export function buildDeviceLinkQrPayload(params: {
  host: string;
  port: number;
  path: string;
}): DeviceLinkQrPayload {
  const cleanHost = params.host.trim() || "127.0.0.1";
  const cleanPath = normalizeDeviceLinkPath(params.path || "/");
  const hostBracketed = cleanHost.includes(":") && !cleanHost.startsWith("[") ? `[${cleanHost}]` : cleanHost;
  return {
    app: "mozi-device-link",
    v: 1,
    host: cleanHost,
    port: params.port,
    path: cleanPath,
    secure: false,
    ws: `ws://${hostBracketed}:${params.port}${cleanPath}`,
  };
}
