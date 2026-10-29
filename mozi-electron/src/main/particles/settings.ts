import fs from "node:fs";
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { DEFAULT_PARTICLE_SETTINGS, PARTICLE_SETTINGS_CHANNELS as channels, parseParticleSettings, type ParticleSettings } from "../../../../shared/particles";
import type { WindowService } from "../services/window.service";
import type { RendererEntry } from "../../env_config.types";

export function installParticleSettings({ windows, entry, filePath, apply }: {
  windows: Pick<WindowService, "createWindow">;
  entry: RendererEntry;
  filePath: string;
  apply: (settings: ParticleSettings) => void;
}) {
  let settings = { ...DEFAULT_PARTICLE_SETTINGS };
  if (fs.existsSync(filePath)) {
    try { settings = parseParticleSettings(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
    catch (error) { console.error("Failed to load particle settings:", error); }
  }
  apply(settings);
  let window: BrowserWindow | undefined;
  const authorize = (event: IpcMainInvokeEvent) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Unknown settings window");
  };
  ipcMain.handle(channels.get, event => { authorize(event); return settings; });
  ipcMain.handle(channels.save, (event, input: unknown) => {
    authorize(event);
    const next = parseParticleSettings(input);
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
    settings = next;
    apply(settings);
  });
  ipcMain.handle(channels.choose, async event => {
    authorize(event);
    const result = await dialog.showOpenDialog(window!, { properties: ["openFile"], filters: [{ name: "Wallpaper", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  return {
    open() {
      const destination: RendererEntry = entry.type === "file" ? { ...entry, hash: "/particleSettings" }
        : { type: "url", url: new URL("particleSettings", entry.url.endsWith("/") ? entry.url : `${entry.url}/`).href };
      const existing = window;
      window = windows.createWindow("particle-settings", destination, { title: "Particle Settings", width: 640, height: 660, minWidth: 520, minHeight: 560 });
      if (!existing) window.once("closed", () => { window = undefined; });
    },
    dispose() {
      Object.values(channels).forEach(channel => ipcMain.removeHandler(channel));
      window?.close();
    },
  };
}
