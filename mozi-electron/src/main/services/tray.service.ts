import { Menu, Tray, app, nativeImage } from "electron";
import path from "node:path";

import type { BrowserWindow, NativeImage } from "electron";
import type { RendererEntry } from "../../env_config.types";
import { MAIN_WINDOW_CHANNEL_ID, WindowService } from "./window.service";

const TRAY_ICON_FILE_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "tray-iconTemplate.png",
  linux: "tray-icon.png",
  win32: "tray-icon.ico",
};

const getTrayIcon = (): NativeImage => {
  const iconFile =
    TRAY_ICON_FILE_BY_PLATFORM[process.platform] ?? "tray-icon.png";
  const iconDir = app.isPackaged
    ? path.join(process.resourcesPath, "icons")
    : path.join(app.getAppPath(), "assets/icons");
  const icon = nativeImage.createFromPath(path.join(iconDir, iconFile));

  if (icon.isEmpty()) {
    throw new Error(`无法加载托盘图标: ${path.join(iconDir, iconFile)}`);
  }

  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }

  return icon;
};

export class TrayService {
  private tray: Tray | undefined;
  private mainWindow: BrowserWindow | undefined;
  private isQuitting = false;

  constructor(
    private readonly windowService: WindowService,
    private readonly mainWindowEntry: RendererEntry,
  ) {}

  start(): void {
    if (this.tray) {
      return;
    }

    const tray = new Tray(getTrayIcon());
    tray.setToolTip(app.getName());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "唤起应用", click: () => this.showApplication() },
        { type: "separator" },
        { label: "退出应用", click: () => this.quitApplication() },
      ]),
    );
    tray.on("click", () => this.showApplication());
    app.on("before-quit", () => {
      this.isQuitting = true;
    });

    this.tray = tray;
  }

  showApplication(): void {
    const mainWindow =
      this.windowService.getWindow(MAIN_WINDOW_CHANNEL_ID) ??
      this.windowService.createMainWindow(this.mainWindowEntry);

    this.bindMainWindow(mainWindow);

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }

  quitApplication(): void {
    this.isQuitting = true;
    app.quit();
  }

  private bindMainWindow(mainWindow: BrowserWindow): void {
    if (this.mainWindow === mainWindow) {
      return;
    }

    this.mainWindow = mainWindow;
    mainWindow.on("close", (event) => {
      if (this.isQuitting || process.platform === "darwin") {
        return;
      }

      event.preventDefault();
      mainWindow.hide();
    });
    mainWindow.once("closed", () => {
      if (this.mainWindow === mainWindow) {
        this.mainWindow = undefined;
      }
    });
  }
}
