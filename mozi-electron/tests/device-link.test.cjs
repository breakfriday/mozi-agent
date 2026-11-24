const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");
const createLoader = require("./helpers/load-ts.cjs");

const load = createLoader();
const {
  DeviceLinkService,
  DeviceLinkProtocolError,
  parseIncomingTextFrame,
  serializeOutgoingTextFrame,
} = load(path.resolve(__dirname, "../src/main/services/device-link/index.ts"));

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextWsTextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), 3000);
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      assert.equal(isBinary, false);
      resolve(data.toString("utf8"));
    });
  });
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(payload.byteLength),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("protocol parses HarmonyOS JSON text frames, plain text fallback, and rejects invalid frames", () => {
  const jsonFrame = JSON.stringify({
    type: "text",
    id: "txt_1732456000000_1",
    text: "请看文档 https://developer.huawei.com/consumer/cn/",
    isLink: true,
    timestamp: 1732456000000,
  });
  const parsed = parseIncomingTextFrame(jsonFrame);
  assert.equal(parsed.id, "txt_1732456000000_1");
  assert.equal(parsed.direction, "incoming");
  assert.equal(parsed.isLink, true);
  assert.equal(parsed.url, "https://developer.huawei.com/consumer/cn/");
  assert.equal(parsed.timestamp, 1732456000000);

  const plain = parseIncomingTextFrame("hello from wscat", {
    now: () => 1700000000000,
    createId: () => "txt_fixed",
  });
  assert.equal(plain.id, "txt_fixed");
  assert.equal(plain.text, "hello from wscat");
  assert.equal(plain.isLink, false);

  assert.throws(
    () => parseIncomingTextFrame("   "),
    (err) => err instanceof DeviceLinkProtocolError && err.code === "EMPTY_PAYLOAD",
  );

  assert.throws(
    () => parseIncomingTextFrame("a".repeat(128), { maxBytes: 32 }),
    (err) => err instanceof DeviceLinkProtocolError && err.code === "PAYLOAD_TOO_LARGE",
  );

  assert.throws(
    () => parseIncomingTextFrame(JSON.stringify({ type: "file", url: "/files/a.png" })),
    (err) => err instanceof DeviceLinkProtocolError && err.code === "UNSUPPORTED_FRAME_TYPE",
  );

  const wire = JSON.parse(serializeOutgoingTextFrame(parsed));
  assert.equal(wire.type, "text");
  assert.equal(wire.id, "txt_1732456000000_1");
});

test("DeviceLinkService receives WS text frames, deduplicates IDs, separates binary PCM, and pushes text back", async () => {
  const receivedTexts = [];
  const receivedAudio = [];
  const connected = [];
  const disconnected = [];

  const service = new DeviceLinkService(
    { host: "127.0.0.1", port: 0, path: "/" },
    {
      onTextMessage: (item, client) => receivedTexts.push({ item, client }),
      onAudioFrame: (pcm, client) => receivedAudio.push({ bytes: pcm.byteLength, client }),
      onClientConnected: (client) => connected.push(client),
      onClientDisconnected: (client, code) => disconnected.push({ client, code }),
    },
  );

  const status = await service.start();
  try {
    assert.equal(status.running, true);
    assert.ok(status.port > 0);
    const wsUrl = `ws://127.0.0.1:${status.port}/`;

    const phoneA = await connectWs(wsUrl);
    const phoneB = await connectWs(wsUrl);
    assert.equal(service.getStatus().connectedClients.length, 2);
    assert.equal(connected.length, 2);

    // 1. Phone A sends HarmonyOS JSON text frame -> Server receives + relays to Phone B (not back to A)
    const relayPromise = nextWsTextMessage(phoneB);
    const payload = JSON.stringify({
      type: "text",
      id: "txt_phone_01",
      text: "https://example.com/bridge",
      isLink: true,
      timestamp: 1732456111000,
    });
    phoneA.send(payload);
    // Duplicate ID must be ignored idempotently
    phoneA.send(payload);

    const relayedRaw = await relayPromise;
    const relayed = JSON.parse(relayedRaw);
    assert.equal(relayed.id, "txt_phone_01");
    assert.equal(relayed.text, "https://example.com/bridge");
    assert.equal(receivedTexts.length, 1);
    assert.equal(receivedTexts[0].item.url, "https://example.com/bridge");

    // 2. Binary PCM frame goes to onAudioFrame without polluting text channel
    const pcmChunk = Buffer.alloc(640, 0x12);
    phoneA.send(pcmChunk, { binary: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(receivedAudio.length, 1);
    assert.equal(receivedAudio[0].bytes, 640);
    assert.equal(receivedTexts.length, 1);

    // 3. Desktop actively sends text to connected phones
    const msgAPromise = nextWsTextMessage(phoneA);
    const msgBPromise = nextWsTextMessage(phoneB);
    const sent = service.sendText("来自 Mac 端的投送文本");
    assert.equal(sent.deliveredCount, 2);
    const [fromServerA, fromServerB] = await Promise.all([msgAPromise, msgBPromise]);
    assert.equal(JSON.parse(fromServerA).text, "来自 Mac 端的投送文本");
    assert.equal(JSON.parse(fromServerB).text, "来自 Mac 端的投送文本");
    assert.equal(service.getHistory().length, 2);

    // 4. HTTP /share fallback works and broadcasts to connected WS clients
    const shareRelayPromise = nextWsTextMessage(phoneA);
    const shareRes = await httpPostJson(`http://127.0.0.1:${status.port}/share`, {
      type: "text",
      id: "txt_http_fallback_01",
      text: "离线 HTTP 投送测试",
    });
    assert.equal(shareRes.statusCode, 200);
    assert.equal(shareRes.body.ok, true);
    const shareRelayed = JSON.parse(await shareRelayPromise);
    assert.equal(shareRelayed.id, "txt_http_fallback_01");
    assert.equal(receivedTexts.length, 2);

    // 5. Rejects wrong WS upgrade path with 404
    await assert.rejects(() => connectWs(`ws://127.0.0.1:${status.port}/wrong-path`));

    phoneA.close();
    phoneB.close();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(disconnected.length, 2);
  } finally {
    await service.dispose();
    assert.equal(service.getStatus().running, false);
  }
});

test("DeviceLinkService supports port reconfiguration and cleans up unresponsive sockets via heartbeat", async () => {
  const service = new DeviceLinkService({ host: "127.0.0.1", port: 0, heartbeatMs: 40 });
  try {
    const first = await service.start();
    const ws = await connectWs(`ws://127.0.0.1:${first.port}/`);
    // Suppress automatic pong replies to simulate a dead half-open mobile socket
    ws.pong = () => {};
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(service.getStatus().connectedClients.length, 0);

    const second = await service.start({ host: "127.0.0.1", port: 0, path: "/link" });
    assert.equal(second.path, "/link");
    const ws2 = await connectWs(`ws://127.0.0.1:${second.port}/link`);
    assert.equal(service.getStatus().connectedClients.length, 1);
    ws2.close();
  } finally {
    await service.dispose();
  }
});

