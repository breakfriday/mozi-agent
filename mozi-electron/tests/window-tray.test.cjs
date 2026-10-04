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
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: packaged,
    getAppPath: () => projectDir,
    getName: () => "mozi-electron",
    quitCalls: 0,
    quit() {
      this.quitCalls++;
      this.emit("before-quit");
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
      this.webContents = {
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
        openDevTools: () => { this.devToolsOpen = true; },
      };
      windows.push(this);
    }
    setMenu() {}
    loadURL(url) { this.loaded = { url }; return Promise.resolve(); }
    loadFile(filePath, options) { this.loaded = { filePath, hash: options.hash }; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit("closed"); }
    }
  }

  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    setToolTip(value) { this.toolTip = value; }
    setContextMenu(value) { this.menu = value; }
  }

  const electron = {
    app, BrowserWindow, Tray,
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
      module, exports: module.exports, console,
      __dirname: path.join(projectDir, ".vite/build"),
      process: { platform, resourcesPath: "/packaged/resources" },
      require: (name) => {
        if (name === "electron") return electron;
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        if (name.startsWith("node:")) return require(name);
        throw new Error(`Unexpected dependency: ${name}`);
      },
    }, { filename: file });
    return module.exports;
  }

  const windowModule = load("src/main/services/window.service.ts");
  const { TrayService } = load("src/main/services/tray.service.ts", { "./window.service": windowModule });
  const windowService = new windowModule.WindowService();
  const trayService = new TrayService(windowService, entry);
  return { app, windows, trays, windowService, trayService };
}

test("window service loads URL/file entries and retains mozi window settings", () => {
  const { windowService } = setup();
  const main = windowService.createMainWindow(entry);
  assert.equal(main.loaded.url, entry.url);
  assert.equal(main.options.width, 1280);
  assert.equal(main.options.height, 860);
  assert.equal(main.options.minWidth, 960);
  assert.equal(main.options.minHeight, 640);
  const prefs = main.options.webPreferences;
  assert.equal(prefs.webSecurity, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, path.join(projectDir, ".vite/build/preload.js"));
  assert.equal(main.openHandler().action, "deny");
  const local = windowService.createWindow("local", { type: "file", filePath: "/renderer/index.html", hash: "/about" });
  assert.equal(local.loaded.filePath, "/renderer/index.html");
  assert.equal(local.loaded.hash, "/about");
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

for (const platform of ["linux", "win32"]) {
  test(`${platform}: closing hides to tray; click restores; quit closes`, () => {
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
    trays[0].menu.find((item) => item.label === "退出应用").click();
    assert.equal(app.quitCalls, 1);
    assert.equal(win.destroyed, true);
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
  trays[0].menu.find((item) => item.label === "唤起应用").click();
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
