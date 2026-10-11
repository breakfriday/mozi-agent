export type WindowState = {
  isFullScreen: boolean;
};
export type TokenMonitorTarget = { sessionId: string; runId?: string };

// Shared data-only contract for the renderer facade and Electron preload.
export interface ElectronApi {
  app: { quit(): void };
  window: {
    openTokenMonitor(target: TokenMonitorTarget): Promise<boolean>;
    minimize(): void;
    close(): void;
    openDevTools(): Promise<boolean>;
    getState(): Promise<WindowState | null>;
    setFullScreen(fullScreen: boolean): Promise<boolean>;
    onStateChanged(listener: (state: WindowState) => void): () => void;
  };
}
