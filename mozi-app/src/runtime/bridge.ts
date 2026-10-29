import type { ElectronApi, WindowState, TokenMonitorTarget, WindowCreatePayload } from "../../../shared/electron-api";
import { agentApi } from "./agent";

function getElectronApi(): ElectronApi | undefined {
  return (window as Window & { electronAPI?: ElectronApi }).electronAPI;
}

/** The only renderer entry point to preload. Safe to call in a regular browser. */
export const bridgeApi = {
  agent: agentApi,
  get particleSettings() { return getElectronApi()?.particleSettings; },
  get available() {
    return Boolean(getElectronApi());
  },
  window: {
    async openWindow(payload: WindowCreatePayload): Promise<boolean> {
      return getElectronApi()?.window.openWindow?.(payload) ?? false;
    },
    async openTokenMonitor(target: TokenMonitorTarget): Promise<boolean> {
      return getElectronApi()?.window.openTokenMonitor?.(target) ?? false;
    },
    minimize() {
      const api = getElectronApi();
      if (!api) return false;
      api.window.minimize();
      return true;
    },
    close() {
      const api = getElectronApi();
      if (!api) return false;
      api.window.close();
      return true;
    },
    async openDevTools(): Promise<boolean> {
      return getElectronApi()?.window.openDevTools() ?? false;
    },
    async getState(): Promise<WindowState | null> {
      return getElectronApi()?.window.getState() ?? null;
    },
    async setFullScreen(fullScreen: boolean): Promise<boolean> {
      return getElectronApi()?.window.setFullScreen(fullScreen) ?? false;
    },
    onStateChanged(listener: (state: WindowState) => void): () => void {
      return getElectronApi()?.window.onStateChanged(listener) ?? (() => {});
    },
  },
} as const;
