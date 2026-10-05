const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const projectDir = path.resolve(__dirname, "..");
const entry = { type: "url", url: "http://localhost:5173/mozi_app/" };

function setup(platform = "linux", packaged = false) {
  const windows = [];
  const trays = [];
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const ipcRenderer = new EventEmitter();
  const exposed = {};
  const app = new EventEmitter();
  const mainProcess = Object.assign(new EventEmitter(), { platform, resourcesPath: "/packaged/resources", env: {} });
  const agentLifecycle = { stops: 0, forced: 0 };
  Object.assign(app, {
    isPackaged: packaged,
    getAppPath: () => projectDir,
    getName: () => "mozi-electron",
    getPath: () => "/tmp/mozi-test-user-data",
    requestSingleInstanceLock: () => true,
    quitCalls: 0,
    whenReady: () => Promise.resolve(),
    exitCodes: [],
    exit(code) { this.exitCodes.push(code); },
    quit() {
      this.quitCalls++;
      let prevented = false;
      this.emit("before-quit", { preventDefault() { prevented = true; } });
      if (prevented) return;
      for (const window of windows) if (!window.isDestroyed()) window.close();
    },
  });

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = true;
      this.minimized = false;
      this.fullScreen = false;
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {},
        isDestroyed: () => this.destroyed,
        send: (channel, state) => this.sent.push({ channel, state }),
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        isDevToolsOpened: () => Boolean(this.devToolsOpen),
        devToolsWebContents: { focus: () => { this.devToolsFocused = true; } },
        openDevTools: () => {
          this.devToolsOpenCalls = (this.devToolsOpenCalls ?? 0) + 1;
          this.devToolsOpen = true;
        },
      });
      windows.push(this);
    }
    setMenu() {}
    loadURL(url) { this.loaded = { url }; return Promise.resolve(); }
    loadFile(filePath, options) { this.loaded = { filePath, hash: options.hash }; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; }
    isFullScreen() { return this.fullScreen; }
    setFullScreen(value) {
      if (this.fullScreen === value) return;
      this.fullScreen = value;
      this.emit(value ? "enter-full-screen" : "leave-full-screen");
    }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    isFocused() { return Boolean(this.focused); }
    focus() {
      for (const window of windows) window.focused = false;
      this.focused = true;
    }
    close() {
      if (this.destroyed) return;
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) {
        this.destroyed = true;
        this.emit("closed");
        if (windows.every((win) => win.destroyed)) app.emit("window-all-closed");
      }
    }
  }

  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    setToolTip(value) { this.toolTip = value; }
    setContextMenu(value) { this.menu = value; }
  }

  const electron = {
    app, BrowserWindow, Tray, ipcMain, ipcRenderer,
    contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: {
      createFromPath: (filePath) => ({
        filePath,
        isEmpty: () => !existsSync(packaged ? path.join(projectDir, "assets/icons", path.basename(filePath)) : filePath),
        setTemplateImage(value) { this.template = value; },
      }),
    },
  };

  function load(file, dependencies = {}) {
    const source = readFileSync(path.join(projectDir, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const module = { exports: {} };
    vm.runInNewContext(outputText, {
      module, exports: module.exports, console, URL, TextEncoder, setTimeout, clearTimeout,
      crypto: require("node:crypto").webcrypto,
      __dirname: path.join(projectDir, ".vite/build"),
      process: mainProcess,
      require: (name) => {
        if (name === "electron") return electron;
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        if (name.startsWith("node:")) return require(name);
        if (name.startsWith(".")) {
          const absolute = path.resolve(projectDir, path.dirname(file), name);
          const resolved = [`${absolute}.ts`, path.join(absolute, "index.ts")].find(existsSync);
          if (resolved) return load(path.relative(projectDir, resolved), dependencies);
        }
        throw new Error(`Unexpected dependency: ${name}`);
      },
    }, { filename: file });
    if (file.endsWith("shared/agent/logging.ts")) module.exports.configureAgentLogging({ enabled: false });
    return module.exports;
  }

  const windowModule = load("src/main/services/window.service.ts");
  const trayModule = load("src/main/services/tray.service.ts", { "./window.service": windowModule });
  const { TrayService } = trayModule;
  const ipcModule = load("src/main/window-ipc.ts");
  const windowService = new windowModule.WindowService();
  const trayService = new TrayService(windowService, entry);
  const startMain = () => load("src/main.ts", {
    "electron-squirrel-startup": false,
    "../dual-electron.config.cjs": { rendererDevUrl: entry.url },
    "./main/services/window.service": windowModule,
    "./main/services/tray.service": trayModule,
    "./main/window-ipc": ipcModule,
    "./main/agent/process-manager": { AgentProcessManager: class {
      start() {}
      stop() { agentLifecycle.stops++; return Promise.resolve(); }
      forceStop() { agentLifecycle.forced++; }
    } },
  });
  return {
    app, windows, trays, windowService, trayService, ipcMain, ipcRenderer, handlers, mainProcess, agentLifecycle,
    startMain,
    registerIpc: () => ipcModule.registerWindowIpc(windowService, () => trayService.quitApplication()),
    loadPreload: () => { load("src/preload.ts"); return exposed.electronAPI; },
  };
}

test("window service loads URL/file entries and retains mozi window settings", () => {
  const { windowService } = setup();
  const main = windowService.createMainWindow(entry);
  assert.equal(main.loaded.url, entry.url);
  assert.equal(main.options.width, 1280);
  assert.equal(main.options.height, 860);
  assert.equal(main.options.minWidth, 960);
  assert.equal(main.options.minHeight, 640);
  assert.equal(main.options.frame, false);
  const prefs = main.options.webPreferences;
  assert.equal(prefs.webSecurity, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, path.join(projectDir, ".vite/build/preload.js"));
  assert.equal(main.openHandler().action, "deny");
  const local = windowService.createWindow("local", { type: "file", filePath: "/renderer/index.html", hash: "/chat" });
  assert.equal(local.loaded.filePath, "/renderer/index.html");
  assert.equal(local.loaded.hash, "/chat");
  assert.equal(local.options.frame, false);
});

test("window service reuses, restores, and cleans up windows by channel", () => {
  const { windowService, windows } = setup();
  const win = windowService.createMainWindow(entry);
  win.hide();
  win.minimized = true;
  assert.equal(windowService.createMainWindow(entry), win);
  assert.equal(win.visible, true);
  assert.equal(win.minimized, false);
  assert.equal(windows.length, 1);
  assert.equal(windowService.openDebugTool(win), true);
  windowService.closeWindow("main_window");
  assert.equal(windowService.getWindow("main_window"), undefined);
  assert.equal(windowService.openDebugTool(win), false);
  assert.equal(windowService.openDebugTool(undefined), false);
  assert.notEqual(windowService.createMainWindow(entry), win);
});

test("DevTools requests reuse the sender window panel and reopen after closing", () => {
  const { windowService, registerIpc, handlers } = setup();
  registerIpc();
  const main = windowService.createMainWindow(entry);
  const secondary = windowService.createWindow("secondary", entry);
  const openDevTools = handlers.get("window:open-devtools");
  const event = { sender: secondary.webContents, senderFrame: secondary.webContents.mainFrame };

  main.focus();
  assert.equal(openDevTools(event), false);
  assert.equal(secondary.devToolsOpenCalls, undefined);
  secondary.focus();
  assert.equal(openDevTools(event), true);
  assert.equal(openDevTools(event), true);
  assert.equal(secondary.devToolsOpenCalls, 1);
  assert.equal(secondary.devToolsFocused, true);
  assert.equal(main.devToolsOpenCalls, undefined);

  secondary.devToolsOpen = false;
  assert.equal(openDevTools(event), true);
  assert.equal(secondary.devToolsOpenCalls, 2);
  assert.equal(openDevTools({ ...event, senderFrame: {} }), false);
  secondary.close();
  assert.equal(openDevTools(event), false);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform}: close hides to tray; click and double-click restore; quit closes`, () => {
    const { app, windows, trays, trayService } = setup(platform);
    trayService.start();
    trayService.start();
    assert.equal(trays.length, 1);
    trayService.showApplication();
    trayService.showApplication();
    const win = windows[0];
    assert.equal(win.listenerCount("close"), 1);
    win.close();
    assert.equal(win.destroyed, false);
    assert.equal(win.visible, false);
    win.minimized = true;
    trays[0].emit("click");
    assert.equal(windows.length, 1);
    assert.equal(win.visible, true);
    assert.equal(win.minimized, false);
    assert.equal(win.focused, true);
    win.close();
    win.minimized = true;
    trays[0].emit("double-click");
    assert.equal(windows.length, 1);
    assert.equal(win.visible, true);
    assert.equal(win.minimized, false);
    assert.equal(win.focused, true);
    trays[0].menu.find((item) => item.label === "退出应用").click();
    assert.equal(app.quitCalls, 1);
    assert.equal(win.destroyed, true);
    trays[0].emit("click");
    assert.equal(windows.length, 1);
  });
}

test("external app.quit is not intercepted by close-to-tray", () => {
  const { app, windows, trayService } = setup();
  trayService.start();
  trayService.showApplication();
  app.quit();
  assert.equal(windows[0].destroyed, true);
});

test("macOS closes the window and tray recreates it", () => {
  const { windows, trays, trayService } = setup("darwin");
  trayService.start();
  trayService.showApplication();
  windows[0].close();
  assert.equal(windows[0].destroyed, true);
  trays[0].emit("double-click");
  assert.equal(windows.length, 2);
  assert.equal(windows[1].visible, true);
  assert.equal(trays[0].icon.template, true);
});

test("tray icons resolve for development and packaged apps on each platform", () => {
  for (const [platform, file] of Object.entries({ linux: "tray-icon.png", win32: "tray-icon.ico", darwin: "tray-iconTemplate.png" })) {
    for (const packaged of [false, true]) {
      const { trays, trayService } = setup(platform, packaged);
      trayService.start();
      assert.equal(trays[0].icon.filePath, path.join(packaged ? "/packaged/resources/icons" : path.join(projectDir, "assets/icons"), file));
      assert.equal(trays[0].toolTip, "mozi-electron");
    }
  }
});

for (const platform of ["linux", "win32", "darwin"]) {
  test(`${platform}: main stays alive in the tray until explicit quit`, async () => {
    const { app, windows, trays, windowService, startMain } = setup(platform);
    startMain();
    await new Promise(setImmediate);
    assert.equal(app.listenerCount("window-all-closed"), 1);
    const secondary = windowService.createWindow("secondary", entry);
    windows[0].close();
    assert.equal(app.quitCalls, 0);
    assert.equal(secondary.destroyed, false);
    secondary.close();
    assert.equal(app.quitCalls, 0);
    app.emit("window-all-closed");
    assert.equal(app.quitCalls, 0);
    trays[0].emit("double-click");
    const main = platform === "darwin" ? windows[2] : windows[0];
    assert.equal(main.visible, true);
    assert.equal(main.focused, true);
    trays[0].menu.find((item) => item.label === "退出应用").click();
    assert.equal(app.quitCalls, 1);
    assert.equal(main.destroyed, false);
    await new Promise(setImmediate);
    assert.equal(app.quitCalls, 2);
    assert.equal(main.destroyed, true);
  });
}

test("main exits the new instance when the instance lock is already held", () => {
  const { app, windows, startMain } = setup();
  app.requestSingleInstanceLock = () => false;
  startMain();
  assert.equal(app.quitCalls, 1);
  assert.equal(windows.length, 0);
});

test("second instance restores the existing hidden window", async () => {
  const { app, windows, startMain } = setup();
  startMain();
  await new Promise(setImmediate);
  windows[0].close();
  windows[0].minimized = true;
  app.emit("second-instance");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].minimized, false);
  assert.equal(windows[0].focused, true);
});

test("startup failure exits instead of leaving an invisible locked instance", async () => {
  const { app, windows, startMain } = setup();
  app.getAppPath = () => "/missing-mozi-app";
  startMain();
  await new Promise(setImmediate);
  assert.deepEqual(app.exitCodes, [1]);
  assert.equal(windows.length, 0);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} waits for Agent shutdown before quitting`, async () => {
    const { app, startMain, mainProcess, agentLifecycle } = setup();
    startMain(); await new Promise(setImmediate);
    mainProcess.emit(signal);
    assert.equal(agentLifecycle.stops, 1);
    assert.equal(app.quitCalls, 1);
    await new Promise(setImmediate);
    assert.equal(app.quitCalls, 2);
  });
}
test("direct process exit and will-quit have synchronous Agent cleanup", async () => {
  const { app, startMain, mainProcess, agentLifecycle } = setup();
  startMain(); await new Promise(setImmediate);
  app.emit("will-quit"); mainProcess.emit("exit", 0);
  assert.equal(agentLifecycle.forced, 2);
});

