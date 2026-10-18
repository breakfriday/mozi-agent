const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const createLoader = require('../helpers/load-ts.cjs');
const load = createLoader();
const shared = load(path.resolve(__dirname, '../../../shared/browser.ts'));
const { IpcServer } = load(path.resolve(__dirname, '../../src/agent/transport/ipc-server.ts'));
const { AgentTransport } = load(path.resolve(__dirname, '../../src/main/agent/transport.ts'));
const { createBrowserTool, BROWSER_GUIDELINES } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/browser-tools.ts'));
const scope = { sessionId: 'session', runId: 'run', toolCallId: 'tool' };
const readResult = { kind: 'read', title: 'Article', url: 'https://example.com/article', content: 'Evidence', truncated: false };
const context = (controller = new AbortController(), onProgress = () => {}) => ({ ...scope, signal: controller.signal, onProgress });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser contract validates URLs, bounded results, scopes and result variants', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com', 'data:text/html,hi']) {
    assert.equal(shared.isBrowserOperation({ action: 'read', url }), false);
  }
  assert.equal(shared.isBrowserOperation({ action: 'search', query: 'Bing', limit: 11 }), false);
  assert.equal(shared.isBrowserOperation({ action: 'search', query: ' ' }), false);
  assert.equal(shared.isBrowserOperation({ action: 'read', target: 'current' }), true);
  assert.equal(shared.isBrowserOperation({ action: 'inspect' }), true);
  assert.equal(shared.isBrowserOperation({ action: 'inspect', query: '下一页' }), true);
  assert.equal(shared.isBrowserOperation({ action: 'click', elementId: 'snapshot:1' }), true);
  for (const operation of [
    { action: 'read' }, { action: 'read', target: 'other' },
    { action: 'read', target: 'current', url: readResult.url },
    { action: 'search', query: 'Bing', target: 'current' },
    { action: 'read', url: readResult.url, query: 'Bing' },
    { action: 'read', target: 'current', sessionId: 'injected' },
    { action: 'click' }, { action: 'click', elementId: ' ' },
    { action: 'click', elementId: 'snapshot:1', selector: '#pay' },
    { action: 'inspect', url: readResult.url }, { action: 'inspect', query: ' ' },
  ]) assert.equal(shared.isBrowserOperation(operation), false, JSON.stringify(operation));
  assert.equal(shared.isBrowserResult({ ...readResult, content: 'x'.repeat(24001) }), false);
  assert.equal(shared.isBrowserResult(readResult), true);
  const inspected = { kind: 'inspect', url: readResult.url, title: 'Page', elements: [{ elementId: 'snapshot:1', name: 'More', role: 'button', disabled: false }], truncated: false };
  assert.equal(shared.isBrowserResult(inspected), true);
  assert.equal(shared.isBrowserResult({ ...inspected, elements: Array(101).fill(inspected.elements[0]) }), false);
  assert.equal(shared.isBrowserResult({ ...inspected, elements: [{ ...inspected.elements[0], href: 'javascript:alert(1)' }] }), false);
  assert.equal(shared.isBrowserResult({ kind: 'click', url: readResult.url, title: 'Page', elementId: 'snapshot:1', dispatched: true }), true);
  assert.equal(shared.isBrowserResult({ kind: 'click', url: readResult.url, title: 'Page', elementId: 'snapshot:1' }), false);
  assert.equal(shared.isBrowserToMain({ protocolVersion: 1, kind: 'browser.request', requestId: 'r', operation: { action: 'read', url: readResult.url }, scope }), true);
  assert.equal(shared.isBrowserToMain({ protocolVersion: 1, kind: 'browser.request', requestId: 'r', operation: { action: 'read', url: readResult.url }, scope: { ...scope, runId: '' } }), false);
  assert.equal(shared.isBrowserToAgent({ protocolVersion: 1, kind: 'browser.progress', requestId: 'r', progress: { stage: 'made_up', message: 'x' } }), false);
});

