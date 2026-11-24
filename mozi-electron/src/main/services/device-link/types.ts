export type DeviceLinkDirection = "incoming" | "outgoing";

export type DeviceLinkErrorCode =
  | "EMPTY_PAYLOAD"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "UNSUPPORTED_FRAME_TYPE"
  | "MISSING_TEXT_CONTENT";

export class DeviceLinkProtocolError extends Error {
  readonly code: DeviceLinkErrorCode;

  constructor(code: DeviceLinkErrorCode, message: string) {
    super(message);
    this.name = "DeviceLinkProtocolError";
    this.code = code;
  }
}

export interface DeviceLinkClientInfo {
  readonly clientId: string;
  readonly remoteAddress: string;
  readonly userAgent?: string;
  readonly connectedAt: number;
}

export interface DeviceLinkTextItem {
  readonly id: string;
  readonly type: "text";
  readonly direction: DeviceLinkDirection;
  readonly text: string;
  readonly isLink: boolean;
  readonly url?: string;
  readonly timestamp: number;
  readonly clientId?: string;
  readonly remoteAddress?: string;
}

export interface DeviceLinkDiagnostic {
  readonly level: "info" | "warn" | "error";
  readonly name: string;
  readonly detail?: Record<string, unknown>;
}

export interface DeviceLinkHandlers {
  onTextMessage?: (item: DeviceLinkTextItem, client?: DeviceLinkClientInfo) => void;
  onAudioFrame?: (pcm: Buffer, client: DeviceLinkClientInfo) => void;
  onClientConnected?: (client: DeviceLinkClientInfo) => void;
  onClientDisconnected?: (client: DeviceLinkClientInfo, code: number) => void;
  onDiagnostic?: (diag: DeviceLinkDiagnostic) => void;
}

export interface DeviceLinkConfig {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly maxTextBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly heartbeatMs?: number;
  readonly historyLimit?: number;
  readonly relayBetweenClients?: boolean;
}

export interface DeviceLinkStatus {
  readonly running: boolean;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly lanAddresses: string[];
  readonly wsEndpoints: string[];
  readonly connectedClients: DeviceLinkClientInfo[];
  readonly historyCount: number;
}

export const DEFAULT_DEVICE_LINK_CONFIG: Required<DeviceLinkConfig> = {
  host: "0.0.0.0",
  port: 8080,
  path: "/",
  maxTextBytes: 64 * 1024,
  maxPayloadBytes: 1024 * 1024,
  heartbeatMs: 30_000,
  historyLimit: 100,
  relayBetweenClients: true,
};