test("window IPC targets the owning main frame and validates fullscreen requests", () => {
  const { app, windowService, registerIpc, ipcMain, handlers } = setup();
  registerIpc();
  const main = windowService.createMainWindow(entry);
  const secondary = windowService.createWindow("secondary", entry);
  const event = { sender: secondary.webContents, senderFrame: secondary.webContents.mainFrame };
  const setFullScreen = handlers.get("window:set-full-screen");
  const getState = handlers.get("window:get-state");
  assert.equal(getState(event).isFullScreen, false);
  assert.equal(setFullScreen(event, "true"), false);
  assert.equal(setFullScreen({ ...event, senderFrame: {} }, true), false);
  assert.equal(setFullScreen(event, true), true);
  assert.equal(main.isFullScreen(), false);
  assert.equal(getState(event).isFullScreen, true);
  assert.equal(secondary.sent.at(-1).channel, "window:state-changed");
  assert.equal(secondary.sent.at(-1).state.isFullScreen, true);
  let prevented = false;
  secondary.webContents.emit("before-input-event", { preventDefault: () => { prevented = true; } }, { type: "keyDown", key: "Escape" });
  assert.equal(prevented, true);
  assert.equal(getState(event).isFullScreen, false);
  assert.equal(secondary.sent.at(-1).state.isFullScreen, false);
  ipcMain.emit("window:minimize", event);
  assert.equal(secondary.minimized, true);
  ipcMain.emit("app:quit", { ...event, senderFrame: {} });
  assert.equal(app.quitCalls, 0);
  ipcMain.emit("window:close", { ...event, senderFrame: {} });
  assert.equal(secondary.destroyed, false);
  ipcMain.emit("window:close", event);
  assert.equal(secondary.destroyed, true);
  assert.equal(main.destroyed, false);
  assert.equal(getState(event), null);
  assert.equal(setFullScreen(event, true), false);
  const unknown = { mainFrame: {} };
  assert.equal(getState({ sender: unknown, senderFrame: unknown.mainFrame }), null);
});

test("preload wraps window notifications, filters payloads, and removes listeners", async () => {
  const { ipcRenderer, loadPreload } = setup();
  const calls = [];
  ipcRenderer.invoke = async (...args) => { calls.push(args); return true; };
  ipcRenderer.send = (...args) => calls.push(args);
  const api = loadPreload();
  const states = [];
  const off = api.window.onStateChanged((state) => states.push(state));
  ipcRenderer.emit("window:state-changed", { privileged: true }, { isFullScreen: true });
  ipcRenderer.emit("window:state-changed", {}, { isFullScreen: "yes" });
  assert.equal(states.length, 1);
  assert.deepEqual(Object.keys(states[0]), ["isFullScreen"]);
  assert.equal(states[0].isFullScreen, true);
  off();
  assert.equal(ipcRenderer.listenerCount("window:state-changed"), 0);
  await api.window.setFullScreen(false);
  await api.window.getState();
  api.window.minimize();
  api.window.close();
  assert.deepEqual(calls, [
    ["window:set-full-screen", false], ["window:get-state"],
    ["window:minimize"], ["window:close"],
  ]);
});
