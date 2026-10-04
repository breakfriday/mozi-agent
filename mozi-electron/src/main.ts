import { app, BrowserWindow, ipcMain } from "electron";
import started from "electron-squirrel-startup";
import { existsSync } from "node:fs";
import path from "node:path";
import rendererConfig from "../dual-electron.config.cjs";
import type { RendererEntry } from "./env_config.types";
import { TrayService } from "./main/services/tray.service";
import { WindowService } from "./main/services/window.service";

function resolveRendererEntry(): RendererEntry {
  const mode = app.isPackaged ? "filelocal" : process.env.ELECTRON_RENDERER_MODE?.trim() || "dev";
  if (mode === "dev") {
    const url = process.env.ELECTRON_RENDERER_URL?.trim() || rendererConfig.rendererDevUrl;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("ELECTRON_RENDERER_URL must use http:// or https://.");
    return { type: "url", url };
  }
  if (mode !== "filelocal") throw new Error("ELECTRON_RENDERER_MODE must be dev or filelocal.");
  const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources");
  const filePath = path.join(root, "renderer", "index.html");
  if (!existsSync(filePath)) throw new Error(`Renderer file is missing: ${filePath}. Run pnpm build:renderer and pnpm copy:renderer.`);
  return { type: "file", filePath, hash: rendererConfig.rendererHash || "/" };
}

if (started) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const windowService = new WindowService();
    const trayService = new TrayService(windowService, resolveRendererEntry());

    ipcMain.on("app:quit", () => trayService.quitApplication());
    ipcMain.on("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
    ipcMain.on("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
    ipcMain.handle("window:open-devtools", (event) =>
      windowService.openDebugTool(BrowserWindow.fromWebContents(event.sender) ?? undefined),
    );

    trayService.start();
    trayService.showApplication();
    app.on("activate", () => trayService.showApplication());
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") trayService.quitApplication();
    });
  });
}
