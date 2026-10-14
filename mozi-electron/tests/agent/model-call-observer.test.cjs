const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { observeModelCalls } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/model-call/observer.ts'));
const { PiExecution } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/sessions/execution.ts'));
const model = { api: 'openai-responses', provider: 'fixture', id: 'requested' };
const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(onCallUpdated = () => {}) {
  const requests = [], records = [];
  const agent = { async streamFunction(requestModel, context, options) {
    assert.equal(this, agent, 'the SDK stream function keeps its original receiver');
    const completion = deferred();
    const stream = { result: () => completion.promise };
    requests.push({ context, options, completion, stream,
      emit: data => options.onProviderStreamEvent(data, requestModel) });
    return stream;
  } };
  const original = agent.streamFunction;
  const observer = observeModelCalls(agent, { runId: 'run', onCallUpdated(call) {
    records.push(plain(call));
    onCallUpdated(call);
  } });
  async function start(options = {}) {
    const stream = await agent.streamFunction(model, {}, options);
    const request = requests.at(-1);
    assert.equal(stream, request.stream, 'Pi retains the same stream and its sole iterator');
    return request;
  }
  return { agent, original, observer, records, start };
}

test('concurrent calls and retries isolate evidence, and message evidence matches the published record', async () => {
  const f = fixture();
  const first = await f.start(), second = await f.start();
  await first.emit({ response: { model: 'actual-first' } });
  await second.emit({ response: { model: 'conflict-a' } });
  await second.emit({ response: { model: 'conflict-b' } });
  const secondMessage = { stopReason: 'error', usage: tokens };
  second.completion.resolve(secondMessage);
  await second.stream.result();
  assert.equal(f.observer.getResponseModel(secondMessage), undefined);
  assert.equal(f.records.at(-1).responseModelId, undefined);
  assert.equal(f.records.at(-1).status, 'failed');

  const firstMessage = { stopReason: 'stop', usage: tokens };
  first.completion.resolve(firstMessage);
  await first.stream.result().then(message => {
    assert.equal(f.observer.getResponseModel(message), 'actual-first', 'evidence exists before the SDK continuation');
    assert.equal(f.records.at(-1).responseModelId, 'actual-first');
  });
  const retry = await f.start();
  const retryMessage = { stopReason: 'stop', model: 'requested', responseModel: 'not-provider-evidence' };
  retry.completion.resolve(retryMessage);
  await retry.stream.result();
  assert.equal(f.observer.getResponseModel(retryMessage), undefined);
  assert.equal(f.records.at(-1).responseModelId, undefined);
  assert.equal(f.records.at(-1).usage, undefined);
  assert.equal(new Set(f.records.map(call => call.id)).size, 3);
  assert.equal(f.records.length, 6);
  f.observer.dispose();
  assert.equal(f.agent.streamFunction, f.original);
});

test('provider events stay read-only and the existing asynchronous callback is awaited exactly once', async () => {
  const f = fixture();
  const gate = deferred();
  let callbacks = 0;
  const data = Object.freeze({ response: Object.freeze({ model: 'actual' }) });
  const request = await f.start({ onProviderStreamEvent: async (event, providerModel) => {
    assert.equal(event, data);
    assert.equal(providerModel, model);
    callbacks++;
    await gate.promise;
  } });
  let finished = false;
  const delivery = request.emit(data).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(callbacks, 1);
  assert.equal(finished, false);
  gate.resolve();
  await delivery;
  const message = { stopReason: 'stop', usage: tokens };
  request.completion.resolve(message);
  await request.stream.result();
  assert.equal(f.observer.getResponseModel(message), 'actual');
  f.observer.dispose();
});

test('disposing twice interrupts once and ignores late provider evidence and completion', async () => {
  let callbacks = 0;
  const f = fixture(), request = await f.start({ onProviderStreamEvent: () => { callbacks++; } });
  f.observer.dispose();
  f.observer.dispose();
  assert.equal(f.agent.streamFunction, f.original);
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].status, 'interrupted');
  const interrupted = plain(f.records[1]);
  await request.emit({ response: { model: 'too-late', usage: { x_tools: { web_search: { count: 1 } } } } });
  const message = { stopReason: 'stop', usage: tokens };
  request.completion.resolve(message);
  await request.stream.result();
  assert.equal(callbacks, 1, 'the original SDK callback still receives its event');
  assert.equal(f.observer.getResponseModel(message), undefined);
  assert.equal(f.records.length, 2);
  assert.deepEqual(f.records[1], interrupted);
});

