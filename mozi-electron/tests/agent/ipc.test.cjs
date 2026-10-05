const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const createLoader = require("../helpers/load-ts.cjs");
const entry = { type: "url", url: "http://localhost:5173/mozi_app/" };

function setup(t, allow = () => true, rendererEntry = entry) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const load = createLoader({ electron: { ipcMain } });
  const { registerAgentIpc } = load(path.resolve(__dirname, "../../src/main/agent-ipc.ts"));
  const windows = new Set();
  function window() {
    const sender = Object.assign(new EventEmitter(), {
      mainFrame: { url: entry.url }, sent: [], destroyed: false,
      isDestroyed() { return this.destroyed; },
      send(channel, packet) { this.sent.push({ channel, packet }); },
    });
    windows.add(sender); return sender;
  }
  const router = registerAgentIpc({ getWindowForWebContents: (sender) => windows.has(sender) ? {} : undefined }, rendererEntry, undefined, allow);
  t.after(() => router.dispose());
  let count = 0;
  function call(sender, method, params = {}, options = {}) {
    return handlers.get("mozi:agent:request")({ sender, senderFrame: options.frame ?? sender.mainFrame }, {
      protocolVersion: 1, kind: "request", requestId: options.requestId ?? `request-${++count}`, method, params,
    });
  }
  function connect() {
    const child = { sent: [], onMessage: undefined, onClose: undefined };
    router.transport.connect({
      postMessage: (request) => child.sent.push(request),
      onMessage: (listener) => { child.onMessage = listener; return () => {}; },
      onDisconnect: (listener) => { child.onClose = listener; return () => {}; },
    });
    child.onMessage({ protocolVersion: 1, kind: "runtime", state: "ready" });
    child.emit = (sessionId, seq = 1) => child.onMessage({ protocolVersion: 1, kind: "event", sessionId, runId: "run", seq, type: "run.started", data: {} });
    child.reply = (requestId, result) => child.onMessage({ protocolVersion: 1, kind: "response", requestId, ok: true, result });
    return child;
  }
  return { router, window, call, connect, load, handlers };
}
const events = (sender) => sender.sent.filter((item) => item.channel === "mozi:agent:event");

test("IPC reports unavailable, validates senders, parameters and protocol", async (t) => {
  const { window, call, handlers } = setup(t); const sender = window();
  assert.equal((await call(sender, "runtime.getState")).result.state, "unavailable");
  assert.equal((await call(sender, "session.create", { clientOperationId: "op" })).error.code, "RUNTIME_UNAVAILABLE");
  assert.equal((await call(sender, "runtime.getState", {}, { frame: { url: entry.url } })).error.code, "PERMISSION_DENIED");
  sender.mainFrame.url = "https://untrusted.example/mozi_app/";
  assert.equal((await call(sender, "runtime.getState")).error.code, "PERMISSION_DENIED");
  sender.mainFrame.url = entry.url;
  assert.equal((await call(sender, "session.create", {})).error.code, "INVALID_ARGUMENT");
  const response = await handlers.get("mozi:agent:request")({ sender, senderFrame: sender.mainFrame }, {
    protocolVersion: 2, kind: "request", requestId: "version", method: "runtime.getState", params: {},
  });
  assert.equal(response.error.code, "PROTOCOL_MISMATCH");
});

test("subscriptions belong to windows, filter sessions, and deduplicate delivery", async (t) => {
  const { window, call, connect } = setup(t); const a = window(); const b = window(); const child = connect();
  const first = (await call(a, "session.subscribe", { sessionId: "s" })).result.subscriptionId;
  const second = (await call(a, "session.subscribe", { sessionId: "s" })).result.subscriptionId;
  await call(b, "session.subscribe", { sessionId: "other" });
  assert.equal((await call(b, "session.unsubscribe", { subscriptionId: first })).result.removed, false);
  child.emit("s");
  assert.equal(events(a).length, 1); assert.equal(events(b).length, 0);
  assert.equal((await call(a, "session.unsubscribe", { subscriptionId: first })).result.removed, true);
  child.emit("s", 2); assert.equal(events(a).length, 2);
  await call(a, "session.unsubscribe", { subscriptionId: second });
  child.emit("s", 3); assert.equal(events(a).length, 2);
});

