const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const createLoader = require('../helpers/load-ts.cjs');
const load = createLoader();
const { PiExecution } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/execution.ts'));
const { observeExecution } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/execution-observer.ts'));
const model = { api: 'openai-responses', provider: 'fixture', id: 'requested' };
const input = { runId: 'run', clientMessageId: 'client', content: [{ type: 'text', text: 'test' }] };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const order = [], entries = [];
  let listener;
  const agent = { streamFunction: async () => ({ result: () => new Promise(() => {}) }) };
  const original = agent.streamFunction;
  const session = {
    agent,
    subscribe(callback) { listener = callback; return () => order.push('unsubscribe'); },
    async sendCustomMessage() { order.push('context'); },
    async prompt() { order.push('prompt'); },
    async waitForIdle() { order.push('idle'); },
    async abort() { order.push('abort'); },
    dispose() { order.push('dispose'); },
    ...overrides,
  };
  const manager = {
    appendCustomEntry(type, data) { entries.push({ type, data }); },
    getEntries: () => [], getBranch: () => [],
  };
  const execution = new PiExecution(session, manager, () => order.push('release'));
  return { execution, session, manager, agent, original, order, entries, event: event => listener(event) };
}

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
  for (const stage of ['marker', 'subscribe', 'context', 'prompt', 'idle']) {
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
      sendCustomMessage: async () => { if (stage === 'context') throw failure; },
      prompt: async () => { if (stage === 'prompt') throw failure; },
      waitForIdle: async () => { throw failure; },
      abort: async () => {},
    };
    const manager = { appendCustomEntry() { if (stage === 'marker') throw failure; } };
    await assert.rejects(new PiExecution(session, manager).execute({
      runId: 'run', clientMessageId: 'client', content: [{ type: 'text', text: 'test' }],
    }, () => {}), value => value === failure);
    assert.equal(agent.streamFunction, original);
    assert.equal(unsubscribed, ['context', 'prompt', 'idle'].includes(stage));
  }
});

test('unsubscribe failure still restores the stream hook and settles pending calls exactly once', async () => {
  const error = new Error('unsubscribe failed');
  let listener, unsubscribes = 0;
  const f = fixture({ subscribe(callback) {
    listener = callback;
    return () => { unsubscribes++; throw error; };
  } });
  f.manager.getEntries = () => [{ type: 'message', message: { role: 'user', content: 'title' } }];
  f.manager.getSessionName = () => undefined;
  const events = [];
  const observer = observeExecution(f.session, f.manager, {
    runId: 'run', emit: event => events.push(event), isCancelled: () => false,
    onError: () => assert.fail('cleanup must not start another cancellation'),
  });
  await f.agent.streamFunction(model, {});
  listener({ type: 'message_end', message: { role: 'user' } });
  observer.dispose();
  observer.dispose();
  await Promise.resolve();
  listener({ type: 'message_start', message: { role: 'assistant' } });
  assert.throws(() => observer.throwIfFailed(), value => value === error);
  assert.equal(unsubscribes, 1);
  assert.equal(f.agent.streamFunction, f.original);
  assert.deepEqual(events.map(event => [event.type, event.call?.status]), [
    ['usage.update', 'running'], ['usage.update', 'interrupted'],
  ], 'queued titles and late session events must not escape after disposal');
});

test('execution reports unsubscribe failures after restoring its hook', async () => {
  const error = new Error('unsubscribe failed');
  const f = fixture({ subscribe: () => () => { throw error; } });
  await assert.rejects(f.execution.execute(input, () => {}), value => value === error);
  assert.equal(f.agent.streamFunction, f.original);
  f.execution.dispose();
  assert.deepEqual(f.order.slice(-2), ['dispose', 'release']);
});

test('cancellation during context preparation prevents prompt and keeps reservation until abort settles', async () => {
  const context = deferred(), aborted = deferred();
  const f = fixture({
    sendCustomMessage: () => context.promise,
    async abort() { f.order.push('abort'); await aborted.promise; },
  });
  const running = f.execution.execute(input, () => {});
  const firstCancel = f.execution.cancel(), secondCancel = f.execution.cancel();
  assert.equal(firstCancel, secondCancel);
  f.execution.dispose();
  f.execution.dispose();
  context.resolve();
  await Promise.resolve();
  assert.equal(f.order.includes('prompt'), false);
  assert.equal(f.order.includes('release'), false);
  aborted.resolve();
  await Promise.all([running, firstCancel, secondCancel]);
  assert.deepEqual(f.order, ['abort', 'idle', 'unsubscribe', 'dispose', 'release']);
  assert.equal(f.agent.streamFunction, f.original);
  await f.execution.cancel();
  f.execution.dispose();
  assert.equal(f.order.filter(item => item === 'release').length, 1);
});

