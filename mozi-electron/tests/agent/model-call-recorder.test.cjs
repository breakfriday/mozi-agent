const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { ModelCallRecorder } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/model-call/recorder.ts'));
const context = { runId: 'run', provider: 'fixture', model: 'requested', thinkingLevel: 'high' };
const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const api = 'openai-responses';
const plain = value => JSON.parse(JSON.stringify(value));

test('a call combines provider evidence and final SDK usage without mutating its start record', () => {
  const recorder = new ModelCallRecorder(context);
  const start = recorder.getStartRecord();
  const originalStart = plain(start);
  start.model = 'external-mutation';
  recorder.collect(api, { type: 'response.output_item.done', item: { id: 'search', type: 'web_search_call', status: 'completed' } });
  recorder.collect(api, { response: { model: 'actual', usage: {} } });
  const final = recorder.finalize({ stopReason: 'stop', usage: tokens }, {});

  assert.equal(final.id, originalStart.id);
  assert.equal(final.startedAt, originalStart.startedAt);
  for (const [key, value] of Object.entries(context)) assert.equal(final[key], value);
  assert.equal(final.status, 'completed');
  assert.equal(final.responseModelId, 'actual');
  assert.deepEqual(plain(final.usage), tokens);
  assert.equal(final.webSearch, 1);
  assert.equal(final.webSearchSource, 'events');
  assert.deepEqual(plain(final.steps), [{ id: 'search', type: 'web_search', status: 'completed', observed: 'stream' }]);
  assert.ok(final.durationMs >= 0);
  assert.deepEqual(plain(recorder.getStartRecord()), originalStart);
});

test('provider-reported zero tool calls override observed tools while absent counts use events', () => {
  const recorder = new ModelCallRecorder(context);
  for (const type of ['web_search_call', 'web_extractor_call']) {
    recorder.collect(api, { type: 'response.output_item.done', item: { id: type, type, status: 'completed' } });
  }
  recorder.collect(api, { response: { usage: { x_tools: { web_search: { count: 0 } } } } });
  const final = recorder.finalize({ stopReason: 'stop', usage: tokens }, {});
  assert.equal(final.webSearch, 0);
  assert.equal(final.webSearchSource, 'provider');
  assert.equal(final.webExtractor, 1);
  assert.equal(final.webExtractorSource, 'events');
});

test('interruption retains collected evidence and truncation, then rejects late events and repeated finalization', () => {
  const recorder = new ModelCallRecorder(context);
  recorder.collect(api, { response: { model: 'actual' } });
  recorder.collect(api, { type: 'response.output_item.added', item: {
    id: 'search', type: 'web_search_call', action: { query: 'x'.repeat(2049) },
  } });
  const final = recorder.finalize(undefined, { interrupted: true });
  const snapshot = plain(final);
  assert.equal(final.status, 'interrupted');
  assert.equal(final.responseModelId, 'actual');
  assert.equal(final.usage, undefined);
  assert.equal(final.stepsTruncated, true);
  assert.equal(final.steps[0].status, 'running');
  recorder.collect(api, { type: 'response.output_item.done', item: { id: 'search', type: 'web_search_call', status: 'completed' } });
  recorder.collect(api, { response: { model: 'late', usage: { x_tools: { web_search: { count: 2 } } } } });
  assert.equal(recorder.finalize({ stopReason: 'stop', usage: tokens }, {}), undefined);
  assert.equal(recorder.finalize(undefined, { interrupted: true }), undefined);
  assert.deepEqual(plain(final), snapshot);
});
