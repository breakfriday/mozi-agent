const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const load = require('../helpers/load-ts.cjs')({ electron: {} });
const { MoziBrowser } = load(path.resolve(__dirname, '../../src/main/services/browser.service.ts'));
const operation = { action: 'read', target: 'current' };
const result = { kind: 'read', title: 'Test', url: 'https://example.com', content: 'Test', truncated: false };
const context = (requestId, controller = new AbortController()) => ({ requestId, sessionId: 'session', runId: 'run', toolCallId: requestId, signal: controller.signal, onProgress() {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('cancelled active task keeps queue ownership until runner cleanup completes', async t => {
  const browser = new MoziBrowser();
  t.after(() => browser.dispose());
  const cleanup = deferred();
  const started = [];
  browser.runTask = async task => {
    started.push(task.context.requestId);
    if (task.context.requestId === 'first') {
      try { await browser.wait(task, new Promise(() => {})); }
      finally { await cleanup.promise; }
    }
    return result;
  };
  const controller = new AbortController();
  const first = browser.execute(operation, context('first', controller));
  const rejected = assert.rejects(first, { code: 'CANCELLED' });
  const second = browser.execute(operation, context('second'));
  controller.abort();
  await tick();
  assert.deepEqual(started, ['first']);
  cleanup.resolve();
  await rejected;
  assert.equal(await second, result);
  await tick();
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(browser.scheduler.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('queued and pre-cancelled tasks never run and release their external listeners', async t => {
  const browser = new MoziBrowser();
  t.after(() => browser.dispose());
  const gate = deferred();
  const started = [];
  browser.runTask = async task => { started.push(task.context.requestId); await gate.promise; return result; };
  const first = browser.execute(operation, context('first'));
  const controller = new AbortController();
  const queued = browser.execute(operation, context('queued', controller));
  const rejected = assert.rejects(queued, { code: 'CANCELLED' });
  browser.cancel('queued');
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await assert.rejects(browser.execute(operation, context('pre-cancelled', controller)), { code: 'CANCELLED' });
  assert.equal(browser.scheduler.queue.length, 0);
  gate.resolve();
  await first;
  await tick();
  assert.deepEqual(started, ['first']);
  assert.equal(browser.scheduler.size, 0);
});

test('deadline includes queue time and timed-out tasks release their listeners', async t => {
  const browser = new MoziBrowser(20);
  t.after(() => browser.dispose());
  const cleanup = deferred();
  const started = [];
  browser.runTask = async task => {
    started.push(task.context.requestId);
    try { await browser.wait(task, new Promise(() => {})); }
    finally { await cleanup.promise; }
  };
  const first = browser.execute(operation, context('first'));
  const firstRejected = assert.rejects(first, { code: 'TIMEOUT' });
  const controller = new AbortController();
  await assert.rejects(browser.execute(operation, context('queued', controller)), { code: 'TIMEOUT' });
  assert.deepEqual(started, ['first']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  cleanup.resolve();
  await firstRejected;
  await tick();
  assert.equal(browser.scheduler.size, 0);
});

const { BrowserTask } = load(path.resolve(__dirname, '../../src/main/services/browser-task.ts'));
const { BrowserTaskScheduler } = load(path.resolve(__dirname, '../../src/main/services/browser-task-scheduler.ts'));
test('progress callbacks cover manual wait/resume and retain exclusive browser ownership', async () => {
  const started = [];
  const scheduler = new BrowserTaskScheduler(async task => {
    started.push(task.context.requestId);
    task.report({ stage: 'loading', message: 'Loading' });
    if (task.context.requestId === 'first') {
      await task.waitForResume(() => task.report({ stage: 'waiting_user', message: 'Verify' }));
    }
    task.report({ stage: 'extracting', message: 'Reading' });
    return result;
  }, () => {}, () => {}, 1000);
  const progress = [];
  const first = new BrowserTask(operation, { ...context('first'), onProgress: p => progress.push(p.stage) });
  const second = new BrowserTask(operation, context('second'));
  scheduler.enqueue(first);
  scheduler.enqueue(second);
  assert.equal(first.state, 'waiting_user');
  assert.equal(second.state, 'queued');
  assert.deepEqual(started, ['first']);
  first.resume();
  await Promise.all([first.result, second.result]);
  assert.equal(first.state, 'succeeded');
  assert.deepEqual(progress, ['queued', 'loading', 'waiting_user', 'extracting']);
  assert.equal(scheduler.size, 0);
});

test('cancellation stays cancelling until manual-wait cleanup finishes', async () => {
  const cleanup = deferred();
  let stops = 0;
  const scheduler = new BrowserTaskScheduler(async task => {
    try { await task.waitForResume(() => {}); }
    finally { await cleanup.promise; }
    return result;
  }, () => { stops++; }, () => {}, 1000);
  const task = new BrowserTask(operation, context('manual'));
  scheduler.enqueue(task);
  const reason = new Error('stop');
  const rejected = assert.rejects(task.result, error => error === reason);
  task.cancel(reason);
  task.cancel(new Error('duplicate'));
  task.resume();
  await tick();
  assert.equal(task.state, 'cancelling');
  assert.equal(scheduler.active, task);
  assert.equal(stops, 1);
  cleanup.resolve();
  await rejected;
  assert.equal(task.state, 'cancelled');
  assert.equal(task.reason, reason);
  assert.equal(scheduler.size, 0);
});

test('runner or progress failure rejects the result and next task still runs', async () => {
  const failure = new Error('script failed');
  const scheduler = new BrowserTaskScheduler(async task => {
    if (task.context.requestId === 'bad') throw failure;
    return result;
  }, () => {}, () => { throw new Error('window closed'); }, 1000);
  const bad = new BrowserTask(operation, context('bad'));
  scheduler.enqueue(bad);
  const good = new BrowserTask(operation, context('good'));
  scheduler.enqueue(good);
  await assert.rejects(bad.result, error => error === failure);
  assert.equal(await good.result, result);
  assert.equal(bad.state, 'failed');
  const progressFailure = new BrowserTask(operation, { ...context('progress'), onProgress() { throw failure; } });
  scheduler.enqueue(progressFailure);
  await assert.rejects(progressFailure.result, error => error === failure);
  assert.equal(scheduler.size, 0);
});

test('capacity and duplicate rejection do not disturb accepted tasks; disposal drains all', async () => {
  const scheduler = new BrowserTaskScheduler(task => task.wait(new Promise(() => {})), () => {}, () => {}, 1000);
  const tasks = Array.from({ length: 16 }, (_, i) => new BrowserTask(operation, context(String(i))));
  for (const task of tasks) scheduler.enqueue(task);
  assert.throws(() => scheduler.enqueue(new BrowserTask(operation, context('0'))), { code: 'CAPACITY_EXCEEDED' });
  assert.throws(() => scheduler.enqueue(new BrowserTask(operation, context('overflow'))), { code: 'CAPACITY_EXCEEDED' });
  const reason = new Error('closed');
  const rejected = tasks.map(task => assert.rejects(task.result, error => error === reason));
  scheduler.dispose(reason);
  await Promise.all(rejected);
  assert.equal(scheduler.size, 0);
  assert.throws(() => scheduler.enqueue(new BrowserTask(operation, context('later'))), { code: 'UNAVAILABLE' });
});

test('completed tasks cannot be resubmitted or leave scheduler entries behind', async () => {
  const scheduler = new BrowserTaskScheduler(async () => result, () => {}, () => {}, 1000);
  const task = new BrowserTask(operation, context('once'));
  assert.equal(task.state, 'created');
  scheduler.enqueue(task);
  assert.equal(task.state, 'running');
  await task.result;
  assert.equal(task.state, 'succeeded');
  assert.throws(() => scheduler.enqueue(task), /Only created tasks/);
  assert.equal(scheduler.size, 0);
});

test('wait cleans listeners and cancellation owns settlement despite late host completion', async () => {
  const task = new BrowserTask(operation, context('wait'));
  task.onSubmitted(1000, () => {});
  const ready = deferred();
  const host = deferred();
  const reason = new Error('stop');
  const execution = task.execute(async t => {
    assert.equal(await t.wait(Promise.resolve('ok')), 'ok');
    await assert.rejects(t.wait(Promise.reject(new Error('host failed'))), /host failed/);
    assert.equal(getEventListeners(t.controller.signal, 'abort').length, 1);
    ready.resolve();
    await t.wait(host.promise);
    return result;
  });
  const rejected = assert.rejects(execution, error => error === reason);
  await ready.promise;
  task.cancel(reason);
  await rejected;
  host.resolve('late result');
  await tick();
  assert.equal(task.state, 'cancelled');
  assert.equal(getEventListeners(task.controller.signal, 'abort').length, 0);
});

test('manual wait times out and releases the scheduler and external cancellation listener', async () => {
  const controller = new AbortController();
  const task = new BrowserTask(operation, context('verify', controller));
  const scheduler = new BrowserTaskScheduler(async t => { await t.waitForResume(() => {}); return result; }, () => {}, () => {}, 20);
  scheduler.enqueue(task);
  assert.equal(task.state, 'waiting_user');
  await assert.rejects(task.result, { code: 'TIMEOUT' });
  assert.equal(task.state, 'cancelled');
  assert.equal(scheduler.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(task.controller.signal, 'abort').length, 0);
});

test('progress callback can resume or cancel immediately during manual wait', async () => {
  for (const cancel of [false, true]) {
    const task = new BrowserTask(operation, context('immediate'));
    const reason = new Error('stop');
    const scheduler = new BrowserTaskScheduler(async t => {
      await t.waitForResume(() => { if (cancel) t.cancel(reason); else t.resume(); });
      return result;
    }, () => { throw new Error('window already gone'); }, () => {}, 1000);
    scheduler.enqueue(task);
    if (cancel) await assert.rejects(task.result, error => error === reason);
    else assert.equal(await task.result, result);
    assert.equal(task.state, cancel ? 'cancelled' : 'succeeded');
    assert.equal(scheduler.size, 0);
  }
});


test('created tasks become queued only on submission and cannot start before it', async () => {
  const controller = new AbortController();
  const task = new BrowserTask(operation, context('created', controller));
  assert.equal(task.state, 'created');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(task.execute(async () => result), /Only queued tasks/);
  assert.equal(task.state, 'created');
  task.onSubmitted(1000, () => {});
  assert.equal(task.state, 'queued');
  assert.throws(() => task.onSubmitted(1000, () => {}), /Only created tasks/);
  const execution = task.execute(async () => result);
  assert.equal(execution, task.result);
  assert.equal(task.state, 'running');
  assert.equal(await task.result, result);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation before submission settles immediately and prevents later submission', async () => {
  const task = new BrowserTask(operation, context('never-submitted'));
  const reason = new Error('cancel before submission');
  const rejected = assert.rejects(task.result, error => error === reason);
  task.cancel(reason);
  assert.equal(task.state, 'cancelled');
  task.cancel(new Error('duplicate'));
  assert.equal(task.reason, reason);
  await rejected;
  const scheduler = new BrowserTaskScheduler(async () => result, () => {}, () => {}, 1000);
  assert.throws(() => scheduler.enqueue(task), /Only created tasks/);
  assert.equal(scheduler.size, 0);
  assert.throws(() => task.onSubmitted(1000, () => {}), /Only created tasks/);
});


test('execute owns sync failures and rejects duplicate execution without disturbing the original', async () => {
  const task = new BrowserTask(operation, context('execute-once'));
  task.onSubmitted(1000, () => {});
  const gate = deferred();
  let runs = 0;
  const execution = task.execute(async () => { runs++; await gate.promise; return result; });
  assert.equal(execution, task.result);
  await assert.rejects(task.execute(async () => { runs++; return result; }), /Only queued tasks/);
  gate.resolve();
  assert.equal(await execution, result);
  assert.equal(runs, 1);
  await assert.rejects(task.execute(async () => result), /Only queued tasks/);
  const failed = new BrowserTask(operation, context('sync-failure'));
  failed.onSubmitted(1000, () => {});
  const error = new Error('sync runner error');
  await assert.rejects(failed.execute(() => { throw error; }), e => e === error);
  assert.equal(failed.state, 'failed');
});

test('queued cancellation settles inside Task without a scheduler and never invokes the runner', async () => {
  const task = new BrowserTask(operation, context('queued-alone'));
  let notified = 0;
  task.onSubmitted(1000, () => { notified++; });
  const error = new Error('stop queued');
  const rejected = assert.rejects(task.result, e => e === error);
  task.cancel(error);
  assert.equal(task.state, 'cancelled');
  await rejected;
  let ran = false;
  const execution = task.execute(async () => { ran = true; return result; });
  assert.equal(execution, task.result);
  await assert.rejects(execution, e => e === error);
  assert.equal(notified, 1);
  assert.equal(ran, false);
});

test('execute waits for runner cleanup and cancellation wins even if runner returns success', async () => {
  const task = new BrowserTask(operation, context('cleanup'));
  task.onSubmitted(1000, () => {});
  const cleanup = deferred();
  const execution = task.execute(async t => {
    try { await t.wait(new Promise(() => {})); }
    catch { /* A runner may consume cancellation. */ }
    finally { await cleanup.promise; }
    return result;
  });
  const error = new Error('stop');
  const rejected = assert.rejects(execution, e => e === error);
  task.cancel(error);
  await tick();
  assert.equal(task.state, 'cancelling');
  cleanup.resolve();
  await rejected;
  assert.equal(task.state, 'cancelled');
});