test('real Pi schema validation accepts browser operations and rejects mixed or missing targets', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const tool = createBrowserTool(async () => readResult, 'session', () => 'run');
  for (const operation of [
    { action: 'search', query: 'Electron', limit: 3 },
    { action: 'read', url: readResult.url }, { action: 'read', target: 'current' },
    { action: 'inspect' }, { action: 'inspect', query: 'More' }, { action: 'click', elementId: 'snapshot:1' },
    { action: 'fill', elementId: 'snapshot:1', text: '' }, { action: 'fill', elementId: 'snapshot:1', text: '中文搜索' },
    ...shared.BROWSER_KEYS.map(key => ({ action: 'press', elementId: 'snapshot:1', key })),
  ]) assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: operation }), operation);
  for (const operation of [
    { action: 'read' }, { action: 'search' }, { action: 'navigate', url: readResult.url },
    { action: 'read', url: readResult.url, target: 'current' },
    { action: 'search', query: 'Electron', target: 'current' },
    { action: 'read', target: 'current', sessionId: 'injected' },
    { action: 'click' }, { action: 'click', elementId: 'snapshot:1', selector: '#pay' }, { action: 'inspect', url: readResult.url },
    { action: 'fill', elementId: 'snapshot:1' }, { action: 'fill', elementId: 'snapshot:1', text: 'x'.repeat(10001) },
    { action: 'press', key: 'Enter' }, { action: 'press', elementId: 'snapshot:1', key: 'Control+L' },
    { action: 'fill', elementId: 'snapshot:1', text: 'query', key: 'Enter' },
  ]) assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: operation }), JSON.stringify(operation));
});

test('inspect, click, fill and press cross reverse IPC with their own results and interaction progress', async t => {
  let mainReceive;
  const ipc = new IpcServer({}, packet => mainReceive(packet));
  const element = { elementId: 'snapshot:1', name: 'More', role: 'button', disabled: false };
  const transport = new AgentTransport(undefined, async (operation, ctx) => {
    ctx.onProgress({ stage: 'interacting', message: 'Interacting' });
    if (operation.action === 'press') assert.equal(operation.expect.text, 'query');
    return operation.action === 'inspect'
      ? { kind: 'inspect', title: 'Page', url: readResult.url, elements: [element], truncated: false }
      : { kind: operation.action, title: 'Page', url: readResult.url, elementId: operation.elementId, dispatched: true };
  });
  t.after(() => { ipc.dispose(); transport.dispose(); });
  transport.connect({ postMessage: packet => { void ipc.receive(packet); }, onMessage: listener => { mainReceive = listener; return () => {}; }, onDisconnect: () => () => {} });
  mainReceive({ protocolVersion: 1, kind: 'runtime', state: 'ready' });
  const updates = [];
  const inspected = await ipc.callBrowser({ action: 'inspect' }, context(undefined, p => updates.push(p)));
  const clicked = await ipc.callBrowser({ action: 'click', elementId: inspected.elements[0].elementId }, context());
  assert.equal(clicked.kind, 'click'); assert.equal(clicked.dispatched, true);
  assert.equal(updates[0].stage, 'interacting');
  for (const operation of [{ action: 'fill', elementId: element.elementId, text: 'query' }, { action: 'press', elementId: element.elementId, key: 'Enter', expect: { elementId: element.elementId, text: 'query' } }]) {
    const result = await ipc.callBrowser(operation, context());
    assert.equal(result.kind, operation.action); assert.equal(result.dispatched, true);
  }
});

test('reverse browser calls route progress and results independently of Agent requests', async t => {
  let mainReceive;
  const events = [];
  const ipc = new IpcServer({ dispatch: async () => ({ sessionId: 'new' }) }, packet => mainReceive(packet));
  const transport = new AgentTransport(undefined, async (operation, ctx) => {
    assert.equal(operation.action, 'read');
    assert.equal(ctx.runId, 'run');
    ctx.onProgress({ stage: 'loading', message: 'Loading' });
    return readResult;
  });
  t.after(() => { ipc.dispose(); transport.dispose(); });
  transport.connect({ postMessage: packet => { void ipc.receive(packet); },
    onMessage: listener => { mainReceive = listener; return () => {}; }, onDisconnect: () => () => {} });
  mainReceive({ protocolVersion: 1, kind: 'runtime', state: 'ready' });
  const pending = ipc.callBrowser({ action: 'read', target: 'current' }, context(undefined, p => events.push(p)));
  const request = transport.request({ protocolVersion: 1, kind: 'request', requestId: 'ordinary', method: 'session.create', params: { clientOperationId: 'op' } });
  assert.equal((await request).result.sessionId, 'new');
  assert.equal((await pending).content, 'Evidence');
  assert.equal(events[0].stage, 'loading');
});

test('tool cancellation reaches host; late completion cannot resolve or contaminate the next request', async t => {
  const sent = [];
  const ipc = new IpcServer({}, packet => sent.push(packet));
  t.after(() => ipc.dispose());
  const controller = new AbortController();
  const first = ipc.callBrowser({ action: 'read', url: readResult.url }, context(controller));
  const firstId = sent[0].requestId;
  controller.abort();
  await assert.rejects(first, error => error.code === 'CANCELLED');
  assert.equal(sent.at(-1).kind, 'browser.cancel');
  const next = ipc.callBrowser({ action: 'read', url: readResult.url }, context());
  const nextId = sent.at(-1).requestId;
  await ipc.receive({ protocolVersion: 1, kind: 'browser.response', requestId: firstId, ok: true, result: readResult });
  await ipc.receive({ protocolVersion: 1, kind: 'browser.response', requestId: nextId, ok: true, result: { ...readResult, content: 'Next' } });
  assert.equal((await next).content, 'Next');
});