test("HTTP SPA routes stay authorized within the configured app directory", async (t) => {
  const { window, call, connect } = setup(t); const sender = window(); const child = connect();
  sender.mainFrame.url = entry.url + "chat";
  assert.equal((await call(sender, "runtime.getState")).result.state, "ready");
  await call(sender, "session.subscribe", { sessionId: "s" });
  sender.mainFrame.url = entry.url + "about?view=agent";
  child.emit("s"); assert.equal(events(sender).length, 1);
  for (const url of ["http://localhost:5173/", "http://localhost:5173/mozi_app_evil/chat", "http://localhost:5173/mozi_app/../other", "http://localhost:5174/mozi_app/chat", "https://localhost:5173/mozi_app/chat"]) {
    sender.mainFrame.url = url;
    assert.equal((await call(sender, "runtime.getState")).error.code, "PERMISSION_DENIED", url);
  }
});

test("file renderer entries trust only their exact document", async (t) => {
  const { window, call } = setup(t, () => true, { type: "file", filePath: "/tmp/mozi-app/index.html", hash: "/" });
  const sender = window();
  sender.mainFrame.url = "file:///tmp/mozi-app/index.html#/chat";
  assert.equal((await call(sender, "runtime.getState")).result.state, "unavailable");
  sender.mainFrame.url = "file:///tmp/mozi-app/other.html";
  assert.equal((await call(sender, "runtime.getState")).error.code, "PERMISSION_DENIED");
});

test("session authorization applies to requests and later event delivery", async (t) => {
  let allowed = true;
  const { window, call, connect } = setup(t, (_sender, session) => allowed && session === "allowed");
  const sender = window(); const child = connect();
  assert.equal((await call(sender, "session.subscribe", { sessionId: "denied" })).error.code, "PERMISSION_DENIED");
  assert.equal((await call(sender, "run.cancel", { sessionId: "denied", runId: "r" })).error.code, "PERMISSION_DENIED");
  await call(sender, "session.subscribe", { sessionId: "allowed" });
  const list = call(sender, "session.list");
  const date = "2026-10-05T00:00:00.000Z";
  child.reply(child.sent.at(-1).requestId, { items: ["allowed", "denied"].map((sessionId) => ({ sessionId, title: sessionId, createdAt: date, updatedAt: date })), nextCursor: "next" });
  const result = await list;
  assert.equal(result.result.items.length, 1);
  assert.equal(result.result.items[0].sessionId, "allowed");
  assert.equal(result.result.nextCursor, "next");
  allowed = false; child.emit("allowed"); assert.equal(events(sender).length, 0);
});

test("navigation, renderer crash and close release subscriptions and requests, not Runs", async (t) => {
  const { window, call, connect } = setup(t); const child = connect();
  for (const reason of ["navigation", "crash", "close"]) {
    const sender = window();
    await call(sender, "session.subscribe", { sessionId: "s" });
    const pending = call(sender, "session.create", { clientOperationId: reason });
    if (reason === "navigation") sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (reason === "crash") sender.emit("render-process-gone", {});
    if (reason === "close") { sender.destroyed = true; sender.emit("destroyed"); }
    assert.equal((await pending).error.code, "RUNTIME_UNAVAILABLE");
    child.emit("s"); assert.equal(events(sender).length, 0);
    assert.equal(sender.listenerCount("destroyed"), 0);
  }
  assert.equal(child.sent.some((request) => request.method === "run.cancel"), false);
});

test("same-document routing retains subscriptions but a changed origin receives no events", async (t) => {
  const { window, call, connect } = setup(t); const sender = window(); const child = connect();
  await call(sender, "session.subscribe", { sessionId: "s" });
  sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  sender.mainFrame.url = entry.url + "#/chat"; child.emit("s"); assert.equal(events(sender).length, 1);
  sender.mainFrame.url = "https://untrusted.example/"; child.emit("s", 2); assert.equal(events(sender).length, 1);
});

test("restart clears old subscriptions and orders notices before fresh events", async (t) => {
  const { window, call, connect } = setup(t); const sender = window(); const old = connect();
  await call(sender, "session.subscribe", { sessionId: "s" });
  const pending = call(sender, "session.create", { clientOperationId: "op" }, { requestId: "old" });
  const next = connect();
  assert.equal((await pending).error.code, "RUNTIME_UNAVAILABLE");
  old.reply("old", { sessionId: "late" }); old.emit("s"); next.emit("s");
  assert.equal(events(sender).length, 0);
  await call(sender, "session.subscribe", { sessionId: "s" }); next.emit("s", 2);
  assert.deepEqual(sender.sent.map(({ channel, packet }) => channel === "mozi:agent:runtime" ? packet.state : packet.seq), ["unavailable", "ready", 2]);
});

