const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { gzipSync } = require("node:zlib");
const createLoader = require("./helpers/load-ts.cjs");

const load = createLoader();
const protocol = load(path.resolve(__dirname, "../src/main/services/volcengine/tts-protocol.ts"));
const { VolcengineTtsService } = load(path.resolve(__dirname, "../src/main/services/volcengine/index.ts"));
const {
  buildSessionParams,
  handshakeFingerprint,
  splitTextByCodePoints,
} = load(path.resolve(__dirname, "../src/main/services/volcengine/payload.ts"));
const { SessionMachine } = load(path.resolve(__dirname, "../src/main/services/volcengine/session-machine.ts"));

const {
  EventType,
  MsgType,
  MsgTypeFlagBits,
  SerializationBits,
  CompressionBits,
  createMessage,
  marshalMessage,
  unmarshalMessage,
  decodeJsonPayload,
} = protocol;

class FakeWebSocket extends EventEmitter {
  constructor(url, headers) {
    super();
    this.url = url;
    this.headers = headers;
    this.readyState = 0; // CONNECTING
    this.sentFrames = [];
    this.closed = false;
    this.terminated = false;
  }

  send(data, cb) {
    this.sentFrames.push(new Uint8Array(data));
    if (cb) cb();
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  // Test helpers to simulate Volcengine server responses
  serverOpen(logId = "logid-test-001") {
    this.readyState = 1; // OPEN
    this.emit("upgrade", { headers: { "x-tt-logid": logId } });
    this.emit("open");
  }

  serverSendEvent(event, payloadObj = {}, opts = {}) {
    const msg = createMessage(MsgType.FullServerResponse, MsgTypeFlagBits.WithEvent);
    msg.event = event;
    if (opts.connectId) msg.connectId = opts.connectId;
    if (opts.sessionId) msg.sessionId = opts.sessionId;
    const rawJson = Buffer.from(JSON.stringify(payloadObj), "utf8");
    if (opts.gzip) {
      msg.compression = CompressionBits.Gzip;
      msg.payload = new Uint8Array(gzipSync(rawJson));
    } else {
      msg.payload = new Uint8Array(rawJson);
    }
    this.emit("message", Buffer.from(marshalMessage(msg)), true);
  }

  serverSendAudio(sessionId, pcmBytes) {
    const msg = createMessage(MsgType.AudioOnlyServer, MsgTypeFlagBits.WithEvent);
    msg.serialization = SerializationBits.Raw;
    msg.event = EventType.TTSResponse;
    msg.sessionId = sessionId;
    msg.payload = new Uint8Array(pcmBytes);
    this.emit("message", Buffer.from(marshalMessage(msg)), true);
  }

  serverSendErrorFrame(errorCode, payloadObj) {
    const msg = createMessage(MsgType.Error, MsgTypeFlagBits.NoSeq);
    msg.errorCode = errorCode;
    msg.payload = new Uint8Array(Buffer.from(JSON.stringify(payloadObj), "utf8"));
    this.emit("message", Buffer.from(marshalMessage(msg)), true);
  }

  decodedSentMessages() {
    return this.sentFrames.map((frame) => unmarshalMessage(frame));
  }
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("protocol codec round-trips connection, session, audio, error and gzip frames", () => {
  // 1. Gzip compressed server response with connectId
  const connMsg = createMessage(MsgType.FullServerResponse, MsgTypeFlagBits.WithEvent);
  connMsg.event = EventType.ConnectionStarted;
  connMsg.connectId = "conn-uuid-1";
  connMsg.compression = CompressionBits.Gzip;
  connMsg.payload = new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ ok: true }))));

  const parsedConn = unmarshalMessage(marshalMessage(connMsg));
  assert.equal(parsedConn.event, EventType.ConnectionStarted);
  assert.equal(parsedConn.connectId, "conn-uuid-1");
  assert.deepEqual(structuredClone(decodeJsonPayload(parsedConn)), { ok: true });

  // 2. Audio frame with sequence number flag
  const seqAudio = createMessage(MsgType.AudioOnlyServer, MsgTypeFlagBits.PositiveSeq);
  seqAudio.serialization = SerializationBits.Raw;
  seqAudio.sequence = 7;
  seqAudio.payload = new Uint8Array([0x01, 0x02, 0x7f, 0x80]);

  const parsedAudio = unmarshalMessage(marshalMessage(seqAudio));
  assert.equal(parsedAudio.type, MsgType.AudioOnlyServer);
  assert.equal(parsedAudio.sequence, 7);
  assert.deepEqual([...parsedAudio.payload], [0x01, 0x02, 0x7f, 0x80]);

  // 3. Surrogate-pair safe text chunking
  const emojiText = "你好😀世界🚀测试";
  const parts = splitTextByCodePoints(emojiText, 4);
  assert.deepEqual(structuredClone(parts), ["你好😀世", "界🚀测试"]);
});

