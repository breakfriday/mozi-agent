const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createLoader = require("../helpers/load-ts.cjs");

const {
  composeProjections,
  createSpeechProjection,
  stripCodeBlocks,
} = createLoader()(path.resolve(__dirname, "../../../mozi-app/src/agent/speechProjection.ts"));

const mkEvent = (type, data = {}, sessionId = "sess-1") => ({ sessionId, type, data });
const dummyState = { sessionId: "sess-1", messages: [], tools: [] };

function createMockSink(autoSpeak = true) {
  const actions = [];
  let enabled = autoSpeak;
  return {
    actions,
    setAutoSpeak(val) {
      enabled = val;
    },
    sink: {
      isAutoSpeakEnabled: () => enabled,
      startRunStream: (key, sessionId) => actions.push({ op: "start", key, sessionId }),
      appendDelta: (key, text) => actions.push({ op: "delta", key, text }),
      finishRunStream: (key) => actions.push({ op: "finish", key }),
      stop: () => actions.push({ op: "stop" }),
    },
  };
}

test("speaks assistant text across tool calls in one continuous stream and ignores reasoning, tools and sync", () => {
  const { actions, sink } = createMockSink(true);
  const proj = createSpeechProjection(sink);

  // Snapshot sync MUST NOT trigger any speech
  proj.sync(dummyState);
  assert.equal(actions.length, 0);

  // Reasoning and tool events MUST be ignored
  proj.receive(mkEvent("message.reasoning.delta", { messageId: "m1", partId: "r1", delta: "先思考一下" }), dummyState);
  assert.equal(actions.length, 0);

  // First assistant reply segment before tool call
  proj.receive(mkEvent("message.text.delta", { messageId: "m1", partId: "p1", delta: "我先检查一下" }), dummyState);
  proj.receive(mkEvent("message.text.delta", { messageId: "m1", partId: "p1", delta: "配置文件。" }), dummyState);
  proj.receive(mkEvent("message.completed", { messageId: "m1", content: [] }), dummyState);

  // Tool execution in the middle of the same Run -> ignored without breaking the active stream
  proj.receive(mkEvent("tool.started", { toolCallId: "t1", toolName: "read" }), dummyState);
  proj.receive(mkEvent("tool.output.delta", { toolCallId: "t1", delta: "secret file body" }), dummyState);
  proj.receive(mkEvent("tool.completed", { toolCallId: "t1", outcome: "success", tool: { toolName: "read" } }), dummyState);

  // Second assistant reply segment after tool finishes -> appended to the SAME stream!
  proj.receive(mkEvent("message.text.delta", { messageId: "m2", partId: "p2", delta: "已经修好了。" }), dummyState);
  proj.receive(mkEvent("message.completed", { messageId: "m2", content: [] }), dummyState);
  proj.receive(mkEvent("run.finished", { status: "completed" }), dummyState);

  const starts = actions.filter((a) => a.op === "start");
  const finishes = actions.filter((a) => a.op === "finish");
  assert.equal(starts.length, 1);
  assert.equal(finishes.length, 1);
  assert.equal(starts[0].key, finishes[0].key);

  const combinedText = actions
    .filter((a) => a.op === "delta")
    .map((a) => a.text)
    .join("");
  assert.equal(combinedText, "我先检查一下配置文件。\n已经修好了。\n");
});

test("strips fenced code blocks split across streaming deltas and in full markdown", () => {
  const { actions, sink } = createMockSink(true);
  const proj = createSpeechProjection(sink);

  const chunks = [
    "看下面这段代码：\n``",
    "`ts\nconst secret = 123;\nconsole.log(secret);\n`",
    "``\n代码后面继续解释原因。",
  ];
  for (const delta of chunks) {
    proj.receive(mkEvent("message.text.delta", { messageId: "m1", partId: "p1", delta }), dummyState);
  }
  proj.receive(mkEvent("run.finished", { status: "completed" }), dummyState);

  const spoken = actions
    .filter((a) => a.op === "delta")
    .map((a) => a.text)
    .join("");
  assert.equal(spoken.includes("secret"), false);
  assert.equal(spoken.replace(/\n+/g, "\n"), "看下面这段代码：\n代码后面继续解释原因。");

  assert.equal(
    stripCodeBlocks("前言\n```python\nprint('ignore')\n```\n结论"),
    "前言\n\n结论",
  );
});

test("stops immediately on user prompt, session reset or cancelled run; composeProjections fans out cleanly", () => {
  const { actions, sink, setAutoSpeak } = createMockSink(true);
  let secondaryResets = 0;
  const secondary = {
    user() {},
    receive() {},
    failed() {},
    sync() {},
    reset() {
      secondaryResets += 1;
    },
  };
  const composed = composeProjections(secondary, createSpeechProjection(sink));

  composed.receive(mkEvent("message.text.delta", { messageId: "m1", partId: "p1", delta: "正在说话" }), dummyState);
  composed.receive(mkEvent("run.finished", { status: "cancelled" }), dummyState);
  assert.equal(actions.at(-1).op, "stop");

  // Disabled autoSpeak produces zero commands on delta
  setAutoSpeak(false);
  const countBefore = actions.length;
  composed.receive(mkEvent("message.text.delta", { messageId: "m2", partId: "p2", delta: "静音内容" }), dummyState);
  assert.equal(actions.length, countBefore);

  // Reset fans out to all projections
  composed.reset();
  assert.equal(secondaryResets, 1);
  assert.equal(actions.at(-1).op, "stop");
});
