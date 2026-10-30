import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ElectronApi, WindowState, TokenMonitorTarget, WindowCreatePayload } from "../../shared/electron-api";
import type { MoziApi } from "../../shared/mozi-api";
import { createAgentPreloadApi } from "./preload/agent";
import { createAgentLogger } from "../../shared/agent/logging";


const electronApi = {
  projectParticles: (content: import("../../shared/particles").ParticleProjection | null) => ipcRenderer.send("particles:project", content),
  particleSettings: {
    get: () => ipcRenderer.invoke("particle-settings:get"),
    save: (settings: import("../../shared/particles").ParticleSettings) => ipcRenderer.invoke("particle-settings:save", settings),
    chooseWallpaper: () => ipcRenderer.invoke("particle-settings:choose"),
  },
  app: { quit: () => ipcRenderer.send("app:quit") },
  window: {
    openWindow: (payload: WindowCreatePayload) => ipcRenderer.invoke("window:open", payload) as Promise<boolean>,
    openTokenMonitor: (target: TokenMonitorTarget) => ipcRenderer.invoke("window:open-token-monitor", target) as Promise<boolean>,
    minimize: () => ipcRenderer.send("window:minimize"),
    close: () => ipcRenderer.send("window:close"),
    openDevTools: () => ipcRenderer.invoke("window:open-devtools") as Promise<boolean>,
    getState: () => ipcRenderer.invoke("window:get-state") as Promise<WindowState | null>,
    setFullScreen: (fullScreen: boolean) => ipcRenderer.invoke("window:set-full-screen", fullScreen) as Promise<boolean>,
    onStateChanged(listener: (state: WindowState) => void) {
      const handler = (_event: IpcRendererEvent, state: WindowState) => {
        if (typeof state?.isFullScreen === "boolean") listener({ isFullScreen: state.isFullScreen });
      };
      ipcRenderer.on("window:state-changed", handler);
      return () => ipcRenderer.removeListener("window:state-changed", handler);
    },
  },
} as const satisfies ElectronApi;

contextBridge.exposeInMainWorld("electronAPI", electronApi);

const agentBridge = createAgentPreloadApi(ipcRenderer);
contextBridge.exposeInMainWorld("mozi", { agent: agentBridge.api } satisfies MoziApi);
createAgentLogger("preload").info("bridge.exposed");