test("full-duplex streaming buffers pre-ready deltas and reuses warm connection across turns", async () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "ark-secret-key", speaker: "zh_female_vv_uranus_bigtts" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
    },
  );

  const audioChunks = [];
  let completedSummary = null;

  const stream1 = tts.startStream(
    { sessionKey: "mozi-session-1", contextText: "请用温和语气回答" },
    {
      onAudio: (chunk, meta) => audioChunks.push({ bytes: [...chunk], meta }),
      onComplete: (summary) => {
        completedSummary = summary;
      },
      onError: (err) => assert.fail(`Unexpected error: ${err.message}`),
    },
  );

  // Write deltas BEFORE WebSocket even opens or SessionStarted arrives
  stream1.write("你好，");
  stream1.write("欢迎使用墨子助手。");

  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  assert.equal(ws.url, "wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection");
  assert.equal(ws.headers["X-Api-Key"], "ark-secret-key");
  assert.equal(ws.headers["X-Api-Resource-Id"], "seed-tts-2.0");

  ws.serverOpen("logid-turn-1");
  // Sent StartConnection(1) immediately on open
  let sent = ws.decodedSentMessages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, EventType.StartConnection);

  // Server confirms ConnectionStarted(50) -> service immediately sends StartSession(100)
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "cid-1" });
  sent = ws.decodedSentMessages();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, EventType.StartSession);
  const session1Id = sent[1].sessionId;
  const startPayload1 = decodeJsonPayload(sent[1]);
  assert.equal(startPayload1.req_params.audio_params.format, "pcm");
  assert.equal(startPayload1.req_params.audio_params.sample_rate, 24000);
  const additions1 = JSON.parse(startPayload1.req_params.additions);
  assert.equal(additions1.disable_markdown_filter, true);
  assert.equal(
    JSON.stringify(additions1.context_texts),
    JSON.stringify(["请用温和语气回答"]),
  );
  assert.ok(additions1.section_id);

  // Server confirms SessionStarted(150) -> buffered deltas flush as TaskRequest(200)
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: session1Id });
  sent = ws.decodedSentMessages();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].event, EventType.TaskRequest);
  assert.equal(decodeJsonPayload(sent[2]).req_params.text, "你好，欢迎使用墨子助手。");

  // Server streams PCM audio while client streams another live delta and finishes
  ws.serverSendAudio(session1Id, [0x10, 0x00, 0x20, 0x00]);
  stream1.write("再见！");
  stream1.finish();

  sent = ws.decodedSentMessages();
  assert.equal(sent[3].event, EventType.TaskRequest);
  assert.equal(decodeJsonPayload(sent[3]).req_params.text, "再见！");
  assert.equal(sent[4].event, EventType.FinishSession);

  ws.serverSendAudio(session1Id, [0x30, 0x00, 0x40, 0x00]);
  ws.serverSendEvent(
    EventType.SessionFinished,
    { usage: { text_words: 14 } },
    { sessionId: session1Id, gzip: true },
  );

  assert.equal(audioChunks.length, 2);
  assert.equal(audioChunks[0].meta.sampleRate, 24000);
  assert.deepEqual(structuredClone(completedSummary), {
    streamId: stream1.id,
    audioBytes: 8,
    textWords: 14,
    logId: "logid-turn-1",
  });

  // Turn 2: speak() reuses the SAME warm WebSocket connection and same section_id for same sessionKey
  let turn2Done = false;
  tts.speak(
    "第二轮回复",
    { sessionKey: "mozi-session-1" },
    {
      onAudio: () => {},
      onComplete: () => {
        turn2Done = true;
      },
    },
  );

  assert.equal(sockets.length, 1); // No new handshake!
  sent = ws.decodedSentMessages();
  assert.equal(sent[5].event, EventType.StartSession);
  const session2Id = sent[5].sessionId;
  assert.notEqual(session2Id, session1Id);
  const additions2 = JSON.parse(decodeJsonPayload(sent[5]).req_params.additions);
  assert.equal(additions2.section_id, additions1.section_id);

  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: session2Id });
  ws.serverSendEvent(EventType.SessionFinished, { usage: { text_words: 5 } }, { sessionId: session2Id });
  assert.equal(turn2Done, true);

  tts.dispose();
});

