const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { PiEventMapper, displayParts } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/event-mapper.ts'));
const { isAgentEvent, isParamsFor, isApiResultFor } = load(path.resolve(__dirname, '../../../shared/agent/index.ts'));
const { applyAgentEvent, initialAgentState, installAgentSnapshot } = load(path.resolve(__dirname, '../../../mozi-app/src/agent/agentState.ts'));
const { SessionState, measure } = load(path.resolve(__dirname, '../../src/agent/application/state/session-state.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const event = (type, data, seq = 1) => ({ protocolVersion: 1, kind: 'event', sessionId: 's', runId: 'r', seq, type, data });
const snapshot = messages => ({ session: { sessionId: 's', title: 'Reasoning', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' }, messages, runs: [], tools: [], approvals: [], lastSeq: 0 });

test('Pi reasoning maps native indices and final parts without exposing signatures or opaque blocks', () => {
  const mapper = new PiEventMapper();
  mapper.map({ type: 'message_start', message: { role: 'assistant' } });
  const delta = mapper.map({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '分析' } });
  assert.deepEqual(plain(delta), { type: 'message.reasoning.delta', ordinal: 0, partIndex: 0, delta: '分析' });
  const content = [
    { type: 'thinking', thinking: '分析完成', thinkingSignature: 'do-not-expose' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: '答案' },
  ];
  const complete = mapper.map({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content } });
  assert.deepEqual(plain(complete.parts), [
    { index: 0, type: 'reasoning', text: '分析完成' }, { index: 2, type: 'text', text: '答案' },
  ]);
  assert.deepEqual(plain(displayParts(content, false)), [{ index: 2, type: 'text', text: '答案' }]);
  assert.equal(mapper.map({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content } }), undefined);
  assert.equal(mapper.map({ type: 'message_start', message: { role: 'assistant' } }).ordinal, 1);
});

test('reasoning crosses wire validation and frontend state through completion, cancellation and snapshots', () => {
  let state = initialAgentState('s');
  state = applyAgentEvent(state, event('message.started', { messageId: 'm', role: 'assistant' }));
  const reasoning = event('message.reasoning.delta', { messageId: 'm', partId: 'm:reasoning:0', delta: '分析' }, 2);
  assert.equal(isAgentEvent(reasoning), true);
  assert.equal(isAgentEvent({ ...reasoning, data: { ...reasoning.data, delta: 123 } }), false);
  state = applyAgentEvent(state, reasoning);
  state = applyAgentEvent(state, event('message.text.delta', { messageId: 'm', partId: 'm:text:1', delta: '回答' }, 3));
  assert.throws(() => applyAgentEvent(state, event('message.text.delta', { ...reasoning.data })), /type changed/);
  const cancelled = applyAgentEvent(state, event('run.finished', { status: 'cancelled' }, 4));
  assert.equal(cancelled.messages[0].status, 'cancelled');
  assert.equal(cancelled.messages[0].content[0].text, '分析');
  const content = [{ id: 'm:reasoning:0', type: 'reasoning', text: '完整分析' }, { id: 'm:text:1', type: 'text', text: '完整回答' }];
  const completed = event('message.completed', { messageId: 'm', content }, 4);
  assert.equal(isAgentEvent(completed), true);
  state = applyAgentEvent(state, completed);
  assert.deepEqual(plain(state.messages[0].content), content);
  const snap = snapshot(state.messages);
  assert.equal(isApiResultFor('session.snapshot', { ok: true, result: snap }), true);
  const restored = installAgentSnapshot(initialAgentState('s'), snap);
  assert.deepEqual(plain(restored.messages[0].content), content);
  assert.equal(isParamsFor('run.start', { sessionId: 's', clientMessageId: 'c', content: [{ type: 'reasoning', text: 'no' }] }), false);
  assert.equal(isApiResultFor('session.snapshot', { ok: true, result: snapshot([{ ...state.messages[0], role: 'user' }]) }), false);
});

test('reasoning shares capacity limits and incremental size accounting with text', () => {
  const message = { id: 'm', sessionId: 's', runId: 'r', role: 'assistant', status: 'streaming', content: [] };
  const state = new SessionState({ descriptor: {}, snapshot: snapshot([message]), messageLinks: [] });
  const entry = state.messages.get('m');
  state.appendDelta(entry, 'r0', '中\n', 'reasoning');
  state.appendDelta(entry, 'r0', '文', 'reasoning');
  state.appendDelta(entry, 't1', '答案');
  const actual = measure(message);
  assert.equal(entry.nodes, actual.nodes);
  assert.ok(entry.bytes >= actual.bytes && entry.bytes <= actual.bytes + 2);
  assert.throws(() => state.appendDelta(entry, 'r0', 'wrong', 'text'), error => error.code === 'PROTOCOL_MISMATCH');
  assert.throws(() => state.appendDelta(entry, 'r0', 'x'.repeat(256_000), 'reasoning'), error => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(message.content[0].text, '中\n文');
});
