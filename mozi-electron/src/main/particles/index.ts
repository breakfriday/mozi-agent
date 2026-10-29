import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dialog } from "electron";
import type { AgentEvent } from "../../../../shared/agent";
import { DEFAULT_PARTICLE_SETTINGS, type ParticleSettings } from "../../../../shared/particles";
import { toParticleNotice } from "./notices";

type Dependencies = {
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  nativeBin?: string;
};

function resolveNativeBinary(explicit?: string): string | undefined {
  const override = explicit ?? process.env.MOZI_PARTICLES_BIN;
  if (override) return fs.existsSync(override) ? override : undefined;
  return [
    path.resolve(__dirname, "../../../mozi-particles-rs/target/release/mozi-particles"),
    path.resolve(__dirname, "../../../mozi-particles-rs/target/debug/mozi-particles"),
  ].find(candidate => fs.existsSync(candidate));
}

/** Owns the native renderer process and its Agent event subscription. */
export function installParticleSidecar({ subscribe, nativeBin }: Dependencies) {
  let settings = { ...DEFAULT_PARTICLE_SETTINGS };
  let active: { child: ReturnType<typeof spawn>; unsubscribe: () => void } | undefined;
  const reportError = (message: string) => dialog.showErrorBox("粒子场启动失败", message);

  function open(): boolean {
    if (active) {
      active.child.stdin!.write(`${JSON.stringify({ type: "focus" })}\n`);
      return true;
    }
    const bin = resolveNativeBinary(nativeBin);
    if (!bin) {
      reportError("未找到 Rust 粒子程序，请构建 mozi-particles-rs 或设置 MOZI_PARTICLES_BIN。");
      return false;
    }
    const child = spawn(bin, [], { stdio: ["pipe", "ignore", "inherit"] });
    const unsubscribe = subscribe(event => {
      const notice = toParticleNotice(event);
      if (notice) child.stdin!.write(`${JSON.stringify({ type: "notice", ...notice })}\n`);
    });
    active = { child, unsubscribe };
    const cleanup = () => {
      if (active?.child !== child) return;
      active.unsubscribe();
      active = undefined;
    };
    child.once("exit", cleanup);
    child.once("error", error => { cleanup(); reportError(error.message); });
    child.stdin!.on("error", error => { cleanup(); child.kill(); reportError(error.message); });
    applySettings(settings, true);
    return true;
  }

  function applySettings(next: ParticleSettings, initial = false): void {
    const wallpaperChanged = initial || next.wallpaper !== settings.wallpaper;
    settings = next;
    if (!active) return;
    const write = (command: object) => active!.child.stdin!.write(`${JSON.stringify(command)}\n`);
    write({ type: "configure", style: next.style, paused: next.paused, cruise: next.cruise, depth: next.depth });
    if (wallpaperChanged) write({ type: "wallpaper", path: next.wallpaper });
  }

  function close(): void {
    if (!active) return;
    const { child, unsubscribe } = active;
    active = undefined;
    unsubscribe();
    child.kill();
  }

  return { open, close, applySettings, dispose: close };
}