test("preemption gates next StartSession until CancelSession completes and drops stale audio", () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
    },
  );

  const events = [];
  const s1 = tts.startStream({}, {
    onAudio: () => events.push("s1:audio"),
    onCancel: () => events.push("s1:cancel"),
    onComplete: () => events.push("s1:complete"),
  });
  s1.write("第一段很长的话");

  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });
  const sid1 = ws.decodedSentMessages()[1].sessionId;
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });
  ws.serverSendAudio(sid1, [1, 2]);
  assert.deepEqual(events, ["s1:audio"]);

  // Rapidly start s2 then s3 while s1 is still active on server (latest-wins!)
  const s2 = tts.startStream({}, {
    onAudio: () => events.push("s2:audio"),
    onCancel: () => events.push("s2:cancel"),
  });
  s2.write("被跳过的中间句");

  const s3 = tts.startStream({}, {
    onAudio: () => events.push("s3:audio"),
    onComplete: () => events.push("s3:complete"),
  });
  s3.write("最终保留的新句子");
  s3.finish();

  // s1 and s2 were cancelled; CancelSession(101) sent for sid1, but s3 MUST NOT send StartSession yet!
  assert.deepEqual(events, ["s1:audio", "s1:cancel", "s2:cancel"]);
  const sentBeforeGate = ws.decodedSentMessages();
  assert.equal(sentBeforeGate.at(-1).event, EventType.CancelSession);
  assert.equal(sentBeforeGate.at(-1).sessionId, sid1);

  // In-flight residual audio from sid1 arrives before SessionCanceled -> MUST be dropped!
  ws.serverSendAudio(sid1, [9, 9, 9, 9]);
  assert.deepEqual(events, ["s1:audio", "s1:cancel", "s2:cancel"]);

  // Server acknowledges SessionCanceled(151) -> gate opens, s3 immediately starts on same socket!
  ws.serverSendEvent(EventType.SessionCanceled, {}, { sessionId: sid1 });
  const sentAfterGate = ws.decodedSentMessages();
  assert.equal(sentAfterGate.at(-1).event, EventType.StartSession);
  const sid3 = sentAfterGate.at(-1).sessionId;

  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid3 });
  ws.serverSendAudio(sid3, [5, 6]);
  ws.serverSendEvent(EventType.SessionFinished, {}, { sessionId: sid3 });
  assert.deepEqual(events, ["s1:audio", "s1:cancel", "s2:cancel", "s3:audio", "s3:complete"]);

  tts.dispose();
});

