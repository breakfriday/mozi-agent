import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { WindowState } from "../../../shared/electron-api";
import type { WindowService } from "./services/window.service";
import type { RendererEntry } from "../env_config.types";

export function registerWindowIpc(windowService: WindowService, quit: () => void, entry?: RendererEntry): void {
  const senderWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame) return undefined;
    return windowService.getWindowForWebContents(event.sender);
  };

  ipcMain.on("app:quit", (event) => { if (senderWindow(event)) quit(); });
  ipcMain.on("window:minimize", (event) => senderWindow(event)?.minimize());
  ipcMain.on("window:close", (event) => senderWindow(event)?.close());
  ipcMain.handle("window:open-token-monitor", (event, target: unknown): boolean => {
    if (!entry || !senderWindow(event) || !target || typeof target !== "object" || Array.isArray(target)) return false;
    const { sessionId, runId } = target as { sessionId?: unknown; runId?: unknown };
    const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && ![...value].some(char => char.charCodeAt(0) < 32);
    if (!validId(sessionId) || (runId !== undefined && !validId(runId))) return false;
    windowService.openTokenMonitor(entry, { sessionId, ...(runId === undefined ? {} : { runId }) });
    return true;
  });
  ipcMain.handle("window:open-devtools", (event) => {
    const win = senderWindow(event);
    if (!win?.isFocused()) return false;
    return windowService.openDebugTool(win);
  });
  ipcMain.handle("window:get-state", (event): WindowState | null => {
    const win = senderWindow(event);
    return win ? { isFullScreen: win.isFullScreen() } : null;
  });
  ipcMain.handle("window:set-full-screen", (event, fullScreen: unknown): boolean => {
    const win = senderWindow(event);
    if (!win || typeof fullScreen !== "boolean") return false;
    win.setFullScreen(fullScreen);
    return true;
  });
}