test('disconnect aborts host work and drops old responses after reconnect', async t => {
  let work;
  const transport = new AgentTransport(undefined, (_operation, ctx) => new Promise(resolve => { work = { ctx, resolve }; }));
  t.after(() => transport.dispose());
  function connect() {
    const c = { sent: [] };
    transport.connect({ postMessage: p => c.sent.push(p), onMessage: listener => { c.receive = listener; return () => {}; },
      onDisconnect: listener => { c.disconnect = listener; return () => {}; } });
    c.receive({ protocolVersion: 1, kind: 'runtime', state: 'ready' });
    return c;
  }
  const old = connect();
  old.receive({ protocolVersion: 1, kind: 'browser.request', requestId: 'browser', scope, operation: { action: 'read', url: readResult.url } });
  const next = connect();
  assert.equal(work.ctx.signal.aborted, true);
  work.resolve(readResult);
  await tick();
  assert.equal(next.sent.length, 0);
  assert.equal(old.sent.length, 0);
});

test('invalid host response rejects outstanding calls and disposal cancels all waits', async () => {
  const sent = [];
  const ipc = new IpcServer({}, p => sent.push(p));
  const call = ipc.callBrowser({ action: 'read', url: readResult.url }, context());
  const rejected = assert.rejects(call, error => error.code === 'UNAVAILABLE');
  await assert.rejects(ipc.receive({ protocolVersion: 1, kind: 'browser.response', requestId: sent[0].requestId, ok: true, result: {} }));
  await rejected;
  await assert.rejects(ipc.callBrowser({ action: 'read', url: readResult.url }, context()), error => error.code === 'UNAVAILABLE');
});

test('one Pi browser tool carries all three operations, runtime scope, progress and evidence', async () => {
  const calls = [], updates = [];
  const tool = createBrowserTool(async (operation, ctx) => {
    calls.push({ operation, ctx });
    ctx.onProgress({ stage: 'extracting', message: 'Reading page' });
    return readResult;
  }, 'session', () => 'run');
  assert.equal(tool.name, 'mozi_browser');
  const controller = new AbortController();
  const result = await tool.execute('call', { action: 'read', url: readResult.url }, controller.signal, p => updates.push(p), {});
  assert.equal(calls[0].ctx.signal, controller.signal);
  assert.equal(calls[0].ctx.toolCallId, 'call');
  assert.equal(calls[0].ctx.runId, 'run');
  assert.equal(updates[0].content[0].text, 'Reading page');
  assert.equal(JSON.parse(result.content[0].text).url, readResult.url);
  await tool.execute('current', { action: 'read', target: 'current' }, controller.signal, undefined, {});
  await tool.execute('search', { action: 'search', query: 'Bing' }, controller.signal, undefined, {});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(c => c.operation))), [
    { action: 'read', url: readResult.url }, { action: 'read', target: 'current' }, { action: 'search', query: 'Bing' },
  ]);
  await assert.rejects(tool.execute('call', { action: 'read', url: 'file:///secret' }, controller.signal, undefined, {}), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(tool.execute('call', { action: 'read', url: readResult.url, target: 'current' }, controller.signal, undefined, {}), e => e.code === 'INVALID_ARGUMENT');
  const unscoped = createBrowserTool(async () => { throw Error('must not call'); }, 'session', () => undefined);
  await assert.rejects(unscoped.execute('call', { action: 'search', query: 'hi' }, controller.signal, undefined, {}), e => e.code === 'UNAVAILABLE');
});

test('visual browsing removes Bailian server search while preserving local tools and the shared catalog', async () => {
  const isolated = createLoader({ '@earendil-works/pi-coding-agent': {}, '@aiwayds/pi-bailian-token-plan': () => {} });
  const { preserveBailianLocalTools } = isolated(path.resolve(__dirname, '../../src/agent/runtime/pi/providers/bailian.ts'));
  const model = { provider: 'bailian-tp', api: 'openai-responses', id: 'model', samplingParams: { tools: [{ type: 'web_search' }, { type: 'web_extractor' }] } };
  const original = JSON.stringify(model);
  let body;
  const agent = { streamFunction: async (_model, _context, options) => {
    body = { tools: [{ type: 'function', name: 'mozi_browser' }, { type: 'function', name: 'read' }] };
    await options.onPayload(body, _model);
    return {};
  } };
  preserveBailianLocalTools(agent, true);
  let callback = false;
  await agent.streamFunction(model, {}, { onPayload: () => { callback = true; } });
  assert.equal(body.tools.length, 2);
  assert.ok(body.tools.every(tool => tool.type === 'function'));
  assert.equal(callback, true);
  assert.equal(JSON.stringify(model), original);
});

