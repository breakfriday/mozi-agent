import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { createAgentLogger } from "../../../../shared/agent/logging";
import {
  parseTtsCommand,
  TTS_CHANNELS,
  type TtsCommand,
  type TtsEvent,
} from "../../../../shared/tts";
import type { RendererEntry } from "../../env_config.types";
import {
  VolcengineTtsService,
  type VolcengineTtsDependencies,
  type VolcengineTtsStream,
} from "../services/volcengine";
import type { WindowService } from "../services/window.service";
import { TtsSettingsStore } from "./settings";

const log = createAgentLogger("main");

interface ActiveUtterance {
  utteranceId: string;
  stream: VolcengineTtsStream;
  webContents: WebContents;
  detachWindowDestroy: () => void;
}

export interface InstallTtsServiceOptions {
  windows: Pick<WindowService, "createWindow" | "getWindowForWebContents">;
  entry: RendererEntry;
  userDataDir: string;
  ttsDependencies?: Omit<VolcengineTtsDependencies, "onDiagnostic">;
}

export function installTtsService({
  windows,
  entry,
  userDataDir,
  ttsDependencies,
}: InstallTtsServiceOptions) {
  const store = new TtsSettingsStore(userDataDir);

  // 全局常驻单例：启动零联网；内部 WebSocket 空闲 60s 自动挂断并在下次请求时透明重连
  const tts = new VolcengineTtsService(store.toVolcengineConfig(), {
    ...ttsDependencies,
    onDiagnostic: (diag) => {
      log[diag.level](diag.name, undefined, diag.detail);
    },
  });

  let settingsWindow: BrowserWindow | undefined;
  let active: ActiveUtterance | undefined;

  const authorize = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow => {
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("TTS IPC only accepts main-frame callers");
    }
    const win = windows.getWindowForWebContents(event.sender);
    if (!win) {
      throw new Error("Untrusted TTS IPC caller window");
    }
    return win;
  };

  const sendEvent = (target: WebContents, payload: TtsEvent): void => {
    if (target.isDestroyed()) return;
    target.send(TTS_CHANNELS.event, payload);
  };

  const releaseActiveIfMatch = (utteranceId: string): void => {
    if (active?.utteranceId !== utteranceId) return;
    active.detachWindowDestroy();
    active = undefined;
  };

  const openSettings = (): void => {
    const destination: RendererEntry =
      entry.type === "file"
        ? { ...entry, hash: "/ttsSettings" }
        : {
            type: "url",
            url: new URL(
              "ttsSettings",
              entry.url.endsWith("/") ? entry.url : `${entry.url}/`,
            ).href,
          };
    const existing = settingsWindow;
    settingsWindow = windows.createWindow("tts-settings", destination, {
      title: "语音合成（TTS）配置与测试",
      width: 820,
      height: 780,
      minWidth: 640,
      minHeight: 620,
    });
    if (!existing || existing.isDestroyed()) {
      settingsWindow.once("closed", () => {
        settingsWindow = undefined;
      });
    }
  };

  const launchUtterance = (
    sender: WebContents,
    cmd: Extract<TtsCommand, { type: "start" | "speak" }>,
  ): void => {
    const { utteranceId, sessionKey, contextText } = cmd;
    // 新流即将抢占旧流：先解绑旧窗口的 destroyed 钩子，旧流本身的 onCancel 会由 tts 内部同步触发
    if (active) {
      active.detachWindowDestroy();
      active = undefined;
    }

    const baseOpts = store.defaultStreamOptions();
    const stream = tts.startStream(
      {
        ...baseOpts,
        ...(sessionKey ? { sessionKey } : {}),
        ...(contextText ? { contextText } : {}),
      },
      {
        onStarted: ({ logId }) => {
          sendEvent(sender, { type: "started", utteranceId, ...(logId ? { logId } : {}) });
        },
        onAudio: (pcm, meta) => {
          sendEvent(sender, {
            type: "audio",
            utteranceId,
            pcm,
            sampleRate: meta.sampleRate,
          });
        },
        onSentenceStart: ({ text }) => {
          sendEvent(sender, { type: "sentenceStart", utteranceId, ...(text ? { text } : {}) });
        },
        onSentenceEnd: ({ text }) => {
          sendEvent(sender, { type: "sentenceEnd", utteranceId, ...(text ? { text } : {}) });
        },
        onComplete: ({ audioBytes, textWords, logId }) => {
          releaseActiveIfMatch(utteranceId);
          sendEvent(sender, {
            type: "finished",
            utteranceId,
            audioBytes,
            ...(textWords !== undefined ? { textWords } : {}),
            ...(logId ? { logId } : {}),
          });
        },
        onCancel: () => {
          releaseActiveIfMatch(utteranceId);
          sendEvent(sender, { type: "cancelled", utteranceId });
        },
        onError: (err) => {
          releaseActiveIfMatch(utteranceId);
          sendEvent(sender, {
            type: "error",
            utteranceId,
            code: err.code,
            message: err.message,
            ...(err.logId ? { logId: err.logId } : {}),
          });
        },
      },
    );

    const onWindowDestroyed = () => {
      if (active?.utteranceId === utteranceId) {
        active = undefined;
        stream.cancel();
      }
    };
    sender.once("destroyed", onWindowDestroyed);
    const detachWindowDestroy = () => {
      sender.removeListener("destroyed", onWindowDestroyed);
    };

    if (stream.active) {
      active = { utteranceId, stream, webContents: sender, detachWindowDestroy };
    } else {
      detachWindowDestroy();
    }

    if (cmd.type === "speak") {
      stream.write(cmd.text);
      stream.finish();
    }
  };

  const onCommand = (event: IpcMainEvent, rawCommand: unknown): void => {
    try {
      authorize(event);
    } catch {
      return;
    }

    let cmd: TtsCommand;
    try {
      cmd = parseTtsCommand(rawCommand);
    } catch (err) {
      sendEvent(event.sender, {
        type: "error",
        code: "INVALID_ARGUMENT",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    switch (cmd.type) {
      case "start":
      case "speak":
        launchUtterance(event.sender, cmd);
        return;
      case "delta":
        if (active?.utteranceId === cmd.utteranceId && active.webContents === event.sender) {
          active.stream.write(cmd.text);
        }
        return;
      case "finish":
        if (active?.utteranceId === cmd.utteranceId && active.webContents === event.sender) {
          active.stream.finish();
        }
        return;
      case "cancel":
        if (!cmd.utteranceId) {
          tts.cancelCurrent();
        } else if (active?.utteranceId === cmd.utteranceId) {
          active.stream.cancel();
        }
        return;
    }
  };

  ipcMain.handle(TTS_CHANNELS.getState, (event) => {
    authorize(event);
    return store.getView();
  });

  ipcMain.handle(TTS_CHANNELS.saveSettings, (event, input: unknown) => {
    authorize(event);
    const view = store.save(input);
    tts.configure(store.toVolcengineConfig());
    return view;
  });

  ipcMain.handle(TTS_CHANNELS.openSettings, (event) => {
    authorize(event);
    openSettings();
    return true;
  });

  ipcMain.on(TTS_CHANNELS.command, onCommand);

  return {
    openSettings,
    stop() {
      tts.cancelCurrent();
    },
    dispose() {
      if (active) {
        active.detachWindowDestroy();
        active = undefined;
      }
      ipcMain.removeHandler(TTS_CHANNELS.getState);
      ipcMain.removeHandler(TTS_CHANNELS.saveSettings);
      ipcMain.removeHandler(TTS_CHANNELS.openSettings);
      ipcMain.removeListener(TTS_CHANNELS.command, onCommand);
      settingsWindow?.close();
      tts.dispose();
    },
  };
}