test("cancel drain timeout breaks deadlocked socket and reconnects cleanly for queued stream", async () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
      timeouts: { cancelDrainMs: 30 },
    },
  );

  const s1 = tts.startStream({}, { onAudio: () => {} });
  s1.write("旧会话");
  sockets[0].serverOpen();
  sockets[0].serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });
  const sid1 = sockets[0].decodedSentMessages()[1].sessionId;
  sockets[0].serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });

  // Preempt with s2, but server hangs and never replies SessionCanceled(151) on sockets[0]
  let s2Completed = false;
  const s2 = tts.speak("新会话自动重连", {}, {
    onAudio: () => {},
    onComplete: () => {
      s2Completed = true;
    },
  });
  assert.ok(s2.id);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sockets[0].terminated, true);
  assert.equal(sockets.length, 2);

  sockets[1].serverOpen();
  sockets[1].serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c2" });
  const sid2 = sockets[1].decodedSentMessages()[1].sessionId;
  sockets[1].serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid2 });
  sockets[1].serverSendEvent(EventType.SessionFinished, {}, { sessionId: sid2 });
  assert.equal(s2Completed, true);

  tts.dispose();
});

test("empty stream short-circuits without starting remote session; unconfigured & HTTP 401 report typed errors", async () => {
  // 1. Unconfigured API key
  const unconfigured = new VolcengineTtsService({});
  let capturedErr = null;
  unconfigured.speak("测试", {}, {
    onAudio: () => {},
    onError: (err) => {
      capturedErr = err;
    },
  });
  await flushMicrotasks();
  assert.equal(capturedErr?.code, "UNCONFIGURED");
  unconfigured.dispose();

  // 2. Empty stream (e.g. pure code block filtered out) finishes locally without StartSession
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "valid-key" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
      timeouts: { idleKeepaliveMs: 25 },
    },
  );

  let emptySummary = null;
  const emptyStream = tts.startStream({}, {
    onAudio: () => {},
    onComplete: (summary) => {
      emptySummary = summary;
    },
  });
  emptyStream.write("");
  emptyStream.finish();
  await flushMicrotasks();
  assert.equal(emptySummary?.audioBytes, 0);
  assert.equal(emptySummary?.textWords, 0);

  // Warm-up connection completes and then gracefully sends FinishConnection(2) after idleKeepaliveMs
  sockets[0].serverOpen();
  sockets[0].serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "idle-c" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sockets[0].decodedSentMessages().at(-1).event, EventType.FinishConnection);
  sockets[0].serverSendEvent(EventType.ConnectionFinished, {}, { connectId: "idle-c" });
  assert.equal(sockets[0].closed, true);

  // 3. HTTP 401 handshake rejection maps to AUTH_FAILED
  let authErr = null;
  tts.speak("鉴权测试", {}, {
    onAudio: () => {},
    onError: (err) => {
      authErr = err;
    },
  });
  assert.equal(sockets.length, 2);
  const res401 = Object.assign(new EventEmitter(), {
    statusCode: 401,
    headers: { "x-tt-logid": "log-401" },
  });
  sockets[1].emit("unexpected-response", {}, res401);
  res401.emit("data", Buffer.from("invalid api key"));
  res401.emit("end");
  assert.equal(authErr?.code, "AUTH_FAILED");
  assert.equal(authErr?.logId, "log-401");

  tts.dispose();
});

test("SessionMachine drives state transitions purely without network or timers", () => {
  const machine = new SessionMachine();
  const params = buildSessionParams(
    { apiKey: "k", additions: { custom_flag: 42 } },
    { contextText: "温和" },
    "sec-1",
  );
  const parsedAdditions = JSON.parse(params.template.req_params.additions);
  assert.equal(parsedAdditions.custom_flag, 42);
  assert.equal(parsedAdditions.disable_markdown_filter, true);

  // 1. Starting a stream from disconnected state emits connection.open
  let effects = machine.handle({
    type: "stream.start",
    stream: { streamId: "s-1", volcSessionId: "v-1", params },
  });
  assert.equal(
    JSON.stringify(effects.map((e) => e.type)),
    JSON.stringify(["timer.clear", "connection.open"]),
  );
  assert.equal(machine.isStreamActive("s-1"), true);

  // 2. Writing text before connection is ready buffers without sending frames
  effects = machine.handle({ type: "stream.write", streamId: "s-1", text: "你好" });
  assert.equal(effects.length, 0);

  // 3. Connection ready promotes pending stream -> emits semantic session.start and starts sessionStart timer
  effects = machine.handle({ type: "connection.ready", connectId: "c-1", logId: "log-1" });
  assert.equal(
    JSON.stringify(effects.map((e) => e.type)),
    JSON.stringify(["diagnostic", "timer.clear", "timer.start", "session.start"]),
  );
  assert.equal(effects[3].volcSessionId, "v-1");

  // 4. SessionStart timeout clears timers, closes socket, fails s-1, and leaves machine clean
  effects = machine.handle({ type: "timer.fired", timer: "sessionStart", streamId: "s-1" });
  assert.equal(
    JSON.stringify(effects.map((e) => e.type)),
    JSON.stringify(["timer.clear", "timer.clear", "timer.clear", "timer.clear", "connection.close", "output"]),
  );
  assert.equal(effects[5].output.type, "failed");
  assert.equal(effects[5].output.error.code, "TIMEOUT");
  assert.equal(machine.isStreamActive("s-1"), false);
});