test('input operations and element metadata have bounded host validation', () => {
  for (const text of ['', ' ', '搜索 \" & ` ${literal}', 'x'.repeat(10000)]) {
    assert.equal(shared.isBrowserOperation({ action: 'fill', elementId: 'snapshot:1', text }), true);
  }
  for (const operation of [
    { action: 'fill', elementId: 'snapshot:1', text: 'x'.repeat(10001) },
    { action: 'fill', elementId: 'snapshot:1', text: 1 }, { action: 'fill', text: 'x' },
    { action: 'press', elementId: 'snapshot:1', key: 'Control+L' },
    { action: 'press', key: 'Enter' }, { action: 'press', elementId: 'snapshot:1', key: 'Enter', text: 'x' },
  ]) assert.equal(shared.isBrowserOperation(operation), false);
  for (const key of shared.BROWSER_KEYS) assert.equal(shared.isBrowserOperation({ action: 'press', elementId: 'snapshot:1', key }), true);
  const element = { elementId: 'snapshot:1', role: 'searchbox', name: 'Search', disabled: false,
    editable: true, readOnly: false, focused: true, inputType: 'search', placeholder: 'Find products' };
  const result = { kind: 'inspect', title: 'Page', url: readResult.url, elements: [element], truncated: false };
  assert.equal(shared.isBrowserResult(result), true);
  for (const invalid of [{ editable: 'yes' }, { readOnly: 0 }, { focused: null }, { hasValue: 'yes' }, { placeholder: 'x'.repeat(401) }, { inputType: '' }]) {
    assert.equal(shared.isBrowserResult({ ...result, elements: [{ ...element, ...invalid }] }), false);
  }
  for (const kind of ['fill', 'press']) {
    assert.equal(shared.isBrowserResult({ kind, title: 'Page', url: readResult.url, elementId: 'snapshot:1', dispatched: true }), true);
    assert.equal(shared.isBrowserResult({ kind, title: 'Page', url: readResult.url, elementId: 'snapshot:1', dispatched: false }), false);
  }
});

test('input filters and submission preconditions agree across host and real Pi validation', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const tool = createBrowserTool(async () => readResult, 'session', () => 'run');
  const expect = { elementId: 'snapshot:1', text: '龙餐馆' };
  const valid = [
    { action: 'inspect', filter: 'inputs' }, { action: 'inspect', filter: 'inputs', query: '热词' },
    { action: 'click', elementId: 'snapshot:2', expect },
    { action: 'press', elementId: 'snapshot:1', key: 'Enter', expect },
    { action: 'click', elementId: 'snapshot:2', expect: { ...expect, text: '' } },
  ];
  for (const operation of valid) {
    assert.equal(shared.isBrowserOperation(operation), true);
    assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: operation }), operation);
  }
  for (const operation of [
    { action: 'inspect', filter: 'made_up' }, { action: 'inspect', expect },
    { action: 'fill', elementId: 'snapshot:1', text: 'query', expect },
    ...[{}, { text: 'x' }, { elementId: 'snapshot:1' },
      { ...expect, selector: '#search' }, { ...expect, text: 'x'.repeat(10001) }]
      .map(expect => ({ action: 'click', elementId: 'snapshot:2', expect })),
  ]) {
    assert.equal(shared.isBrowserOperation(operation), false, JSON.stringify(operation));
    assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'call', name: tool.name, arguments: operation }), JSON.stringify(operation));
  }
  // Pi normalizes optional nulls and coerces primitives; raw host input stays strict.
  assert.equal(shared.isBrowserOperation({ action: 'click', elementId: 'snapshot:2', expect: null }), false);
  assert.equal(shared.isBrowserOperation({ action: 'click', elementId: 'snapshot:2', expect: { ...expect, text: 1 } }), false);
  assert.equal(shared.isBrowserToAgent({ protocolVersion: 1, kind: 'browser.response', requestId: 'r', ok: false,
    error: { code: 'INPUT_MISMATCH', message: 'Input does not match' } }), true);
  assert.equal(shared.isBrowserResult({ kind: 'fill', title: 'Page', url: readResult.url, elementId: 'snapshot:1', dispatched: true, inputVerified: false }), false);
});

test('browser tool instructions distinguish placeholder text and require guarded site submission', () => {
  const tool = createBrowserTool(async () => readResult, 'session', () => 'run');
  for (const text of [tool.description, BROWSER_GUIDELINES]) {
    assert.match(text, /filter=inputs/); assert.match(text, /expect=/);
    assert.match(text, /占位/); assert.match(text, /拼接/);
  }
});
