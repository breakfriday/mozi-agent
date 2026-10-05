export type WindowState = {
  isFullScreen: boolean;
};

// Shared data-only contract for the renderer facade and Electron preload.
export interface ElectronApi {
  app: { quit(): void };
  window: {
    minimize(): void;
    close(): void;
    openDevTools(): Promise<boolean>;
    getState(): Promise<WindowState | null>;
    setFullScreen(fullScreen: boolean): Promise<boolean>;
    onStateChanged(listener: (state: WindowState) => void): () => void;
  };
}
