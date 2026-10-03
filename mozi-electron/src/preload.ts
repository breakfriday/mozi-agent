import { contextBridge, ipcRenderer } from "electron";

const electronApi = {
  app: { quit: () => ipcRenderer.send("app:quit") },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    close: () => ipcRenderer.send("window:close"),
    openDevTools: () => ipcRenderer.invoke("window:open-devtools") as Promise<boolean>,
  },
} as const;

contextBridge.exposeInMainWorld("electronAPI", electronApi);
