const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const load = require("../helpers/load-ts.cjs")();
const { AgentTransport } = load(path.resolve(__dirname, "../../src/main/agent/transport.ts"));

function connection() {
  const state = { sent: [], message: undefined, close: undefined, removed: 0 };
  state.port = {
    postMessage: (request) => state.sent.push(request),
    onMessage: (listener) => { state.message = listener; return () => state.removed++; },
    onDisconnect: (listener) => { state.close = listener; return () => state.removed++; },
  };
  state.ready = () => state.message({ protocolVersion: 1, kind: "runtime", state: "ready" });
  state.reply = (requestId, result) => state.message({ protocolVersion: 1, kind: "response", requestId, ok: true, result });
  return state;
}
const request = (requestId) => ({ protocolVersion: 1, kind: "request", requestId, method: "session.create", params: { clientOperationId: requestId } });

test("transport waits for ready and matches out-of-order responses", async (t) => {
  const transport = new AgentTransport(); t.after(() => transport.dispose());
  const port = connection(); transport.connect(port.port);
  assert.equal((await transport.request(request("before"))).error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(port.sent.length, 0);
  port.ready();
  const first = transport.request(request("one"));
  const second = transport.request(request("two"));
  port.reply("two", { sessionId: "second" });
  port.reply("one", { sessionId: "first" });
  assert.equal((await first).result.sessionId, "first");
  assert.equal((await second).result.sessionId, "second");
});

test("transport rejects active request ID collision without disturbing the owner", async (t) => {
  const transport = new AgentTransport(); t.after(() => transport.dispose());
  const port = connection(); transport.connect(port.port); port.ready();
  const first = transport.request(request("one"));
  assert.equal((await transport.request(request("one"))).error.code, "INVALID_ARGUMENT");
  assert.equal(port.sent.length, 1);
  port.reply("one", { sessionId: "session" });
  assert.equal((await first).ok, true);
});

test("timeout never resends a request or accepts its late response", async (t) => {
  const transport = new AgentTransport(10); t.after(() => transport.dispose());
  const port = connection(); transport.connect(port.port); port.ready();
  const result = await transport.request(request("one"));
  assert.equal(result.error.code, "REQUEST_TIMEOUT");
  port.reply("one", { sessionId: "late" });
  assert.equal(port.sent.length, 1);
  assert.equal(transport.getState().state, "ready");
});

test("disconnect resolves pending requests and ignores callbacks from an old child", async (t) => {
  const transport = new AgentTransport(); t.after(() => transport.dispose());
  const states = []; const events = [];
  transport.onState((state) => states.push(state.state)); transport.onEvent((value) => events.push(value));
  const old = connection(); transport.connect(old.port); old.ready();
  const pending = transport.request(request("one"));
  const next = connection(); transport.connect(next.port); next.ready();
  assert.equal((await pending).error.code, "RUNTIME_UNAVAILABLE");
  old.message({ protocolVersion: 1, kind: "event", sessionId: "s", runId: "r", seq: 1, type: "run.started", data: {} });
  old.close("old process finally exited"); old.ready();
  assert.equal(events.length, 0);
  assert.equal(transport.getState().state, "ready");
  assert.equal(old.removed, 2);
  assert.deepEqual(states, ["unavailable", "ready", "unavailable", "ready"]);
});

test("invalid responses and premature events invalidate the connection", async (t) => {
  const transport = new AgentTransport(); t.after(() => transport.dispose());
  const port = connection(); transport.connect(port.port); port.ready();
  const pending = transport.request(request("one"));
  port.reply("one", { runId: "not-a-session-result" });
  assert.equal((await pending).error.code, "PROTOCOL_MISMATCH");
  assert.equal(transport.getState().state, "unavailable");
  const next = connection(); transport.connect(next.port);
  next.message({ protocolVersion: 1, kind: "event", sessionId: "s", runId: "r", seq: 1, type: "run.started", data: {} });
  next.ready();
  assert.equal(transport.getState().state, "unavailable");
});

test("pending capacity is bounded and postMessage failure releases requests", async (t) => {
  const transport = new AgentTransport(); t.after(() => transport.dispose());
  const port = connection(); transport.connect(port.port); port.ready();
  const requests = Array.from({ length: 128 }, (_, i) => transport.request(request(String(i))));
  assert.equal((await transport.request(request("overflow"))).error.code, "CAPACITY_EXCEEDED");
  port.close("exit");
  assert.equal((await Promise.all(requests)).every((result) => result.error.code === "RUNTIME_UNAVAILABLE"), true);
  const broken = connection(); broken.port.postMessage = () => { throw new Error("port closed"); };
  transport.connect(broken.port); broken.ready();
  assert.equal((await transport.request(request("broken"))).error.code, "RUNTIME_UNAVAILABLE");
});
