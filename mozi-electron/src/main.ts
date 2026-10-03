import { app, BrowserWindow, ipcMain } from "electron";
import started from "electron-squirrel-startup";
import { existsSync } from "node:fs";
import path from "node:path";
import rendererConfig from "../dual-electron.config.cjs";

type RendererEntry = { type: "url"; url: string } | { type: "file"; filePath: string; hash: string };

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

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#141414",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const entry = resolveRendererEntry();
  const loading = entry.type === "url" ? window.loadURL(entry.url) : window.loadFile(entry.filePath, { hash: entry.hash });
  void loading.catch((error: Error) => console.error("Failed to load renderer:", error));
}

if (started) app.quit();

app.whenReady().then(() => {
  ipcMain.on("app:quit", () => app.quit());
  ipcMain.on("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("window:open-devtools", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;
    window.webContents.openDevTools();
    return true;
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
