export type WindowState = {
  isFullScreen: boolean;
};
export type TokenMonitorTarget = { sessionId: string; runId?: string };

/** Serializable window settings available to the renderer. */
export interface OpenWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  x?: number;
  y?: number;
  frame?: boolean;
  transparent?: boolean;
  resizable?: boolean;
  maximizable?: boolean;
  minimizable?: boolean;
  closable?: boolean;
  alwaysOnTop?: boolean;
  fullscreen?: boolean;
  show?: boolean;
  autoHideMenuBar?: boolean;
  bgColor?: string;
}

export interface WindowCreatePayload {
  channelId: string;
  url: string;
  options?: OpenWindowOptions;
}

// Shared data-only contract for the renderer facade and Electron preload.
export interface ElectronApi {
  projectParticles(content: import("./particles").ParticleProjection | null): void;
  particleSettings: import("./particles").ParticleSettingsApi;
  app: { quit(): void };
  window: {
    openWindow(payload: WindowCreatePayload): Promise<boolean>;
    openTokenMonitor(target: TokenMonitorTarget): Promise<boolean>;
    minimize(): void;
    close(): void;
    openDevTools(): Promise<boolean>;
    getState(): Promise<WindowState | null>;
    setFullScreen(fullScreen: boolean): Promise<boolean>;
    onStateChanged(listener: (state: WindowState) => void): () => void;
  };
}
