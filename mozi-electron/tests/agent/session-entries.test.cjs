const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const {
  createRunEntry, createUsageEntry, createResponseModelEntry,
  parseRunEntry, parseUsageEntry, parseResponseModelEntry,
} = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-entries.ts'));
const { readHistory, readUsage } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/history-reader.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const timestamp = '2026-10-16T00:00:00.000Z';
const call = { id: 'call', runId: 'run', provider: 'fixture', model: 'requested', startedAt: timestamp, status: 'running' };
const custom = (customType, data) => ({ type: 'custom', customType, data });

test('entry builders preserve the existing JSONL payloads and leave native metadata to Pi', () => {
  const run = createRunEntry({ runId: 'run', clientMessageId: 'client', content: 'must not be persisted here' });
  const usage = createUsageEntry(call);
  const evidence = createResponseModelEntry({ nativeEntryId: 'assistant', responseModelId: 'actual', content: 'must not be persisted here' });
  assert.deepEqual(plain(run), { customType: 'mozi.run', data: { runId: 'run', clientMessageId: 'client' } });
  assert.deepEqual(plain(usage), { customType: 'mozi.model-call-usage', data: call });
  assert.deepEqual(plain(evidence), { customType: 'mozi.provider-response-model', data: { nativeEntryId: 'assistant', responseModelId: 'actual' } });
  for (const [entry, parse] of [[run, parseRunEntry], [usage, parseUsageEntry], [evidence, parseResponseModelEntry]]) {
    const persisted = JSON.parse(JSON.stringify({ id: 'native-id', parentId: null, timestamp, type: 'custom', ...entry }));
    const before = structuredClone(persisted);
    assert.deepEqual(plain(parse(persisted)), plain(entry.data));
    assert.deepEqual(persisted, before);
  }
});

test('run decoding accepts legacy markers and preserves malformed markers as boundaries', () => {
  const legacy = JSON.parse('{"type":"custom","customType":"mozi.run","data":{"runId":"legacy"}}');
  assert.deepEqual(plain(parseRunEntry(legacy)), { runId: 'legacy' });
  for (const data of [undefined, null, false, 7, 'run', [], {}, { runId: 42, clientMessageId: [] }]) {
    assert.deepEqual(plain(parseRunEntry(custom('mozi.run', data))), {}, 'recognized marker still resets identity');
  }
  assert.deepEqual(plain(parseRunEntry(custom('mozi.run', { runId: '' }))), { runId: '' }, 'legacy string acceptance is unchanged');
  for (const entry of [custom('other', { runId: 'foreign' }), { type: 'message', customType: 'mozi.run', data: { runId: 'foreign' } }]) {
    assert.equal(parseRunEntry(entry), undefined);
  }
});

test('usage and response model decoding retain existing validation and ignore unrelated entries', () => {
  const usage = custom('mozi.model-call-usage', call);
  assert.deepEqual(plain(parseUsageEntry(usage)), call);
  assert.equal(parseUsageEntry(usage).status, 'running', 'recovery policy belongs to the reader');
  for (const data of [undefined, null, [], {}, { ...call, status: 'invalid' }, { ...call, durationMs: -1 }]) {
    assert.equal(parseUsageEntry(custom('mozi.model-call-usage', data)), undefined);
  }
  for (const responseModelId of [undefined, null, 3, '', ' ', 'a'.repeat(257), 'a\nb', 'a\rb', 'a\0b']) {
    assert.equal(parseResponseModelEntry(custom('mozi.provider-response-model', { nativeEntryId: 'assistant', responseModelId })), undefined);
  }
  for (const nativeEntryId of [undefined, null, 3]) {
    assert.equal(parseResponseModelEntry(custom('mozi.provider-response-model', { nativeEntryId, responseModelId: 'actual' })), undefined);
  }
  const evidence = custom('mozi.provider-response-model', { nativeEntryId: 'assistant', responseModelId: 'a'.repeat(256) });
  assert.deepEqual(plain(parseResponseModelEntry(evidence)), evidence.data);
  assert.equal(parseUsageEntry({ ...usage, type: 'custom_message' }), undefined);
  assert.equal(parseUsageEntry({ ...usage, customType: 'other' }), undefined);
  assert.equal(parseResponseModelEntry({ ...evidence, type: 'custom_message' }), undefined);
  assert.equal(parseResponseModelEntry({ ...evidence, customType: 'other' }), undefined);
});

test('legacy recovery resets run attribution and ordinals at malformed markers without losing native usage', () => {
  const message = id => ({ type: 'message', id, timestamp, message: {
    role: 'assistant', content: 'answer', provider: 'fixture', model: 'requested', stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  } });
  const entries = [
    custom('mozi.run', { runId: 'run' }),
    custom('mozi.model-call-usage', call),
    message('monitored'),
    custom('mozi.run', { runId: 123 }),
    message('native'),
    custom('mozi.model-call-usage', { ...call, id: 'invalid', status: 'invalid' }),
    custom('mozi.provider-response-model', { nativeEntryId: 'native', responseModelId: 'actual' }),
    custom('mozi.provider-response-model', { nativeEntryId: 'native', responseModelId: '' }),
  ];
  const before = structuredClone(entries);
  const history = plain(readHistory(entries));
  assert.deepEqual(history.map(message => [message.nativeEntryId, message.runId, message.ordinal]), [
    ['monitored', 'run', 0], ['native', undefined, 0],
  ]);
  assert.equal(history[1].responseModelId, 'actual');
  const calls = plain(readUsage(entries));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].status, 'interrupted');
  assert.equal(calls[1].id, 'native:native');
  assert.equal(calls[1].runId, undefined);
  assert.equal(calls[1].responseModelId, 'actual');
  assert.equal(calls[1].usage.totalTokens, 15);
  assert.deepEqual(entries, before);
});