test('disposing an active execution waits for the prompt before releasing its SDK session', async () => {
  const prompt = deferred(), entered = deferred();
  const f = fixture({ async prompt() { entered.resolve(); await prompt.promise; } });
  const running = f.execution.execute(input, () => {});
  await entered.promise;
  await assert.rejects(f.execution.execute(input, () => {}), error => error.code === 'INVALID_ARGUMENT');
  f.execution.dispose();
  await Promise.resolve();
  assert.equal(f.order.includes('release'), false);
  assert.notEqual(f.agent.streamFunction, f.original);
  prompt.resolve();
  await running;
  assert.equal(f.agent.streamFunction, f.original);
  assert.deepEqual(f.order.slice(-3), ['unsubscribe', 'dispose', 'release']);
});

test('cancelled, completed and disposed executions never start an extra run', async () => {
  const cancelled = fixture();
  await cancelled.execution.cancel();
  await cancelled.execution.execute(input, () => {});
  assert.deepEqual(cancelled.entries, []);
  cancelled.execution.dispose();
  assert.deepEqual(cancelled.order, ['dispose', 'release']);

  const completed = fixture();
  await completed.execution.execute(input, () => {});
  await assert.rejects(completed.execution.execute(input, () => {}), error => error.code === 'INVALID_ARGUMENT');
  completed.execution.dispose();
  await assert.rejects(completed.execution.execute(input, () => {}), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(completed.entries.filter(entry => entry.type === 'mozi.run').length, 1);
});

test('SDK disposal failure releases the reservation once and prevents reuse', async () => {
  const error = new Error('SDK dispose failed');
  const f = fixture({ dispose() { f.order.push('dispose'); throw error; } });
  assert.throws(() => f.execution.dispose(), value => value === error);
  f.execution.dispose();
  await f.execution.cancel();
  await assert.rejects(f.execution.execute(input, () => {}), error => error.code === 'INVALID_ARGUMENT');
  assert.deepEqual(f.order, ['dispose', 'release']);
});

test('observer failures abort once and remain failures without requiring user cancellation', async () => {
  const error = new Error('event delivery failed');
  const f = fixture({ async prompt() {
    f.event({ type: 'message_start', message: { role: 'assistant' } });
    f.event({ type: 'message_start', message: { role: 'assistant' } });
  } });
  await assert.rejects(f.execution.execute(input, () => { throw error; }), value => value === error);
  assert.equal(f.order.filter(item => item === 'abort').length, 1);
  assert.equal(f.agent.streamFunction, f.original);
  f.execution.dispose();
});

test('failed cancellation still cleans observation and a requested disposal', async () => {
  const error = new Error('abort failed');
  const context = deferred();
  const f = fixture({ sendCustomMessage: () => context.promise, abort: async () => { throw error; } });
  const running = f.execution.execute(input, () => {});
  const rejected = assert.rejects(running, value => value === error);
  f.execution.dispose();
  context.resolve();
  await rejected;
  assert.equal(f.agent.streamFunction, f.original);
  assert.deepEqual(f.order.slice(-3), ['unsubscribe', 'dispose', 'release']);
});

test('prompt rejection waits for SDK abort before failing and releasing a requested disposal', async () => {
  const error = new Error('prompt failed');
  const aborted = deferred(), abortStarted = deferred();
  const f = fixture({
    prompt: async () => { throw error; },
    async abort() { f.order.push('abort'); abortStarted.resolve(); await aborted.promise; },
  });
  const running = f.execution.execute(input, () => {});
  const rejected = assert.rejects(running, value => value === error);
  await abortStarted.promise;
  f.execution.dispose();
  assert.equal(f.order.includes('release'), false);
  assert.notEqual(f.agent.streamFunction, f.original);
  aborted.resolve();
  await rejected;
  assert.equal(f.agent.streamFunction, f.original);
  assert.deepEqual(f.order.slice(-4), ['abort', 'unsubscribe', 'dispose', 'release']);
});

test('adapter rolls back a failed creation and transfers reservation ownership after success', async () => {
  const f = fixture();
  let acquired = false, attempts = 0, releases = 0;
  const error = new Error('SDK creation failed');
  const loadAdapter = createLoader({
    './providers/provider-manager': { PiProviderManager: class {} },
    './sessions/session-store': { PiSessionStore: class {
      acquire() { assert.equal(acquired, false); acquired = true; return f.manager; }
      release() { assert.equal(acquired, true); acquired = false; releases++; }
    } },
    './sessions/session-factory': { PiSessionFactory: class {
      async create() { if (++attempts === 1) throw error; return f.session; }
    } },
  });
  const { PiAdapter } = loadAdapter(path.resolve(__dirname, '../../src/agent/runtime/pi/pi-adapter.ts'));
  const adapter = new PiAdapter({});
  await assert.rejects(adapter.openSession({}), value => value === error);
  assert.equal(acquired, false);
  const execution = await adapter.openSession({});
  assert.equal(acquired, true);
  await execution.execute(input, () => {});
  assert.equal(acquired, true, 'execution retains ownership until disposed');
  execution.dispose();
  execution.dispose();
  assert.equal(acquired, false);
  assert.equal(releases, 2);
  assert.equal(f.order.filter(item => item === 'dispose').length, 1);
});
