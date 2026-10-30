const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createLoader = require("../helpers/load-ts.cjs");
const { createParticleProjection } = createLoader()(path.resolve(__dirname, "../../../mozi-app/src/agent/particleProjection.ts"));
const pause = () => new Promise(resolve => setTimeout(resolve, 350));
const event = (type, data) => ({ sessionId: "s", type, data });
const state = text => ({ sessionId: "s", messages: [{ id: "a", role: "assistant", status: "streaming", content: [{ type: "text", text }] }], tools: [] });

test("user input is immediate, streaming uses latest text and completion flushes without replaying user confirmations", async () => {
  const sent = [];
  const projection = createParticleProjection(value => sent.push(value));
  projection.user({ clientMessageId: "u", content: [{ type: "text", text: "你好" }] });
  assert.equal(sent[0].role, "user");
  projection.receive(event("message.accepted", {}), state(""));
  assert.equal(sent.length, 1);
  projection.receive(event("message.text.delta", { messageId: "a" }), state("一"));
  for (let i = 0; i < 50; i++) projection.receive(event("message.text.delta", { messageId: "a" }), state(`回答${i}`));
  assert.equal(sent.length, 2);
  await pause();
  assert.equal(sent.at(-1).text, "回答49");
  projection.receive(event("message.completed", { messageId: "a" }), state("完整回答"));
  assert.equal(sent.at(-1).streaming, false);
  assert.equal(sent.at(-1).text, "完整回答");
  projection.reset();
});

test("reset cancels pending text; snapshot sync does not replay old completed history", async () => {
  const sent = [];
  const projection = createParticleProjection(value => sent.push(value));
  projection.receive(event("message.text.delta", { messageId: "a" }), state("第一段"));
  projection.receive(event("message.text.delta", { messageId: "a" }), state("第二段"));
  projection.reset();
  await pause();
  assert.equal(sent.at(-1), null);
  assert.equal(sent.length, 2);
  const history = state("历史"); history.messages[0].status = "completed";
  projection.sync(history);
  assert.equal(sent.length, 2);
  projection.sync(state("恢复中的回答"));
  assert.equal(sent.at(-1).text, "恢复中的回答");
  projection.reset();
});


test("full user questions and assistant Markdown reach the space-aware renderer", () => {
  const sent = [];
  const projection = createParticleProjection(value => sent.push(value));
  const question = "这是需要完整显示的长问题。".repeat(40);
  projection.user({ clientMessageId: "u", content: [{ type: "text", text: question }] });
  assert.equal(sent.at(-1).text, question);
  const markdown = "# 标题\n\n" + "完整内容".repeat(200) + "\n\n```ts\n  const answer = 42;\n```";
  projection.receive(event("message.completed", { messageId: "a" }), state(markdown));
  assert.equal(sent.at(-1).text, markdown);
  projection.reset();
});

test("switching blocks flushes the preceding pending stream instead of dropping its tail", () => {
  const sent = [];
  const projection = createParticleProjection(value => sent.push(value));
  projection.receive(event("message.text.delta", { messageId: "a" }), state("开头"));
  projection.receive(event("message.text.delta", { messageId: "a" }), state("开头和最新内容"));
  projection.receive(event("tool.started", { toolCallId: "t", toolName: "bash" }), state(""));
  assert.equal(sent.at(-2).text, "开头和最新内容");
  assert.equal(sent.at(-1).role, "activity");
  projection.reset();
});

test("agent reasoning, tool lifecycle, approval and finish project through the same adapter", () => {
  const sent = [];
  const projection = createParticleProjection(value => sent.push(value));
  const reasoning = state(""); reasoning.messages[0].content = [{ type: "reasoning", text: "分析问题" }];
  projection.receive(event("message.reasoning.delta", { messageId: "a" }), reasoning);
  assert.equal(sent.at(-1).text, "分析问题");
  projection.receive(event("tool.started", { toolCallId: "t", toolName: "bash" }), state(""));
  assert.equal(sent.at(-1).role, "activity");
  projection.receive(event("tool.completed", { toolCallId: "t", tool: { toolName: "bash" }, outcome: "success" }), state(""));
  assert.equal(sent.at(-1).streaming, false);
  projection.receive(event("approval.requested", {}), state(""));
  assert.equal(sent.at(-1).text, "等待你确认执行");
  projection.receive(event("message.completed", { messageId: "a" }), state("最终回答"));
  projection.receive(event("run.finished", { status: "completed" }), state("最终回答"));
  assert.equal(sent.at(-1).text, "最终回答");
  assert.equal(sent.at(-1).streaming, false);
  projection.reset();
});
