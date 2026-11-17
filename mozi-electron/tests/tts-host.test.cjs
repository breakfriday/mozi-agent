const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const createLoader = require("./helpers/load-ts.cjs");

class FakeWebSocket extends EventEmitter {
  constructor(url, headers, protocol) {
    super();
    this.url = url;
    this.headers = headers;
    this.protocol = protocol;
    this.readyState = 0;
    this.sentFrames = [];
    this.terminated = false;
  }

  send(data, cb) {
    this.sentFrames.push(new Uint8Array(data));
    if (cb) cb();
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  decodedSentMessages() {
    return this.sentFrames.map((f) => this.protocol.unmarshalMessage(f));
  }
}

test("TTS host persists 0600 credentials without leaking secrets, enforces main-frame auth, streams PCM and cancels on window destroy", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mozi-tts-host-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);

  const load = createLoader({ electron: { ipcMain } });
  const protocol = load(path.resolve(__dirname, "../src/main/services/volcengine/tts-protocol.ts"));
  const { installTtsService } = load(path.resolve(__dirname, "../src/main/tts/index.ts"));
  const { TTS_CHANNELS } = load(path.resolve(__dirname, "../../shared/tts.ts"));

  const createdWindows = [];
  const makeFakeWindow = (id) => {
    const sent = [];
    const webContents = Object.assign(new EventEmitter(), {
      id,
      mainFrame: {},
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      send(channel, payload) {
        sent.push({ channel, payload });
      },
    });
    const win = Object.assign(new EventEmitter(), {
      webContents,
      sent,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      close() {
        this.destroyed = true;
        this.webContents.destroyed = true;
        this.webContents.emit("destroyed");
        this.emit("closed");
      },
    });
    createdWindows.push(win);
    return win;
  };

  const mainWin = makeFakeWindow("main-win");
  const untrustedSender = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: () => assert.fail("Must not send events to untrusted window"),
  });

  const sockets = [];
  const host = installTtsService({
    windows: {
      createWindow: (_channelId, destination, options) => {
        const w = makeFakeWindow("tts-settings-win");
        w.destination = destination;
        w.options = options;
        return w;
      },
      getWindowForWebContents: (wc) => createdWindows.find((w) => w.webContents === wc),
    },
    entry: { type: "url", url: "http://localhost:5173/mozi_app/" },
    userDataDir: tmpDir,
    ttsDependencies: {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers, protocol);
        sockets.push(ws);
        return ws;
      },
    },
  });

  // 0. Zero network connection on startup!
  assert.equal(sockets.length, 0);

  const trustedEvent = { sender: mainWin.webContents, senderFrame: mainWin.webContents.mainFrame };
  const subframeEvent = { sender: mainWin.webContents, senderFrame: {} };
  const untrustedEvent = { sender: untrustedSender, senderFrame: untrustedSender.mainFrame };

  // 1. Subframe and untrusted windows are rejected
  assert.throws(() => handlers.get(TTS_CHANNELS.getState)(subframeEvent), /main-frame/);
  assert.throws(() => handlers.get(TTS_CHANNELS.getState)(untrustedEvent), /Untrusted/);

  // 2. Initial state is unconfigured; saving API key writes 0600 file and redacts view
  const initialView = handlers.get(TTS_CHANNELS.getState)(trustedEvent);
  assert.equal(initialView.credentials.volcengine.configured, false);
  assert.equal(initialView.catalog[0].id, "volcengine");

  const updatedView = handlers.get(TTS_CHANNELS.saveSettings)(trustedEvent, {
    settings: {
      ...initialView.settings,
      providers: {
        volcengine: {
          ...initialView.settings.providers.volcengine,
          modelId: "seed-icl-2.0-expressive",
          speaker: "S_custom_clone_1",
        },
      },
    },
    credentials: {
      volcengine: { apiKey: "ark-super-secret" },
    },
  });

  assert.equal(updatedView.credentials.volcengine.configured, true);
  assert.equal(updatedView.credentials.volcengine.hasApiKey, true);
  assert.equal("apiKey" in updatedView.credentials.volcengine, false);

  const authFile = path.join(tmpDir, "tts-auth.json");
  if (process.platform !== "win32") {
    const mode = fs.statSync(authFile).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  // 3. Open standalone settings window and run streaming synthesis
  assert.equal(handlers.get(TTS_CHANNELS.openSettings)(trustedEvent), true);
  const settingsWin = createdWindows.at(-1);
  assert.equal(settingsWin.destination.url, "http://localhost:5173/mozi_app/ttsSettings");

  const settingsEvent = {
    sender: settingsWin.webContents,
    senderFrame: settingsWin.webContents.mainFrame,
  };

  ipcMain.emit(TTS_CHANNELS.command, settingsEvent, {
    type: "start",
    utteranceId: "utt-1",
    contextText: "欢快自然",
  });
  ipcMain.emit(TTS_CHANNELS.command, settingsEvent, {
    type: "delta",
    utteranceId: "utt-1",
    text: "测试语音合成",
  });

  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  assert.equal(ws.headers["X-Api-Key"], "ark-super-secret");
  assert.equal(ws.headers["X-Api-Resource-Id"], "seed-icl-2.0");

  ws.readyState = 1;
  ws.emit("upgrade", { headers: { "x-tt-logid": "log-host-1" } });
  ws.emit("open");

  const startConnReply = protocol.createMessage(
    protocol.MsgType.FullServerResponse,
    protocol.MsgTypeFlagBits.WithEvent,
  );
  startConnReply.event = protocol.EventType.ConnectionStarted;
  startConnReply.connectId = "cid-host";
  ws.emit("message", Buffer.from(protocol.marshalMessage(startConnReply)), true);

  const sentStartSession = ws.decodedSentMessages()[1];
  assert.equal(sentStartSession.event, protocol.EventType.StartSession);
  const startPayload = protocol.decodeJsonPayload(sentStartSession);
  assert.equal(startPayload.req_params.speaker, "S_custom_clone_1");
  assert.equal(startPayload.req_params.model, "seed-tts-2.0-expressive");

  const sessionStarted = protocol.createMessage(
    protocol.MsgType.FullServerResponse,
    protocol.MsgTypeFlagBits.WithEvent,
  );
  sessionStarted.event = protocol.EventType.SessionStarted;
  sessionStarted.sessionId = sentStartSession.sessionId;
  ws.emit("message", Buffer.from(protocol.marshalMessage(sessionStarted)), true);

  const audioMsg = protocol.createMessage(
    protocol.MsgType.AudioOnlyServer,
    protocol.MsgTypeFlagBits.WithEvent,
  );
  audioMsg.serialization = protocol.SerializationBits.Raw;
  audioMsg.event = protocol.EventType.TTSResponse;
  audioMsg.sessionId = sentStartSession.sessionId;
  audioMsg.payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  ws.emit("message", Buffer.from(protocol.marshalMessage(audioMsg)), true);

  assert.equal(settingsWin.sent[0].payload.type, "started");
  assert.equal(settingsWin.sent[1].payload.type, "audio");
  assert.deepEqual([...settingsWin.sent[1].payload.pcm], [1, 2, 3, 4]);

  // 4. Closing the settings window while streaming automatically sends CancelSession(101)
  settingsWin.close();
  assert.equal(ws.decodedSentMessages().at(-1).event, protocol.EventType.CancelSession);

  host.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(ipcMain.listenerCount(TTS_CHANNELS.command), 0);
});
