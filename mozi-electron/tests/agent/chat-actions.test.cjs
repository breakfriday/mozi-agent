const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createLoader = require("../helpers/load-ts.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const timestamp = "2026-10-05T00:00:00.000Z";

function setup(t, options = {}) {
  const load = createLoader();
  const { createAgentActions } = load(path.resolve(__dirname, "../../../mozi-app/src/agent/createAgentActions.ts"));
  const { initialAgentState } = load(path.resolve(__dirname, "../../../mozi-app/src/agent/agentState.ts"));
  let state = initialAgentState(options.sessionId ?? null);
  const store = { getState: () => state, setState: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; } };
  const calls = []; const eventListeners = new Set(); const runtimeListeners = new Set();
  const snapshot = () => ({ session: { sessionId: "s", title: "Chat", createdAt: timestamp, updatedAt: timestamp }, lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] });
  const api = {
    onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onRuntimeState: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
    getRuntimeState: async () => ({ state: "ready" }),
    createSession: async (input) => { calls.push(["create", input]); return { sessionId: "s" }; },
    subscribeSession: async (input) => { calls.push(["subscribe", input]); return { sessionId: "s", subscriptionId: "sub" }; },
    unsubscribeSession: async (input) => { calls.push(["unsubscribe", input]); return { removed: true }; },
    getSessionSnapshot: async () => { calls.push(["snapshot"]); return snapshot(); },
    startRun: async (input) => { calls.push(["start", input]); return { sessionId: "s", runId: "r", messageId: "u", clientMessageId: input.clientMessageId, disposition: "accepted" }; },
    cancelRun: async (input) => { calls.push(["cancel", input]); return { ...input, disposition: "requested" }; },
    ...options.api,
  };
  const actions = createAgentActions(api, store);
  t.after(() => actions.dispose());
  let seq = 0;
  const emit = (type, data, sequence = ++seq) => {
    for (const listener of eventListeners) listener({ protocolVersion: 1, kind: "event", sessionId: "s", runId: "r", seq: sequence, type, data });
  };
  const runtime = (state) => { for (const listener of runtimeListeners) listener({ state }); };
  return { actions, api, store, calls, emit, runtime, snapshot, eventListeners, runtimeListeners };
}

