const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { observeUsage, normalizeUsage } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/usage-monitor.ts'));
const { buildUsageMonitor, isAgentEvent, isApiResultFor } = load(path.resolve(__dirname, '../../../shared/agent'));
const { applyAgentEvent, initialAgentState, installAgentSnapshot } = load(path.resolve(__dirname, '../../../mozi-app/src/agent/agentState.ts'));
const { SessionState } = load(path.resolve(__dirname, '../../src/agent/application/state/session-state.ts'));
const { ServerSteps } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/server-steps.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const tokens = { input: 60, cacheRead: 40, cacheWrite: 0, output: 30, reasoning: 20, totalTokens: 130 };
const base = { id: 'call', runId: 'r', provider: 'fixture', model: 'requested', startedAt: '2026-10-11T00:00:00.000Z', status: 'running' };

test('server steps preserve first observed order, deduplicate lifecycle events and retain only structured metadata', () => {
  const steps = new ServerSteps();
  const observe = (item, done = true) => steps.observe({ type: `response.output_item.${done ? 'done' : 'added'}`, item });
  const search = { id: 'search', type: 'web_search_call', status: 'completed', action: {
    queries: ['合肥天气', '合肥历史天气', '合肥天气'], query: '合肥天气', sources: [
      { url: 'https://example.com/a' }, { url: 'https://example.com/b' }, { url: 'javascript:alert(1)' }, { url: 'https://key:secret@example.com/' },
    ] } };
  observe({ id: 'r1', type: 'reasoning', text: 'private reasoning' }, false);
  observe({ ...search, status: 'in_progress' }, false);
  observe(search); observe(search);
  observe({ id: 'r1', type: 'reasoning', text: 'private reasoning' });
  observe({ id: 'extract', type: 'web_extractor_call', status: 'completed', urls: ['https://example.com/a', 'https://example.com/b'], output: 'private page body' });
  observe({ id: 'r2', type: 'reasoning' });
  steps.observe({ type: 'response.completed', response: { output: [search, { id: 'message', type: 'message', content: 'answer' }] } });
  observe({ id: 'r1', type: 'reasoning' }, false);
  const result = plain(steps.steps);
  assert.deepEqual(result.map(item => item.id), ['r1', 'search', 'extract', 'r2', 'message']);
  assert.deepEqual(result[1].queries, ['合肥天气', '合肥历史天气']);
  assert.deepEqual(result[1].sources, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(result[0].status, 'completed');
  assert.equal(result[4].observed, 'final');
  assert.equal(steps.count('web_search'), 1);
  assert.equal(steps.count('web_extractor'), 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const { isModelCallView } = load(path.resolve(__dirname, '../../../shared/agent'));
  assert.equal(isModelCallView({ ...base, steps: result, webSearchSource: 'events' }), true);
  assert.equal(isModelCallView({ ...base, steps: [{ ...result[1], sources: ['javascript:alert(1)'] }] }), false);
});

test('server step bounds do not truncate completed tool counts or infer absent tool usage', () => {
  const steps = new ServerSteps();
  steps.observe({ type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed' } });
  assert.equal(steps.count('web_search'), undefined, 'missing IDs cannot be counted reliably');
  for (let index = 0; index < 105; index++) steps.observe({ type: 'response.output_item.done', item: {
    id: `search-${index}`, type: 'web_search_call', status: 'completed', action: { queries: Array.from({ length: 40 }, (_, i) => `query ${i}`) },
  } });
  assert.equal(steps.steps.length, 100);
  assert.equal(steps.steps[0].queries.length, 32);
  assert.equal(steps.count('web_search'), 105);
  assert.equal(steps.count('web_extractor'), undefined);
  assert.equal(steps.truncated, true);
  const oversized = new ServerSteps();
  oversized.observe({ type: 'response.output_item.done', item: { id: 'huge', type: 'web_search_call', status: 'completed',
    action: { queries: Array.from({ length: 32 }, (_, i) => `${i}${'汉'.repeat(2000)}`) } } });
  assert.equal(oversized.truncated, true);
  assert.equal(oversized.count('web_search'), 1);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.steps)) <= 64000);
});

test('usage observer counts unique completed server tool events when provider usage omits counts', async () => {
  const records = [];
  const agent = { streamFunction: async (model, context, options) => {
    const item = { id: 'search', type: 'web_search_call', status: 'completed', action: { query: 'fixture' } };
    await options.onProviderStreamEvent({ type: 'response.output_item.done', item }, model);
    await options.onProviderStreamEvent({ type: 'response.completed', response: { output: [item] } }, model);
    return { result: async () => ({ stopReason: 'stop', usage: tokens }) };
  } };
  const observer = observeUsage(agent, 'r', call => records.push(plain(call)));
  const stream = await agent.streamFunction({ api: 'openai-responses', id: 'm', provider: 'p' }, {});
  await stream.result(); observer.dispose();
  assert.equal(records.at(-1).webSearch, 1);
  assert.equal(records.at(-1).webSearchSource, 'events');
  assert.equal(records.at(-1).steps.length, 1);
  assert.equal(records.at(-1).webExtractor, undefined);
});

test('usage observer keeps retries separate, records zero reasoning only when reported, and does not count tool events twice', async () => {
  let index = 0;
  const records = [];
  const agent = { streamFunction: async (model, context, options) => {
    const attempt = index++;
    if (attempt === 0) {
      const tool = { type: 'response.output_item.done', item: { id: 'search-1', type: 'web_search_call', status: 'completed' } };
      await options.onProviderStreamEvent(tool, model);
      await options.onProviderStreamEvent(tool, model);
      await options.onProviderStreamEvent({ response: { model: 'actual', usage: { input_tokens: 100,
        output_tokens_details: { reasoning_tokens: 20 }, x_tools: { web_search: { count: 2 } } } } }, model);
    } else if (attempt === 2) {
      await options.onProviderStreamEvent({ response: { usage: { input_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } } }, model);
    }
    return { result: async () => ({ stopReason: attempt === 1 ? 'aborted' : 'stop',
      usage: attempt === 0 ? tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 } }) };
  } };
  const original = agent.streamFunction;
  const observer = observeUsage(agent, 'r', call => records.push(plain(call)));
  for (let i = 0; i < 3; i++) {
    const stream = await agent.streamFunction({ api: 'openai-responses', id: 'requested', provider: 'fixture' }, {}, { reasoning: i === 0 ? 'high' : undefined });
    await stream.result();
  }
  observer.dispose();
  assert.equal(agent.streamFunction, original);
  assert.equal(records.length, 6);
  const monitor = buildUsageMonitor(records);
  assert.equal(monitor.calls.length, 3);
  assert.equal(monitor.calls[0].webSearch, 2, 'provider count takes precedence over stream event count');
  assert.equal(monitor.calls[0].webSearchSource, 'provider');
  assert.equal(monitor.calls[0].steps.length, 1);
  assert.equal(monitor.calls[0].responseModelId, 'actual');
  assert.equal(monitor.calls[1].usage, undefined, 'an aborted default-zero SDK message has unknown consumption');
  assert.equal(monitor.calls[1].status, 'cancelled');
  assert.equal(monitor.calls[2].usage.reasoning, 0, 'a provider-reported zero remains known');
  assert.equal(monitor.total.totalTokens, 130);
  assert.equal(monitor.total.reasoning, 20);
  assert.equal(monitor.total.unknownCalls, 1);
  assert.equal(monitor.total.reportedCalls, 2);
});

