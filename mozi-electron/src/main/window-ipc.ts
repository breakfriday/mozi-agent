import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { WindowState } from "../../../shared/electron-api";
import type { WindowService } from "./services/window.service";

export function registerWindowIpc(windowService: WindowService, quit: () => void): void {
  const senderWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame) return undefined;
    return windowService.getWindowForWebContents(event.sender);
  };

  ipcMain.on("app:quit", (event) => { if (senderWindow(event)) quit(); });
  ipcMain.on("window:minimize", (event) => senderWindow(event)?.minimize());
  ipcMain.on("window:close", (event) => senderWindow(event)?.close());
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
