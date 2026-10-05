import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ElectronApi, WindowState } from "../../shared/electron-api";

const electronApi = {
  app: { quit: () => ipcRenderer.send("app:quit") },
  window: {
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