test("request ownership prevents collisions across windows", async (t) => {
  const { window, call, connect } = setup(t); const a = window(); const b = window(); const child = connect();
  const first = call(a, "session.create", { clientOperationId: "op" }, { requestId: "same" });
  const conflict = await call(b, "session.create", { clientOperationId: "op" }, { requestId: "same" });
  assert.equal(conflict.error.code, "INVALID_ARGUMENT");
  child.reply("same", { sessionId: "session" });
  assert.equal((await first).result.sessionId, "session");
});

test("bridge → preload → Main → runtime preserves errors and event-before-response order", async (t) => {
  const { window, connect, load, handlers } = setup(t); const sender = window(); const renderer = new EventEmitter();
  const logging = load(path.resolve(__dirname, "../../../shared/agent/logging.ts"));
  const logs = [];
  logging.configureAgentLogging({ enabled: true, payloads: true, deltas: true }, (record) => logs.push(record));
  renderer.invoke = (channel, request) => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, structuredClone(request));
  sender.send = (channel, packet) => renderer.emit(channel, { privileged: "never expose" }, structuredClone(packet));
  const { createAgentPreloadApi } = load(path.resolve(__dirname, "../../src/preload/agent.ts"));
  const { createAgentApi } = load(path.resolve(__dirname, "../../../mozi-app/src/runtime/agent.ts"));
  const preload = createAgentPreloadApi(renderer); t.after(() => preload.dispose());
  const api = createAgentApi(() => preload.api);
  await assert.rejects(api.createSession({ clientOperationId: "op" }), (error) => error.code === "RUNTIME_UNAVAILABLE");
  const child = connect();
  await api.subscribeSession({ sessionId: "s" });
  const received = []; const off = api.onEvent((event) => received.push(event));
  const pending = api.startRun({ sessionId: "s", clientMessageId: "client", content: [{ type: "text", text: "hello" }] });
  const request = child.sent.at(-1);
  child.emit("s");
  child.reply(request.requestId, { sessionId: "s", runId: "run", messageId: "message", clientMessageId: "client", disposition: "accepted" });
  const accepted = await pending;
  assert.equal(accepted.runId, "run"); assert.equal(accepted.ok, undefined);
  assert.equal(received.length, 1); assert.equal(received[0].privileged, undefined);
  for (const [scope, action] of [
    ["preload", "request.send"], ["main", "request.received"], ["main", "request.forward"], ["transport", "request.send"],
    ["transport", "response.validated"], ["main", "response.return"], ["preload", "response.validated"],
  ]) assert.equal(logs.some((record) => record.scope === scope && record.action === action && record.requestId === request.requestId), true, `${scope}: ${action}`);
  assert.equal(logs.some((record) => record.scope === "renderer" && record.action === "request.send" && record.clientMessageId === "client" && record.payload.includes("hello")), true);
  for (const [scope, action] of [["transport", "event.validated"], ["main", "event.forward"], ["preload", "event.validated"], ["renderer", "listener.delivered"]]) {
    assert.equal(logs.some((record) => record.scope === scope && record.action === action && record.sessionId === "s" && record.runId === "run" && record.seq === 1), true, `${scope}: ${action}`);
  }
  assert.equal(logs.some((record) => record.action === "subscription.added" && record.sessionId === "s"), true);
  assert.equal(JSON.stringify(logs).includes("never expose"), false);
  off(); child.emit("s", 2); assert.equal(received.length, 1);
  assert.equal(renderer.listenerCount("mozi:agent:event"), 0);
  assert.equal(logs.some((record) => record.scope === "renderer" && record.action === "listener.removed"), true);
  // A disabled or failing diagnostic sink never changes request behavior.
  logging.configureAgentLogging({ enabled: false });
  const before = logs.length;
  assert.equal((await api.getRuntimeState()).state, "ready"); assert.equal(logs.length, before);
  logging.configureAgentLogging({ enabled: true }, () => { throw new Error("log sink failed"); });
  assert.equal((await api.getRuntimeState()).state, "ready");
});