test("preemption during starting waits for SessionStarted(150) before sending CancelSession(101)", () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
    },
  );

  const trace = [];
  const s1 = tts.startStream({}, {
    onStarted: () => trace.push("s1:started"),
    onAudio: () => trace.push("s1:audio"),
    onCancel: () => trace.push("s1:cancel"),
  });
  s1.write("首句尚未收到150");

  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });

  // StartSession(100) has been sent for s1, SessionStarted(150) NOT yet received
  let sent = ws.decodedSentMessages();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, EventType.StartSession);
  const sid1 = sent[1].sessionId;

  // Preempt s1 with s2 BEFORE 150 arrives
  const s2 = tts.speak("新流抢占", {}, {
    onStarted: () => trace.push("s2:started"),
    onAudio: () => trace.push("s2:audio"),
    onComplete: () => trace.push("s2:complete"),
  });
  assert.ok(s2.id);

  // s1 cancelled immediately for caller, but CancelSession(101) deferred until server confirms 150
  assert.deepEqual(trace, ["s1:cancel"]);
  assert.equal(ws.decodedSentMessages().length, 2);

  // Late SessionStarted(150) for sid1 arrives -> immediately sends CancelSession(101) without firing s1:started
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });
  assert.deepEqual(trace, ["s1:cancel"]);
  sent = ws.decodedSentMessages();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].event, EventType.CancelSession);
  assert.equal(sent[2].sessionId, sid1);

  // Server replies SessionCanceled(151) -> s2 starts on the same warm socket
  ws.serverSendEvent(EventType.SessionCanceled, {}, { sessionId: sid1 });
  sent = ws.decodedSentMessages();
  assert.equal(sockets.length, 1);
  assert.equal(sent[3].event, EventType.StartSession);
  const sid2 = sent[3].sessionId;

  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid2 });
  ws.serverSendEvent(EventType.SessionFinished, {}, { sessionId: sid2 });
  assert.deepEqual(trace, ["s1:cancel", "s2:started", "s2:complete"]);

  tts.dispose();
});

test("unexpected SessionCanceled(151) and duplicate SessionStarted(150) preserve state invariants", () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
    },
  );

  let startedCount = 0;
  let capturedError = null;
  const s1 = tts.startStream({}, {
    onStarted: () => {
      startedCount += 1;
    },
    onAudio: () => {},
    onError: (err) => {
      capturedError = err;
    },
  });
  s1.write("测试异常事件");
  s1.finish();

  const ws = sockets[0];
  ws.serverOpen("log-invariant");
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });
  const sid1 = ws.decodedSentMessages()[1].sessionId;

  // First 150 transitions starting -> streaming -> finishing (since finish() was already called)
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });
  const countAfterFirst150 = ws.decodedSentMessages().length;
  assert.equal(startedCount, 1);
  assert.equal(ws.decodedSentMessages().at(-1).event, EventType.FinishSession);

  // Duplicate 150 while finishing MUST be ignored (no second onStarted, no duplicate FinishSession)
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });
  assert.equal(startedCount, 1);
  assert.equal(ws.decodedSentMessages().length, countAfterFirst150);

  // Server unexpectedly sends 151 without client cancel -> MUST report PROTOCOL_ERROR terminal event
  ws.serverSendEvent(EventType.SessionCanceled, { message: "server aborted" }, { sessionId: sid1 });
  assert.equal(capturedError?.code, "PROTOCOL_ERROR");
  assert.equal(capturedError?.logId, "log-invariant");
  assert.equal(s1.active, false);

  tts.dispose();
});