test("offline chat uses real API calls, retains input and never creates a mock answer", async (t) => {
  const creates = [];
  const { actions, store, eventListeners, runtimeListeners } = setup(t, { api: {
    getRuntimeState: async () => ({ state: "unavailable" }),
    createSession: async (input) => { creates.push(input); throw { code: "RUNTIME_UNAVAILABLE", message: "Offline" }; },
  } });
  actions.initialize(); await tick();
  assert.equal(eventListeners.size, 1); assert.equal(runtimeListeners.size, 1);
  await actions.submit("检查播放器");
  const clientId = store.getState().pendingSubmission.clientMessageId;
  assert.equal(store.getState().error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(store.getState().pendingSubmission.status, "rejected");
  assert.equal(store.getState().messages.length, 0); assert.equal(store.getState().isSubmitting, false);
  await actions.retry();
  assert.equal(creates.length, 2); assert.equal(creates[0].clientOperationId, creates[1].clientOperationId);
  assert.equal(store.getState().pendingSubmission.clientMessageId, clientId);
});

test("create → subscribe → snapshot → start handles events before acceptance without duplicates", async (t) => {
  const context = setup(t); const { actions, api, calls, emit, store } = context;
  api.startRun = async (input) => {
    calls.push(["start", input]);
    emit("run.updated", { run: { id: "r", sessionId: "s", userMessageId: "u", status: "running", createdAt: timestamp, updatedAt: timestamp } });
    emit("message.accepted", { message: { id: "u", sessionId: "s", runId: "r", role: "user", content: [{ id: "up", type: "text", text: "hello" }], status: "completed", clientMessageId: input.clientMessageId } });
    emit("message.started", { messageId: "a", role: "assistant" });
    emit("message.text.delta", { messageId: "a", partId: "ap", delta: "真实事件" });
    emit("message.completed", { messageId: "a", content: [{ id: "ap", type: "text", text: "真实事件" }] });
    emit("run.finished", { status: "completed" });
    return { sessionId: "s", runId: "r", messageId: "u", clientMessageId: input.clientMessageId, disposition: "accepted" };
  };
  actions.initialize(); await tick(); await actions.submit("hello");
  assert.deepEqual(calls.slice(0, 4).map(([method]) => method), ["create", "subscribe", "snapshot", "start"]);
  assert.equal(store.getState().messages.length, 2);
  assert.equal(store.getState().messages[1].content[0].text, "真实事件");
  assert.equal(store.getState().activeRunId, null); assert.equal(store.getState().pendingSubmission, null);
  assert.equal(store.getState().runs[0].status, "completed"); assert.equal(store.getState().lastSeq, 6);
});

test("snapshot buffers and deduplicates deltas, and a later gap starts one recovery", async (t) => {
  const context = setup(t, { sessionId: "s" }); const { actions, api, store, snapshot, emit } = context;
  let snapshots = 0; let recover;
  const message = { id: "a", sessionId: "s", runId: "r", role: "assistant", content: [{ id: "p", type: "text", text: "A" }], status: "streaming" };
  api.getSessionSnapshot = async () => {
    if (++snapshots > 1) return new Promise((resolve) => { recover = resolve; });
    emit("message.text.delta", { messageId: "a", partId: "p", delta: "B" }, 2);
    emit("message.text.delta", { messageId: "a", partId: "p", delta: "B" }, 2);
    return { ...snapshot(), lastSeq: 1, messages: [message] };
  };
  actions.initialize(); await tick();
  assert.equal(store.getState().messages[0].content[0].text, "AB");
  emit("message.text.delta", { messageId: "a", partId: "p", delta: "D" }, 4);
  emit("message.text.delta", { messageId: "a", partId: "p", delta: "E" }, 5);
  assert.equal(snapshots, 2);
  recover({ ...snapshot(), lastSeq: 5, messages: [{ ...message, content: [{ id: "p", type: "text", text: "ABCDE" }] }] });
  await tick(); assert.equal(store.getState().lastSeq, 5); assert.equal(store.getState().syncStatus, "ready");
  assert.equal(store.getState().messages[0].content[0].text, "ABCDE");
});

test("timeout retry reuses original submission; duplicate acceptance synchronizes its terminal state", async (t) => {
  const { actions, api, store, snapshot } = setup(t);
  const starts = [];
  api.startRun = async (input) => {
    starts.push(input);
    if (starts.length === 1) throw { code: "REQUEST_TIMEOUT", message: "Unknown" };
    return { sessionId: "s", runId: "r", messageId: "u", clientMessageId: input.clientMessageId, disposition: "duplicate" };
  };
  actions.initialize(); await tick(); await actions.submit("same text");
  assert.equal(store.getState().pendingSubmission.status, "unknown");
  await actions.submit("new text"); assert.equal(starts.length, 1);
  api.getSessionSnapshot = async () => ({ ...snapshot(), lastSeq: 3, runs: [{ id: "r", sessionId: "s", userMessageId: "u", status: "completed", createdAt: timestamp, updatedAt: timestamp }], messages: [{
    id: "u", sessionId: "s", runId: "r", role: "user", content: [{ id: "p", type: "text", text: "same text" }], status: "completed", clientMessageId: starts[0].clientMessageId,
  }] });
  await actions.retry();
  assert.equal(starts[0].clientMessageId, starts[1].clientMessageId);
  assert.equal(starts[1].content[0].text, "same text");
  assert.equal(store.getState().pendingSubmission, null); assert.equal(store.getState().activeRunId, null);
});

test("restart ignores old snapshots and cleanup never cancels a running Run", async (t) => {
  const { actions, api, store, snapshot, runtime, calls, eventListeners, runtimeListeners } = setup(t, { sessionId: "s" });
  let resolveOld; let reads = 0;
  api.getSessionSnapshot = async () => ++reads === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : { ...snapshot(), lastSeq: 8 };
  actions.initialize(); await tick(); runtime("unavailable"); runtime("ready"); await tick();
  resolveOld({ ...snapshot(), lastSeq: 100 }); await tick(); assert.equal(store.getState().lastSeq, 8);
  store.setState({ activeRunId: "current" }); await actions.cancel();
  assert.equal(calls.find(([method]) => method === "cancel")[1].runId, "current");
  actions.dispose();
  assert.equal(eventListeners.size, 0); assert.equal(runtimeListeners.size, 0);
  assert.equal(calls.filter(([method]) => method === "cancel").length, 1);
  actions.initialize(); await tick(); assert.equal(eventListeners.size, 1);
});
