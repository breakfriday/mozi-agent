import { BrowserWindow } from "electron";
import path from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";
import type { RendererEntry } from "../../env_config.types";

export const MAIN_WINDOW_CHANNEL_ID = "main_window";

export interface WindowCreateOptions extends Omit<
  BrowserWindowConstructorOptions,
  "backgroundColor"
> {
  bgColor?: BrowserWindowConstructorOptions["backgroundColor"];
}

export interface WindowCreatePayload {
  channelId: string;
  url: string;
  options?: WindowCreateOptions;
}

export class WindowService {
  private readonly windowMap = new Map<string, BrowserWindow>();

  createMainWindow(entry: RendererEntry): BrowserWindow {
    return this.createWindow(MAIN_WINDOW_CHANNEL_ID, entry, {
      frame: true,
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      bgColor: "#141414",
    });
  }

  openDebugTool(win: BrowserWindow | undefined): boolean {
    if (!win || win.isDestroyed()) {
      return false;
    }

    win.webContents.openDevTools();
    return true;
  }

  createWindow(
    channelId: string,
    entry: string | RendererEntry,
    options: WindowCreateOptions = {},
  ): BrowserWindow {
    const {
      frame = true,
      transparent = false,
      bgColor = transparent ? "#00000000" : "#2e2c29",
      width = 1200,
      height = 900,
      webPreferences,
      ...browserWindowOptions
    } = options;
    const existingWindow = this.getWindow(channelId);
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
      return existingWindow;
    }

    const win = new BrowserWindow({
      ...browserWindowOptions,
      width,
      height,
      autoHideMenuBar: browserWindowOptions.autoHideMenuBar ?? true,
      backgroundColor: bgColor,
      frame,
      transparent,
      webPreferences: {
        ...webPreferences,
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: false,
      },
    });

    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    this.windowMap.set(channelId, win);
    win.once("closed", () => {
      this.windowMap.delete(channelId);
    });

    const target: RendererEntry =
      typeof entry === "string"
        ? /^(https?|file):\/\//.test(entry)
          ? { type: "url", url: entry }
          : { type: "file", filePath: entry, hash: "" }
        : entry;
    const loading =
      target.type === "url"
        ? win.loadURL(target.url)
        : win.loadFile(target.filePath, { hash: target.hash });
    void loading.catch((error: Error) => {
      console.error(`Failed to load window ${channelId}:`, target, error);
    });

    return win;
  }

  getWindow(channelId: string): BrowserWindow | undefined {
    const win = this.windowMap.get(channelId);

    if (!win || win.isDestroyed()) {
      this.windowMap.delete(channelId);
      return undefined;
    }

    return win;
  }

  closeWindow(channelId: string): void {
    this.getWindow(channelId)?.close();
  }
}
