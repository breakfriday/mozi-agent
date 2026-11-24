import {
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { createAgentLogger } from "../../../../shared/agent/logging";
import {
  DEVICE_LINK_CHANNELS,
  type DeviceLinkEvent,
  type DeviceLinkSettingsSaveInput,
  type DeviceLinkStateView,
} from "../../../../shared/device-link";
import type { RendererEntry } from "../../env_config.types";
import {
  DeviceLinkService,
  type DeviceLinkConfig,
  type DeviceLinkHandlers,
} from "../services/device-link";
import type { WindowService } from "../services/window.service";
import { DeviceLinkSettingsStore } from "./settings";

const log = createAgentLogger("main");

export interface InstallDeviceLinkServiceOptions {
  windows: Pick<WindowService, "createWindow" | "getWindowForWebContents">;
  entry: RendererEntry;
  userDataDir: string;
  createService?: (config: DeviceLinkConfig, handlers: DeviceLinkHandlers) => DeviceLinkService;
}

export function installDeviceLinkService({
  windows,
  entry,
  userDataDir,
  createService,
}: InstallDeviceLinkServiceOptions) {
  const store = new DeviceLinkSettingsStore(userDataDir);
  const subscribers = new Set<WebContents>();
  let settingsWindow: BrowserWindow | undefined;
  let lastError: string | undefined;

  const initial = store.get();
  const handlers: DeviceLinkHandlers = {
    onTextMessage: (item, client) => {
      log.info("device_link.text.received", {
        id: item.id,
        isLink: String(item.isLink),
        clientId: client?.clientId ?? "http",
      });
      broadcastState();
    },
    onClientConnected: () => {
      broadcastState();
    },
    onClientDisconnected: () => {
      broadcastState();
    },
    onDiagnostic: (diag) => {
      log[diag.level](diag.name, undefined, diag.detail);
    },
  };

  const service = createService
    ? createService({ port: initial.port, path: initial.path }, handlers)
    : new DeviceLinkService({ port: initial.port, path: initial.path }, handlers);

  const buildStateView = (): DeviceLinkStateView => {
    const status = service.getStatus();
    const settings = store.get();
    return {
      settings: {
        ...settings,
        enabled: status.running,
      },
      running: status.running,
      host: status.host,
      activePort: status.port,
      path: status.path,
      lanAddresses: status.lanAddresses,
      wsEndpoints: status.wsEndpoints,
      connectedClients: status.connectedClients,
      recentMessages: service.getHistory().slice(0, 30).map((item) => ({
        id: item.id,
        direction: item.direction,
        text: item.text,
        isLink: item.isLink,
        ...(item.url ? { url: item.url } : {}),
        timestamp: item.timestamp,
        ...(item.clientId ? { clientId: item.clientId } : {}),
        ...(item.remoteAddress ? { remoteAddress: item.remoteAddress } : {}),
      })),
      ...(lastError ? { lastError } : {}),
    };
  };

  const trackSubscriber = (sender: WebContents): void => {
    if (subscribers.has(sender) || sender.isDestroyed()) return;
    subscribers.add(sender);
    sender.once("destroyed", () => {
      subscribers.delete(sender);
    });
  };

  const broadcastState = (): void => {
    if (subscribers.size === 0) return;
    const payload: DeviceLinkEvent = {
      type: "stateChanged",
      state: buildStateView(),
    };
    for (const target of subscribers) {
      if (target.isDestroyed()) {
        subscribers.delete(target);
        continue;
      }
      target.send(DEVICE_LINK_CHANNELS.event, payload);
    }
  };

  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("DeviceLink IPC only accepts main-frame callers");
    }
    const win = windows.getWindowForWebContents(event.sender);
    if (!win) {
      throw new Error("Untrusted DeviceLink IPC caller window");
    }
    trackSubscriber(event.sender);
    return win;
  };

  const applyEnabled = async (enabled: boolean): Promise<DeviceLinkStateView> => {
    if (!enabled) {
      await service.stop();
      store.setEnabled(false);
      lastError = undefined;
      const view = buildStateView();
      broadcastState();
      return view;
    }

    const cfg = store.get();
    try {
      await service.start({ host: "0.0.0.0", port: cfg.port, path: cfg.path });
      store.setEnabled(true);
      lastError = undefined;
    } catch (err) {
      store.setEnabled(false);
      lastError = err instanceof Error ? err.message : String(err);
      log.error("device_link.start.failed", undefined, { message: lastError });
    }
    const view = buildStateView();
    broadcastState();
    return view;
  };

  const saveAndApply = async (rawInput: unknown): Promise<DeviceLinkStateView> => {
    const prev = store.get();
    const wasRunning = service.getStatus().running;
    const next = store.save((rawInput ?? {}) as DeviceLinkSettingsSaveInput);
    const shouldRun =
      typeof (rawInput as DeviceLinkSettingsSaveInput | undefined)?.enabled === "boolean"
        ? next.enabled
        : wasRunning;

    if (!shouldRun) {
      if (wasRunning) {
        await service.stop();
      }
      store.setEnabled(false);
      lastError = undefined;
      const view = buildStateView();
      broadcastState();
      return view;
    }

    const configChanged = next.port !== prev.port || next.path !== prev.path || !wasRunning;
    if (configChanged) {
      try {
        await service.start({ host: "0.0.0.0", port: next.port, path: next.path });
        store.setEnabled(true);
        lastError = undefined;
      } catch (err) {
        store.setEnabled(false);
        lastError = err instanceof Error ? err.message : String(err);
        log.error("device_link.reconfigure.failed", undefined, { message: lastError });
      }
    }

    const view = buildStateView();
    broadcastState();
    return view;
  };

  const openSettings = (): void => {
    const destination: RendererEntry =
      entry.type === "file"
        ? { ...entry, hash: "/deviceLinkSettings" }
        : {
            type: "url",
            url: new URL(
              "deviceLinkSettings",
              entry.url.endsWith("/") ? entry.url : `${entry.url}/`,
            ).href,
          };
    const existing = settingsWindow;
    settingsWindow = windows.createWindow("device-link-settings", destination, {
      title: "互联服务配置",
      width: 840,
      height: 760,
      minWidth: 660,
      minHeight: 600,
    });
    if (!existing || existing.isDestroyed()) {
      settingsWindow.once("closed", () => {
        settingsWindow = undefined;
      });
    }
    trackSubscriber(settingsWindow.webContents);
  };

  ipcMain.handle(DEVICE_LINK_CHANNELS.getState, (event) => {
    authorize(event);
    return buildStateView();
  });

  ipcMain.handle(DEVICE_LINK_CHANNELS.setEnabled, async (event, enabled: unknown) => {
    authorize(event);
    if (typeof enabled !== "boolean") {
      throw new Error("enabled 参数必须是布尔值");
    }
    return applyEnabled(enabled);
  });

  ipcMain.handle(DEVICE_LINK_CHANNELS.saveSettings, async (event, input: unknown) => {
    authorize(event);
    return saveAndApply(input);
  });

  ipcMain.handle(DEVICE_LINK_CHANNELS.openSettings, (event) => {
    authorize(event);
    openSettings();
    return true;
  });

  ipcMain.handle(DEVICE_LINK_CHANNELS.sendText, (event, text: unknown) => {
    authorize(event);
    if (typeof text !== "string") {
      throw new Error("发送内容必须是字符串");
    }
    const { deliveredCount } = service.sendText(text);
    const state = buildStateView();
    broadcastState();
    return { deliveredCount, state };
  });

  ipcMain.handle(DEVICE_LINK_CHANNELS.clearHistory, (event) => {
    authorize(event);
    service.clearHistory();
    const state = buildStateView();
    broadcastState();
    return state;
  });

  return {
    openSettings,
    start: () => applyEnabled(true),
    stop: () => applyEnabled(false),
    async dispose() {
      subscribers.clear();
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.getState);
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.setEnabled);
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.saveSettings);
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.openSettings);
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.sendText);
      ipcMain.removeHandler(DEVICE_LINK_CHANNELS.clearHistory);
      settingsWindow?.close();
      await service.dispose();
    },
  };
}