test('completed records replace running ones across backend, wire, reducer and history snapshots', () => {
  const snapshot = { session: { sessionId: 's', title: 'Tokens', createdAt: base.startedAt, updatedAt: base.startedAt }, lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] };
  const backend = new SessionState({ snapshot, messageLinks: [], descriptor: {} });
  let state = initialAgentState('s');
  let seq = 0;
  for (const call of [base, { ...base, status: 'completed', usage: tokens }, { ...base, status: 'completed', usage: tokens }]) {
    const event = { protocolVersion: 1, kind: 'event', sessionId: 's', runId: 'r', seq: ++seq, type: 'usage.updated', data: backend.reportUsage(call) };
    assert.equal(isAgentEvent(event), true);
    assert.equal(isAgentEvent({ ...event, runId: 'other' }), false);
    state = applyAgentEvent(state, event);
  }
  assert.equal(state.usage.calls.length, 1);
  assert.equal(state.usage.total.totalTokens, 130);
  assert.equal(state.usage.total.input + state.usage.total.cacheRead + state.usage.total.cacheWrite + state.usage.total.output, 130);
  assert.equal(isApiResultFor('session.snapshot', { ok: true, result: snapshot }), true);
  const restored = installAgentSnapshot(initialAgentState('s'), snapshot);
  assert.deepEqual(plain(restored.usage), plain(state.usage));
  const empty = installAgentSnapshot(state, { ...snapshot, session: { ...snapshot.session, sessionId: 'other' }, usage: undefined });
  assert.equal(empty.usage, undefined, 'switching session removes previous consumption');
});