test('disposal while the original stream function is awaiting also blocks late completion', async () => {
  const opening = deferred(), completion = deferred(), records = [];
  const stream = { result: () => completion.promise };
  const agent = { streamFunction: async () => { await opening.promise; return stream; } };
  const observer = observeModelCalls(agent, { runId: 'run', onCallUpdated: call => records.push(plain(call)) });
  const pending = agent.streamFunction(model, {});
  observer.dispose();
  opening.resolve();
  assert.equal(await pending, stream);
  completion.resolve({ stopReason: 'stop', usage: tokens });
  await completion.promise;
  assert.deepEqual(records.map(call => call.status), ['running', 'interrupted']);
});

test('result rejection, abort signals and aborted final messages settle only once', async () => {
  for (const mode of ['reject', 'signal', 'message']) {
    const signal = { aborted: false };
    const f = fixture(), request = await f.start({ signal });
    if (mode === 'reject') {
      request.completion.reject(new Error('stream failed'));
      await assert.rejects(request.stream.result(), /stream failed/);
    } else {
      signal.aborted = mode === 'signal';
      request.completion.resolve({ stopReason: mode === 'message' ? 'aborted' : 'stop', usage: tokens });
      await request.stream.result();
    }
    f.observer.dispose();
    assert.equal(f.records.length, 2);
    assert.equal(f.records[1].status, mode === 'reject' ? 'failed' : 'cancelled');
  }
});

test('stream creation and existing callback errors propagate without leaving a running record', async () => {
  for (const callbackFailure of [false, true]) {
    const error = new Error('provider failed'), records = [];
    const agent = { streamFunction: async (model, context, options) => {
      if (callbackFailure) await options.onProviderStreamEvent({ response: { model: 'actual' } }, model);
      throw error;
    } };
    const observer = observeModelCalls(agent, { runId: 'run', onCallUpdated: call => records.push(plain(call)) });
    await assert.rejects(agent.streamFunction(model, {}, { onProviderStreamEvent: () => { throw error; } }), value => value === error);
    observer.dispose();
    assert.deepEqual(records.map(call => call.status), ['running', 'failed']);
  }
});

test('publishing failures remain visible and published records cannot mutate observer state', async () => {
  const failure = new Error('persistence failed');
  const f = fixture(call => { call.model = 'mutated'; throw failure; });
  const request = await f.start();
  request.completion.resolve({ stopReason: 'stop', usage: tokens });
  await request.stream.result();
  f.observer.dispose();
  assert.equal(f.observer.error, failure);
  assert.equal(f.records[1].model, 'requested');
  assert.equal(f.records.length, 2);
});

test('PiExecution surfaces persistence failures from interrupted-call cleanup', async () => {
  const failure = new Error('cannot persist interrupted call');
  const agent = { streamFunction: async () => ({ result: () => new Promise(() => {}) }) };
  const original = agent.streamFunction;
  const session = {
    agent, subscribe: () => () => {}, sendCustomMessage: async () => {},
    prompt: async () => { await agent.streamFunction(model, {}); }, waitForIdle: async () => {},
  };
  const manager = {
    getEntries: () => [], getBranch: () => [],
    appendCustomEntry(type, call) { if (type === 'mozi.model-call-usage' && call.status === 'interrupted') throw failure; },
  };
  const execution = new PiExecution(session, manager);
  await assert.rejects(execution.execute({ runId: 'run', clientMessageId: 'client', content: [{ type: 'text', text: 'test' }] }, () => {}), value => value === failure);
  assert.equal(agent.streamFunction, original);
});

test('PiExecution leaves no installed hook when initialization or subscription fails', async () => {
  for (const stage of ['marker', 'subscribe', 'prompt']) {
    const failure = new Error(stage);
    const agent = { streamFunction() {} };
    const original = agent.streamFunction;
    let unsubscribed = false;
    const session = {
      agent,
      subscribe() {
        if (stage === 'subscribe') throw failure;
        return () => { unsubscribed = true; };
      },
      sendCustomMessage: async () => {},
      prompt: async () => { throw failure; },
    };
    const manager = { appendCustomEntry() { if (stage === 'marker') throw failure; } };
    await assert.rejects(new PiExecution(session, manager).execute({
      runId: 'run', clientMessageId: 'client', content: [{ type: 'text', text: 'test' }],
    }, () => {}), value => value === failure);
    assert.equal(agent.streamFunction, original);
    assert.equal(unsubscribed, stage === 'prompt');
  }
});
