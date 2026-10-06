const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const load = require("../helpers/load-ts.cjs")();
const contract = load(path.resolve(__dirname, "../../../shared/agent"));

const request = (method, params) => ({ protocolVersion: 1, kind: "request", requestId: "req", method, params });
const event = (type, data) => ({ protocolVersion: 1, kind: "event", sessionId: "session", runId: "run", seq: 1, type, data });
const timestamp = "2026-10-05T00:00:00.000Z";

test("every public method has matching parameter and result validation", () => {
  const cases = {
    "runtime.getState": [{}, { state: "unavailable" }],
    "session.create": [{ clientOperationId: "operation" }, { sessionId: "session" }],
    "session.list": [{}, { items: [] }],
    "session.rename": [{ sessionId: "session", title: "Renamed" }, {
      session: { sessionId: "session", title: "Renamed", createdAt: timestamp, updatedAt: timestamp },
    }],
    "session.delete": [{ sessionId: "session" }, { sessionId: "session" }],
    "session.snapshot": [{ sessionId: "session" }, {
      session: { sessionId: "session", title: "Chat", createdAt: timestamp, updatedAt: timestamp },
      lastSeq: 0, messages: [], tools: [], runs: [], approvals: [],
    }],
    "session.subscribe": [{ sessionId: "session" }, { sessionId: "session", subscriptionId: "sub" }],
    "session.unsubscribe": [{ subscriptionId: "sub" }, { removed: true }],
    "run.start": [{ sessionId: "session", clientMessageId: "client", content: [{ type: "text", text: "Hi" }] }, {
      sessionId: "session", runId: "run", clientMessageId: "client", messageId: "message", disposition: "accepted",
    }],
    "run.cancel": [{ sessionId: "session", runId: "run" }, { sessionId: "session", runId: "run", disposition: "already_finished", status: "completed" }],
    "run.get": [{ sessionId: "session", runId: "run" }, {
      id: "run", sessionId: "session", userMessageId: "message", status: "running", createdAt: timestamp, updatedAt: timestamp,
    }],
    "approval.respond": [{ sessionId: "session", runId: "run", approvalId: "approval", decision: "approve" }, {
      approval: { id: "approval", sessionId: "session", runId: "run", toolCallId: "tool", title: "Restart", description: "Restart player", status: "approved", createdAt: timestamp },
      disposition: "applied",
    }],
  };
  assert.deepEqual(Object.values(contract.AGENT_API_METHODS).sort(), Object.keys(cases).sort());
  for (const [method, [params, result]] of Object.entries(cases)) {
    assert.equal(contract.isAgentRequest(request(method, params)), true, method);
    assert.equal(contract.isResponseFor(method, { protocolVersion: 1, kind: "response", requestId: "req", ok: true, result }), true, method);
    assert.equal(contract.isApiResultFor(method, { ok: false, error: { code: "RUNTIME_UNAVAILABLE", message: "Offline" } }), true);
  }
});

test("requests reject unsupported content, extra keys, invalid decisions, and invalid version", () => {
  for (const input of [
    request("session.create", {}),
    request("session.snapshot", { sessionId: "" }),
    request("session.rename", { sessionId: "s", title: "  " }),
    request("session.rename", { sessionId: "s", title: "x".repeat(201) }),
    request("session.delete", { sessionId: "" }),
    request("session.delete", { sessionId: "s", locator: "/tmp/forged" }),
    request("session.list", { limit: 0 }),
    request("session.list", { limit: 101 }),
    request("toString", {}),
    request("run.start", { sessionId: "s", clientMessageId: "c", content: [{ type: "image", resourceId: "r" }] }),
    request("run.start", { sessionId: "s", clientMessageId: "c", content: [] }),
    request("run.start", { sessionId: "s", clientMessageId: "c", content: [{ type: "text", text: " " }] }),
    request("run.cancel", { sessionId: "s", runId: "r", senderId: "forged" }),
    request("approval.respond", { sessionId: "s", runId: "r", approvalId: "a", decision: "execute" }),
    { ...request("session.list", {}), protocolVersion: 2 },
  ]) assert.equal(contract.isAgentRequest(input), false, JSON.stringify(input));
});

test("events validate content IDs and cross-field consistency", () => {
  assert.equal(contract.isAgentEvent(event("message.completed", { messageId: "m", content: [{ id: "p", type: "text", text: "Hi" }] })), true);
  assert.equal(contract.isAgentEvent(event("message.completed", { messageId: "m", content: [{ type: "text", text: "Hi" }] })), false);
  assert.equal(contract.isAgentEvent(event("run.finished", { status: "failed" })), false);
  assert.equal(contract.isAgentEvent({ ...event("run.started", {}), seq: 0 }), false);
  assert.equal(contract.isAgentEvent(event("message.text.delta", { messageId: "m", partId: "p", delta: "hi" })), true);
  const tool = { toolCallId: "tool", runId: "run", toolName: "diagnose", status: "succeeded", inputText: "", outputText: "ok", outputTruncated: false };
  assert.equal(contract.isAgentEvent(event("tool.completed", { toolCallId: "tool", outcome: "succeeded", tool })), true);
  assert.equal(contract.isAgentEvent(event("tool.completed", { toolCallId: "tool", outcome: "failed", tool })), false);
  assert.equal(contract.isAgentEvent(event("tool.updated", { tool: { ...tool, runId: "other-run" } })), false);
});

test("wire validation rejects cycles, classes, accessors, and excessive payloads", () => {
  const circular = {}; circular.self = circular;
  for (const value of [circular, new Array(2), Object.assign(["one"], { extra: true }), new Date(), new Error("failure"), { value: BigInt(1) }, { value: Infinity }, { get value() { throw new Error("must not execute getter"); } }, { text: "x".repeat(contract.AGENT_MAX_MESSAGE_BYTES) }]) {
    assert.equal(contract.isWirePayload(value), false);
  }
  assert.equal(contract.isWirePayload({ optional: undefined, text: "中文", content: [] }), true);
});

test("session mutations reject responses belonging to another session", () => {
  for (const [method, params, result] of [
    ["session.delete", { sessionId: "s" }, { sessionId: "other" }],
    ["session.rename", { sessionId: "s", title: "name" }, { session: { sessionId: "other", title: "name", createdAt: timestamp, updatedAt: timestamp } }],
  ]) assert.equal(contract.responseMatchesRequest(request(method, params), {
    protocolVersion: 1, kind: "response", requestId: "req", ok: true, result,
  }), false);
});
