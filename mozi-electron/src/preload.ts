import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ElectronApi, WindowState, TokenMonitorTarget, SessionViewerTarget, WindowCreatePayload } from "../../shared/electron-api";
import type { MoziApi } from "../../shared/mozi-api";
import { TTS_CHANNELS, type TtsCommand, type TtsEvent, type TtsSettingsSaveInput, type TtsSettingsView } from "../../shared/tts";
import { createAgentPreloadApi } from "./preload/agent";
import { createAgentLogger } from "../../shared/agent/logging";

function isTtsEvent(value: unknown): value is TtsEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.type !== "string") return false;
  if (e.type === "audio") {
    return typeof e.utteranceId === "string" && e.pcm instanceof Uint8Array && typeof e.sampleRate === "number";
  }
  if (e.type === "error") {
    return typeof e.code === "string" && typeof e.message === "string";
  }
  return (
    ["started", "sentenceStart", "sentenceEnd", "finished", "cancelled"].includes(e.type) &&
    typeof e.utteranceId === "string"
  );
}

const electronApi = {
  projectParticles: (content: import("../../shared/particles").ParticleProjection | null) => ipcRenderer.send("particles:project", content),
  particleSettings: {
    get: () => ipcRenderer.invoke("particle-settings:get"),
    save: (settings: import("../../shared/particles").ParticleSettings) => ipcRenderer.invoke("particle-settings:save", settings),
    chooseWallpaper: () => ipcRenderer.invoke("particle-settings:choose"),
  },
  tts: {
    getState: () => ipcRenderer.invoke(TTS_CHANNELS.getState) as Promise<TtsSettingsView>,
    saveSettings: (input: TtsSettingsSaveInput) => ipcRenderer.invoke(TTS_CHANNELS.saveSettings, input) as Promise<TtsSettingsView>,
    openSettings: () => ipcRenderer.invoke(TTS_CHANNELS.openSettings) as Promise<boolean>,
    sendCommand: (command: TtsCommand) => ipcRenderer.send(TTS_CHANNELS.command, command),
    onEvent(listener: (event: TtsEvent) => void) {
      const handler = (_event: IpcRendererEvent, payload: unknown) => {
        if (isTtsEvent(payload)) listener(payload);
      };
      ipcRenderer.on(TTS_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(TTS_CHANNELS.event, handler);
    },
  },
  app: { quit: () => ipcRenderer.send("app:quit") },
  window: {
    openWindow: (payload: WindowCreatePayload) => ipcRenderer.invoke("window:open", payload) as Promise<boolean>,
    openTokenMonitor: (target: TokenMonitorTarget) => ipcRenderer.invoke("window:open-token-monitor", target) as Promise<boolean>,
    openSessionViewer: (target?: SessionViewerTarget) => ipcRenderer.invoke("window:open-session-viewer", target) as Promise<boolean>,
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
