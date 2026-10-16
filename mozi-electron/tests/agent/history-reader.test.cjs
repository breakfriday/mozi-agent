const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const createLoader = require('../helpers/load-ts.cjs');
const load = createLoader();
const { readHistory, readUsage } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/history-reader.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const timestamp = '2026-10-16T00:00:00.000Z';
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const assistant = (stopReason = 'stop') => ({
  role: 'assistant', provider: 'fixture', model: 'requested', api: 'openai-responses',
  content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'answer' }],
  stopReason, usage, timestamp: Date.parse(timestamp),
});

test('history conversion preserves retries, model evidence and native continuations without mutating entries', () => {
  const entries = [
    { type: 'custom', customType: 'mozi.run', data: { runId: 'run' } },
    { type: 'message', id: 'user', timestamp, message: { role: 'user', content: 'question' } },
    { type: 'message', id: 'retry', timestamp, message: assistant('error') },
    { type: 'message', id: 'answer', timestamp, message: assistant() },
    { type: 'custom', customType: 'mozi.provider-response-model', data: { nativeEntryId: 'answer', responseModelId: 'actual' } },
    { type: 'message', id: 'external-user', timestamp, message: { role: 'user', content: 'external continuation' } },
    { type: 'message', id: 'external-answer', timestamp, message: assistant('aborted') },
  ];
  const before = structuredClone(entries);
  const messages = plain(readHistory(entries));
  assert.deepEqual(messages.map(({ nativeEntryId, runId, ordinal, status }) => [nativeEntryId, runId, ordinal, status]), [
    ['user', 'run', 0, 'completed'],
    ['retry', 'run', 0, 'failed'],
    ['answer', 'run', 1, 'completed'],
    ['external-user', undefined, 0, 'completed'],
    ['external-answer', undefined, 0, 'cancelled'],
  ]);
  assert.equal(messages[2].responseModelId, 'actual');
  assert.deepEqual(messages[2].parts, [
    { index: 0, type: 'reasoning', text: 'reasoning' },
    { index: 1, type: 'text', text: 'answer' },
  ]);
  const calls = plain(readUsage(entries));
  assert.deepEqual(calls.map(call => [call.nativeEntryId, call.runId]), [
    ['retry', 'run'], ['answer', 'run'], ['external-answer', undefined],
  ]);
  assert.equal(calls[1].responseModelId, 'actual');
  assert.deepEqual(entries, before);
  assert.deepEqual(plain(readHistory([])), []);
  assert.deepEqual(plain(readUsage([])), []);
});

test('session store reads history from the selected branch and usage across all branches', async t => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const loadNative = createLoader({ '@earendil-works/pi-coding-agent': sdk });
  const { PiSessionStore } = loadNative(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-store.ts'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-history-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new PiSessionStore({ cwd: root, dataDir: root });
  const descriptor = await store.createSession();
  const manager = store.acquire(descriptor);
  assert.throws(() => store.acquire(descriptor), error => error.code === 'SESSION_BUSY');
  const userId = manager.appendMessage({ role: 'user', content: 'question', timestamp: Date.parse(timestamp) });
  const previousAnswerId = manager.appendMessage(assistant());
  manager.branch(userId);
  const currentAnswerId = manager.appendMessage(assistant());
  store.release(descriptor);

  const history = plain(await store.readHistory(descriptor));
  const calls = plain(await store.readUsage(descriptor));
  assert.deepEqual(history.map(message => message.nativeEntryId), [userId, currentAnswerId]);
  assert.deepEqual(calls.map(call => call.nativeEntryId).sort(), [previousAnswerId, currentAnswerId].sort());
  assert.equal(calls.reduce((total, call) => total + call.usage.totalTokens, 0), 30);
  store.acquire(descriptor);
  store.release(descriptor);
});
