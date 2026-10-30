const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const createLoader = require("./helpers/load-ts.cjs");

function setup(exists = true) {
  const children = [], errors = [];
  const ipcMain = new EventEmitter();
  const sender = { mainFrame: {} };
  const load = createLoader({
    electron: { ipcMain, dialog: { showErrorBox: (...args) => errors.push(args) } },
    "node:fs": { existsSync: () => exists },
    "node:child_process": { spawn: () => {
      const child = new EventEmitter();
      child.commands = [];
      child.stdin = Object.assign(new EventEmitter(), { write: line => child.commands.push(JSON.parse(line)) });
      child.kill = () => { child.killed = true; child.emit("exit", 0); };
      children.push(child);
      return child;
    } },
  });
  const { installParticleSidecar } = load(path.resolve(__dirname, "../src/main/particles/index.ts"));
  const controller = installParticleSidecar({ nativeBin: "/native/mozi-particles", windows: { getWindowForWebContents: value => value === sender ? {} : undefined } });
  return { controller, children, errors, ipcMain, project: content => ipcMain.emit("particles:project", { sender, senderFrame: sender.mainFrame }, content) };
}

test("native sidecar is lazy, singleton and owns projection IPC across close/reopen", () => {
  const s = setup();
  assert.equal(s.children.length, 0);
  assert.equal(s.controller.open(), true);
  s.controller.open();
  assert.equal(s.children.length, 1);
  assert.equal(s.children[0].commands[2].type, "focus");
  s.project({ key: "m1", text: "你好", role: "user", streaming: false });
  assert.equal(s.children[0].commands.length, 4);
  assert.equal(s.children[0].commands[3].type, "project");
  assert.equal(s.children[0].commands[3].content.text, "你好");
  s.controller.close();
  assert.equal(s.children[0].killed, true);
  s.controller.open();
  assert.equal(s.children.length, 2);
  s.controller.dispose();
  assert.equal(s.ipcMain.listenerCount("particles:project"), 0);
});

test("clear sends null without closing or opening the renderer; later updates resume", () => {
  const s = setup();
  s.controller.clear();
  assert.equal(s.children.length, 0);
  s.controller.open();
  s.controller.clear();
  assert.deepEqual(s.children[0].commands.at(-1), { type: "project", content: null });
  assert.equal(s.children[0].killed, undefined);
  s.project({ key: "next", text: "新状态", role: "activity", streaming: true });
  assert.equal(s.children[0].commands.at(-1).content.text, "新状态");
  s.controller.dispose();
});

test("missing native binary reports failure without a fallback", () => {
  const s = setup(false);
  assert.equal(s.controller.open(), false);
  assert.equal(s.children.length, 0);
  assert.equal(s.errors.length, 1);
});

test("spawn failure and native exit allow retry", () => {
  const s = setup();
  s.controller.open();
  s.children[0].emit("error", new Error("EACCES"));
  assert.equal(s.errors.length, 1);
  s.controller.open();
  s.children[1].emit("exit", 1);
  s.controller.open();
  assert.equal(s.children.length, 3);
  s.controller.dispose();
  assert.equal(s.ipcMain.listenerCount("particles:project"), 0);
});

test("settings synchronize on launch and while running without restarting the renderer", () => {
  const s = setup();
  const settings = { style: "ink", wallpaper: "/tmp/wall.png", depth: 1.5, paused: true, cruise: false };
  s.controller.applySettings(settings);
  assert.equal(s.children.length, 0);
  s.controller.open();
  assert.deepEqual(s.children[0].commands[0], { type: "configure", style: "ink", depth: 1.5, paused: true, cruise: false });
  assert.deepEqual(s.children[0].commands[1], { type: "wallpaper", path: "/tmp/wall.png" });
  s.controller.applySettings({ ...settings, paused: false });
  assert.equal(s.children.length, 1);
  assert.equal(s.children[0].commands.length, 3);
  assert.equal(s.children[0].commands[2].paused, false);
  s.controller.dispose();
  assert.equal(s.ipcMain.listenerCount("particles:project"), 0);
});

test("settings persist independently, validate at the boundary and reopen from disk", async () => {
  let disk;
  const handlers = new Map(), applied = [];
  const win = Object.assign(new EventEmitter(), { webContents: { mainFrame: {} }, close() { this.emit("closed"); } });
  const load = createLoader({
    electron: {
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/wall.png"] }) },
      ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    },
    "node:fs": { existsSync: () => disk !== undefined, readFileSync: () => disk, writeFileSync: (_, data) => { disk = data; } },
  });
  const { installParticleSettings } = load(path.resolve(__dirname, "../src/main/particles/settings.ts"));
  const deps = { windows: { createWindow: (_, target) => { assert.equal(target.hash, "/particleSettings"); return win; } }, entry: { type: "file", filePath: "/app/index.html" }, filePath: "/settings.json", apply: s => applied.push(s) };
  const controller = installParticleSettings(deps);
  assert.equal(applied.length, 1);
  controller.open();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const next = { style: "ink", wallpaper: null, paused: true, cruise: false, depth: 2 };
  handlers.get("particle-settings:save")(event, next);
  assert.deepEqual(JSON.parse(disk), next);
  assert.throws(() => handlers.get("particle-settings:save")(event, { ...next, depth: 99 }));
  assert.throws(() => handlers.get("particle-settings:get")({ sender: {} }));
  assert.equal(await handlers.get("particle-settings:choose")(event), "/wall.png");
  controller.dispose();
  assert.equal(handlers.size, 0);
  const reopened = installParticleSettings(deps);
  assert.equal(applied.at(-1).style, "ink");
  reopened.dispose();
});