test("sessionFinish inactivity watchdog renews on audio progress and times out when stalled", async () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
      timeouts: { sessionFinishMs: 45 },
    },
  );

  let finishErr = null;
  tts.speak("长段尾音收尾看门狗测试", {}, {
    onAudio: () => {},
    onError: (err) => {
      finishErr = err;
    },
  });

  const ws = sockets[0];
  ws.serverOpen("log-finish-watchdog");
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });
  const sid = ws.decodedSentMessages()[1].sessionId;
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid });

  // Stream is now in finishing; feed audio twice at 25ms intervals (total 50ms > 45ms) -> MUST NOT timeout
  await new Promise((r) => setTimeout(r, 25));
  ws.serverSendAudio(sid, [1, 2]);
  await new Promise((r) => setTimeout(r, 25));
  ws.serverSendAudio(sid, [3, 4]);
  assert.equal(finishErr, null);
  assert.equal(ws.terminated, false);

  // Now stall without sending SessionFinished(152) -> watchdog fires after 45ms
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(finishErr?.code, "TIMEOUT");
  assert.equal(ws.terminated, true);

  tts.dispose();
});

test("reentrant callbacks (start in onCancel, dispose in onAudio) & config fingerprint validation", async () => {
  const sockets = [];
  const tts = new VolcengineTtsService(
    { apiKey: "key-1" },
    {
      createWebSocket: (url, headers) => {
        const ws = new FakeWebSocket(url, headers);
        sockets.push(ws);
        return ws;
      },
    },
  );

  // 1. Changing unused legacy appId when apiKey is set does not alter handshake fingerprint
  assert.equal(
    handshakeFingerprint({ apiKey: "key-1" }),
    handshakeFingerprint({ apiKey: "key-1", appId: "unused-app", accessKey: "unused-token" }),
  );

  // 2. Invalid ogg_opus + 24000Hz combination fails fast locally
  let formatErr = null;
  tts.speak("格式校验", { format: "ogg_opus", sampleRate: 24000 }, {
    onAudio: () => {},
    onError: (err) => {
      formatErr = err;
    },
  });
  await flushMicrotasks();
  assert.equal(formatErr?.code, "INVALID_ARGUMENT");

  // 3. Reentrant startStream inside onCancel + reentrant dispose inside onAudio
  const events = [];
  let s2 = null;
  const s1 = tts.startStream({}, {
    onAudio: () => {},
    onCancel: () => {
      events.push("s1:cancel");
      s2 = tts.speak("回调内重入开启的新流", {}, {
        onAudio: () => {
          events.push("s2:audio->dispose");
          tts.dispose();
        },
        onCancel: () => events.push("s2:cancel-on-dispose"),
      });
    },
  });
  s1.write("旧流排队文本");

  const ws = sockets[0];
  ws.serverOpen();
  ws.serverSendEvent(EventType.ConnectionStarted, {}, { connectId: "c1" });
  const sid1 = ws.decodedSentMessages()[1].sessionId;
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid1 });

  // Cancel s1 -> onCancel synchronously starts s2 -> server confirms 151 -> s2 starts
  s1.cancel();
  ws.serverSendEvent(EventType.SessionCanceled, {}, { sessionId: sid1 });
  const sid2 = ws.decodedSentMessages().at(-1).sessionId;
  ws.serverSendEvent(EventType.SessionStarted, {}, { sessionId: sid2 });

  // Sending audio triggers onAudio -> calls tts.dispose() reentrantly -> socket terminated cleanly
  ws.serverSendAudio(sid2, [7, 8]);
  assert.deepEqual(events, ["s1:cancel", "s2:audio->dispose", "s2:cancel-on-dispose"]);
  assert.equal(ws.terminated, true);
  assert.equal(s2.active, false);
});

