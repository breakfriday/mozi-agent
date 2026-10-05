const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const load = require("../helpers/load-ts.cjs")();
const { createAgentPreloadApi } = load(path.resolve(__dirname, "../../src/preload/agent.ts"));
const { createAgentApi } = load(path.resolve(__dirname, "../../../mozi-app/src/runtime/agent.ts"));

function setup(t, invoke, timeoutMs) {
  const ipc = new EventEmitter(); const sent = []; let count = 0;
  ipc.invoke = (channel, request) => { sent.push({ channel, request }); return invoke(request); };
  const preload = createAgentPreloadApi(ipc, { requestId: () => `request-${++count}`, timeoutMs });
  t.after(() => preload.dispose());
  return { ...preload, ipc, sent };
}
const response = (request, result) => ({ protocolVersion: 1, kind: "response", requestId: request.requestId, ok: true, result });

test("preload creates new request IDs while preserving submission identity", async (t) => {
  const { api, sent } = setup(t, async (request) => response(request, {
    sessionId: "s", runId: "r", messageId: "m", clientMessageId: "c", disposition: "duplicate",
  }));
  const input = { sessionId: "s", clientMessageId: "c", content: [{ type: "text", text: "hi" }] };
  assert.equal((await api.startRun(input)).result.runId, "r");
  await api.startRun(input);
  assert.notEqual(sent[0].request.requestId, sent[1].request.requestId);
  assert.equal(sent[0].request.params.clientMessageId, sent[1].request.params.clientMessageId);
  assert.equal((await api.createSession({})).error.code, "INVALID_ARGUMENT");
  assert.equal(sent.length, 2);
});

test("preload rejects wrong request, session and response types", async (t) => {
  for (const build of [
    (request) => ({ ...response(request, { sessionId: "s", runId: "r", messageId: "m", clientMessageId: "c", disposition: "accepted" }), requestId: "other" }),
    (request) => response(request, { sessionId: "other-session", runId: "r", messageId: "m", clientMessageId: "c", disposition: "accepted" }),
    (request) => response(request, { sessionId: "s" }),
    (request) => ({ ...response(request, null), protocolVersion: 2 }),
  ]) {
    const { api } = setup(t, async (request) => build(request));
    assert.equal((await api.startRun({ sessionId: "s", clientMessageId: "c", content: [{ type: "text", text: "hi" }] })).error.code, "PROTOCOL_MISMATCH");
  }
});

test("unavailable notice immediately invalidates pending work and ignores late success", async (t) => {
  let resolve; let original;
  const { api, ipc } = setup(t, (request) => { original = request; return new Promise((done) => { resolve = done; }); });
  const states = []; const off = api.onRuntimeState((notice) => states.push(notice.state));
  const pending = api.createSession({ clientOperationId: "op" });
  ipc.emit("mozi:agent:runtime", {}, { state: "unavailable" });
  assert.equal((await pending).error.code, "RUNTIME_UNAVAILABLE");
  resolve(response(original, { sessionId: "late" }));
  ipc.emit("mozi:agent:runtime", {}, { state: "ready" });
  assert.deepEqual(states, ["unavailable", "ready"]); off();
  ipc.emit("mozi:agent:runtime", {}, { state: "unavailable" }); assert.equal(states.length, 2);
});

test("timeout and invoke rejection return data errors; dispose removes all listeners", async (t) => {
  const stalled = setup(t, () => new Promise(() => {}), 10);
  assert.equal((await stalled.api.createSession({ clientOperationId: "op" })).error.code, "REQUEST_TIMEOUT");
  const failed = setup(t, async () => { throw new Error("Electron handler missing"); });
  assert.equal((await failed.api.getRuntimeState()).error.code, "RUNTIME_UNAVAILABLE");
  failed.api.onEvent(() => {}); failed.api.onRuntimeState(() => {});
  failed.dispose(); assert.equal(failed.ipc.eventNames().length, 0);
  assert.equal((await failed.api.getRuntimeState()).error.code, "RUNTIME_UNAVAILABLE");
});

test("malformed events trigger resynchronization instead of corrupting UI state", async (t) => {
  const { api, ipc } = setup(t, async (request) => response(request, { state: "ready" }));
  const events = []; const states = [];
  api.onEvent((event) => events.push(event)); api.onRuntimeState((notice) => states.push(notice));
  ipc.emit("mozi:agent:event", { privileged: true }, { type: "message.text.delta", data: { delta: "missing identity" } });
  assert.equal(events.length, 0); assert.equal(states.at(-1).state, "unavailable");
});

test("renderer browser fallback and local Error retain structured error codes", async () => {
  const browser = createAgentApi(() => undefined);
  assert.equal((await browser.getRuntimeState()).state, "unavailable");
  await assert.rejects(browser.createSession({ clientOperationId: "op" }), (error) => error.code === "RUNTIME_UNAVAILABLE");
  assert.doesNotThrow(() => browser.onEvent(() => {})());
  const api = createAgentApi(() => ({ createSession: async () => structuredClone({ ok: false, error: { code: "PERMISSION_DENIED", message: "Denied" } }) }));
  await assert.rejects(api.createSession({ clientOperationId: "op" }), (error) => {
    assert.equal(error.name, "AgentApiError"); assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(error.appError.message, "Denied"); return true;
  });
});
