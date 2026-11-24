const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const createLoader = require("./helpers/load-ts.cjs");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-device-link-"));
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);

  const createdWindows = [];
  const trustedSender = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
  });

  const windows = {
    createWindow(channelId, entry, options) {
      const win = new EventEmitter();
      win.channelId = channelId;
      win.entry = entry;
      win.options = options;
      win.destroyed = false;
      win.isDestroyed = () => win.destroyed;
      win.close = () => {
        if (!win.destroyed) {
          win.destroyed = true;
          win.emit("closed");
        }
      };
      win.webContents = trustedSender;
      createdWindows.push(win);
      return win;
    },
    getWindowForWebContents(sender) {
      return sender === trustedSender ? {} : undefined;
    },
  };

  const load = createLoader({
    electron: { ipcMain },
  });

  const { installDeviceLinkService } = load(
    path.resolve(__dirname, "../src/main/device-link/index.ts"),
  );
  const { buildDeviceLinkQrPayload, pickPreferredLanIp, DEVICE_LINK_CHANNELS } = load(
    path.resolve(__dirname, "../../shared/device-link.ts"),
  );

  const event = { sender: trustedSender, senderFrame: trustedSender.mainFrame };
  const invoke = (channel, ...args) => handlers.get(channel)(event, ...args);

  return {
    tempDir,
    handlers,
    createdWindows,
    trustedSender,
    windows,
    installDeviceLinkService,
    buildDeviceLinkQrPayload,
    pickPreferredLanIp,
    DEVICE_LINK_CHANNELS,
    invoke,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("installDeviceLinkService defaults to disabled, persists port/path, toggles WS server, and opens settings window", async () => {
  const h = createHarness();
  const controller = h.installDeviceLinkService({
    windows: h.windows,
    entry: { type: "url", url: "http://127.0.0.1:5173/mozi_app/" },
    userDataDir: h.tempDir,
  });

  try {
    // 1. Default state is disabled (not listening)
    const initial = await h.invoke(h.DEVICE_LINK_CHANNELS.getState);
    assert.equal(initial.running, false);
    assert.equal(initial.settings.enabled, false);
    assert.equal(initial.settings.port, 8080);
    assert.equal(initial.settings.path, "/");

    // 2. Save custom port while disabled -> stays disabled
    const freePort = await findFreePort();
    const saved = await h.invoke(h.DEVICE_LINK_CHANNELS.saveSettings, {
      port: freePort,
      path: "/bridge",
    });
    assert.equal(saved.running, false);
    assert.equal(saved.settings.port, freePort);
    assert.equal(saved.settings.path, "/bridge");

    // 3. Enable service -> starts listening on configured port
    const started = await h.invoke(h.DEVICE_LINK_CHANNELS.setEnabled, true);
    assert.equal(started.running, true);
    assert.equal(started.activePort, freePort);
    assert.equal(started.path, "/bridge");

    // 4. QR payload matches HarmonyOS app fields
    const ip = h.pickPreferredLanIp(["198.18.0.1", "192.168.31.88"]);
    assert.equal(ip, "192.168.31.88");
    const qr = h.buildDeviceLinkQrPayload({
      host: ip,
      port: started.activePort,
      path: started.path,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(qr)), {
      app: "mozi-device-link",
      v: 1,
      host: "192.168.31.88",
      port: freePort,
      path: "/bridge",
      secure: false,
      ws: `ws://192.168.31.88:${freePort}/bridge`,
    });

    // 5. Open settings window via IPC or controller
    await h.invoke(h.DEVICE_LINK_CHANNELS.openSettings);
    assert.equal(h.createdWindows.length, 1);
    assert.equal(h.createdWindows[0].channelId, "device-link-settings");
    assert.equal(h.createdWindows[0].entry.url, "http://127.0.0.1:5173/mozi_app/deviceLinkSettings");

    // 6. Disable service -> stops server
    const stopped = await h.invoke(h.DEVICE_LINK_CHANNELS.setEnabled, false);
    assert.equal(stopped.running, false);

    // 7. Rejects untrusted IPC caller
    assert.throws(() =>
      h.handlers.get(h.DEVICE_LINK_CHANNELS.getState)({
        sender: { mainFrame: {} },
        senderFrame: {},
      }),
    );

    await controller.dispose();
    assert.equal(h.handlers.size, 0);

    // 8. Cold restart restores port/path from disk while remaining disabled by default
    const controller2 = h.installDeviceLinkService({
      windows: h.windows,
      entry: { type: "file", filePath: "/app/index.html", hash: "/" },
      userDataDir: h.tempDir,
    });
    const reloaded = await h.invoke(h.DEVICE_LINK_CHANNELS.getState);
    assert.equal(reloaded.running, false);
    assert.equal(reloaded.settings.enabled, false);
    assert.equal(reloaded.settings.port, freePort);
    assert.equal(reloaded.settings.path, "/bridge");
    await controller2.dispose();
  } finally {
    await controller.dispose();
    h.cleanup();
  }
});
