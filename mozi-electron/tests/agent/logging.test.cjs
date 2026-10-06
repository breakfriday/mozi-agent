const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createLoader = require("../helpers/load-ts.cjs");

function setup(options = {}) {
  const load = createLoader();
  const logging = load(path.resolve(__dirname, "../../../shared/agent/logging.ts"));
  const records = [];
  logging.configureAgentLogging({ enabled: true, ...options }, (record) => records.push(record));
  return { ...logging, records, log: logging.createAgentLogger("renderer") };
}

test("logger includes bodies and tool arguments, with searchable correlation fields", () => {
  const { log, records } = setup();
  const request = { protocolVersion: 1, requestId: "req", method: "run.start", params: {
    sessionId: "session", clientMessageId: "client", content: [{ type: "text", text: "检查播放器正文" }],
  } };
  log.debug("request.send", request);
  log.debug("event.validated", { type: "tool.updated", sessionId: "session", runId: "run", seq: 7,
    data: { tool: { toolCallId: "tool", inputText: '{"playerId":"player-1"}', outputText: "工具输出" } } });
  assert.equal(records[0].requestId, "req"); assert.equal(records[0].clientMessageId, "client");
  assert.equal(records[0].payload.includes("检查播放器正文"), true);
  assert.equal(records[1].toolCallId, "tool"); assert.equal(records[1].seq, 7);
  assert.equal(records[1].payload.includes("player-1"), true);
  assert.equal(records[1].payload.includes("工具输出"), true);
  request.params.content[0].text = "changed later";
  assert.equal(records[0].payload.includes("changed later"), false);
  assert.equal(Object.isFrozen(records[0]), true);
});

test("payload and delta switches work independently and failures remain visible", () => {
  const { log, records, configureAgentLogging } = setup({ payloads: false, deltas: false });
  const event = { type: "message.text.delta", sessionId: "s", runId: "r", seq: 1, data: { delta: "body" } };
  log.debug("event.validated", event); assert.equal(records.length, 0);
  log.error("event.rejected", event, { code: "PROTOCOL_MISMATCH" });
  assert.equal(records.length, 1); assert.equal(records[0].payload, undefined);
  configureAgentLogging({ deltas: true }); log.debug("event.validated", event);
  assert.equal(records.length, 2); assert.equal(records[1].payload, undefined);
  configureAgentLogging({ payloads: true }); log.debug("event.validated", event);
  assert.equal(records[2].payload.includes("body"), true);
});

test("disabled logger does not inspect payloads; live switches affect existing instances", () => {
  const { log, records, configureAgentLogging } = setup();
  let accesses = 0;
  const payload = new Proxy({}, { getOwnPropertyDescriptor() { accesses++; throw new Error("must not inspect"); } });
  configureAgentLogging({ enabled: false }); log.error("request.rejected", payload);
  assert.equal(accesses, 0); assert.equal(records.length, 0);
  configureAgentLogging({ enabled: true, scopes: ["main"] }); log.error("request.rejected", payload);
  assert.equal(accesses, 0);
  configureAgentLogging({ scopes: ["renderer"], level: "warn" });
  log.debug("request.send", {}); assert.equal(records.length, 0);
  log.warn("request.rejected", { code: "INVALID_ARGUMENT" }); assert.equal(records.length, 1);
});

test("large/cyclic/accessor payloads and sink failures cannot affect application flow", () => {
  const { log, records, configureAgentLogging } = setup({ maxPayloadChars: 256 });
  let getterCalls = 0;
  const circular = { text: "x".repeat(1000), get token() { getterCalls++; return "secret"; } };
  circular.self = circular;
  log.debug("request.received", circular);
  assert.equal(getterCalls, 0);
  assert.equal(records[0].payloadTruncated, true); assert.ok(records[0].payload.length <= 256);
  log.debug("request.received", { get content() { getterCalls++; return "body"; } });
  assert.equal(getterCalls, 0); assert.equal(records[1].payload.includes("accessor omitted"), true);
  const self = {}; self.self = self; log.debug("request.received", self);
  assert.equal(records[2].payload.includes("circular"), true);
  configureAgentLogging({}, () => { throw new Error("broken sink"); });
  assert.doesNotThrow(() => log.error("response.rejected", { code: "INTERNAL_ERROR" }));
});

test('provider credentials are redacted even when full request/response payload logging is enabled', () => {
  const { log, records } = setup({ payloads: true });
  log.debug('request.send', { method: 'provider.save', params: { providerId: 'bailian-tp', apiKey: 'never-log-this-secret', name: 'Plan' } });
  log.error('response.rejected', { result: { credentials: { key: 'nested-secret' }, authorization: 'Bearer hidden' } });
  const serialized = JSON.stringify(records);
  for (const secret of ['never-log-this-secret', 'nested-secret', 'Bearer hidden']) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('redacted'), true);
  assert.equal(records[0].method, 'provider.save');
});