test('invalid/missing token data remains unknown and reasoning is never added to total', () => {
  assert.equal(normalizeUsage({ ...tokens, input: -1 }), undefined);
  assert.equal(normalizeUsage({ ...tokens, totalTokens: NaN }), undefined);
  assert.equal(normalizeUsage(undefined), undefined);
  assert.equal(normalizeUsage({ ...tokens, reasoning: 0 }).reasoning, undefined);
  const monitor = buildUsageMonitor([{ ...base, status: 'failed', usage: tokens }, { ...base, id: 'other', runId: 'other', status: 'running' }]);
  assert.equal(monitor.total.totalTokens, 130);
  assert.equal(monitor.total.pendingCalls, 1);
  assert.equal(monitor.runs.length, 2);
  assert.equal(monitor.runs[1].total.reportedCalls, 0);
});

test('legacy native usage coexists with new records and a crashed request remains unknown', async () => {
  const nativeLoad = require('../helpers/load-ts.cjs')({ '@earendil-works/pi-coding-agent': {} });
  const { PiNativeHistory } = nativeLoad(path.resolve(__dirname, '../../src/agent/infrastructure/pi/native-history.ts'));
  const message = (id, usage) => ({ id, type: 'message', timestamp: base.startedAt,
    message: { role: 'assistant', provider: 'fixture', model: 'requested', stopReason: 'stop', usage } });
  const final = { ...base, status: 'completed', usage: tokens };
  const entries = [
    { type: 'custom', customType: 'mozi.run', data: { runId: 'old' } },
    message('old-native', tokens),
    { type: 'custom', customType: 'mozi.provider-response-model', data: { nativeEntryId: 'old-native', responseModelId: 'old-server-model' } },
    { type: 'custom', customType: 'mozi.run', data: { runId: 'r' } },
    { type: 'custom', customType: 'mozi.model-call-usage', data: base },
    { type: 'custom', customType: 'mozi.model-call-usage', data: final },
    message('already-accounted', tokens),
    { type: 'custom', customType: 'mozi.model-call-usage', data: { ...base, id: 'crashed', runId: 'crashed-run' } },
  ];
  const history = await PiNativeHistory.prototype.readUsage.call({ open: () => ({ getEntries: () => entries }) }, {});
  const monitor = buildUsageMonitor(history);
  assert.equal(history.length, 3);
  assert.equal(monitor.total.totalTokens, 260);
  assert.equal(monitor.total.unknownCalls, 1);
  assert.equal(history.find(call => call.id === 'crashed').status, 'interrupted');
  assert.equal(history.find(call => call.id === 'native:old-native').responseModelId, 'old-server-model');
});
