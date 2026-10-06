const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../src/agent');
const load = require('../helpers/load-ts.cjs')();
const { transitionRun, isTerminalRun } = load(path.join(root, 'domain/run/run-machine.ts'));
const { AgentEventPublisher } = load(path.join(root, 'application/agent-event-publisher.ts'));
const { PiEventMapper } = load(path.join(root, 'infrastructure/pi/event-mapper.ts'));
const { PiExecution } = load(path.join(root, 'infrastructure/pi/execution.ts'));

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []);
}
test('layer boundaries keep SQL and SDKs out of application/domain/transport', () => {
  for (const file of files(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      const location = `${relative} imports ${specifier}`;
      if (specifier.startsWith('@earendil-works/')) assert.ok(relative.startsWith('infrastructure/pi/'), location);
      if (specifier === 'node:sqlite') assert.ok(relative.startsWith('infrastructure/sqlite/'), location);
      assert.notEqual(specifier, 'electron', location);
      if (!specifier.startsWith('.')) continue;
      const target = path.relative(root, path.resolve(path.dirname(file), specifier)).split(path.sep).join('/');
      if (relative.startsWith('application/')) assert.ok(!/^(infrastructure|transport|bootstrap)\//.test(target), location);
      if (relative.startsWith('domain/')) assert.ok(!/^(application|infrastructure|transport|bootstrap)\//.test(target), location);
      if (relative.startsWith('transport/')) assert.ok(!/^(infrastructure|bootstrap)\//.test(target), location);
      if (relative.startsWith('infrastructure/')) assert.ok(!/^(transport|bootstrap)\//.test(target), location);
      if (relative.startsWith('infrastructure/pi/')) assert.ok(!target.startsWith('infrastructure/sqlite/'), location);
      if (relative.startsWith('infrastructure/sqlite/')) assert.ok(!target.startsWith('infrastructure/pi/'), location);
    }
  }
});
test('Run state rules prevent cancellation from becoming completed and keep terminal state immutable', () => {
  const run = { id: 'r', sessionId: 's', userMessageId: 'm', status: 'accepted', createdAt: 'a', updatedAt: 'a' };
  assert.equal(transitionRun(run, 'running', 'b'), true);
  assert.equal(transitionRun(run, 'waiting_approval', 'c'), true);
  assert.equal(transitionRun(run, 'running', 'd'), true);
  assert.equal(transitionRun(run, 'cancelling', 'e'), true);
  assert.throws(() => transitionRun(run, 'completed', 'f'), /Invalid Run transition/);
  assert.equal(transitionRun(run, 'cancelled', 'g'), true);
  assert.equal(isTerminalRun(run), true);
  const terminal = structuredClone(run);
  for (const status of ['accepted', 'running', 'completed', 'failed', 'interrupted', 'cancelled']) {
    assert.equal(transitionRun(run, status, 'later'), false);
    assert.deepEqual(run, terminal);
  }
});
test('event seq belongs to the publisher across rebuilt projections and is independent per session', () => {
  const sent = [], publisher = new AgentEventPublisher(event => sent.push(event));
  const state = id => ({ record: { snapshot: { session: { sessionId: id }, lastSeq: 0 } } });
  publisher.publish(state('s'), 'r', { type: 'run.started', data: {} });
  const rebuilt = state('s');
  publisher.publish(rebuilt, 'r', { type: 'run.started', data: {} });
  publisher.publish(state('other'), 'r2', { type: 'run.started', data: {} });
  assert.deepEqual(sent.map(event => event.seq), [1, 2, 1]);
  assert.equal(rebuilt.record.snapshot.lastSeq, 2);
  assert.equal(new AgentEventPublisher(() => {}).sequence('s'), 0);
});
test('Pi mapping keeps ordinals per execution, handles retries and never creates wire events', () => {
  const mapper = new PiEventMapper();
  const started = () => ({ type: 'message_start', message: { role: 'assistant' } });
  assert.equal(mapper.map(started()).ordinal, 0);
  const delta = mapper.map({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'text' } });
  assert.equal(delta.partIndex, 2); assert.equal(delta.delta, 'text');
  for (const key of ['seq', 'messageId', 'runId', 'protocolVersion']) assert.equal(key in delta, false);
  assert.equal(mapper.map({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'retry' } }), undefined);
  assert.equal(mapper.lastFailure, 'retry');
  assert.equal(mapper.map(started()).ordinal, 1);
  assert.equal(mapper.lastFailure, undefined);
  const completed = mapper.map({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
  assert.equal(completed.type, 'message.complete'); assert.equal(completed.parts[0].text, 'done');
  assert.equal(new PiEventMapper().map(started()).ordinal, 0);
});
test('Pi execution waits for idle, removes subscriptions and releases resources once', async () => {
  const order = []; let listener;
  const session = {
    subscribe(callback) { listener = callback; return () => order.push('unsubscribe'); },
    async prompt() { order.push('prompt'); listener({ type: 'message_start', message: { role: 'assistant' } }); },
    async waitForIdle() { order.push('idle'); }, async abort() { order.push('abort'); }, dispose() { order.push('dispose'); },
  };
  const execution = new PiExecution(session, { appendCustomEntry() { order.push('marker'); } });
  await execution.execute({ runId: 'r', clientMessageId: 'c', content: [{ type: 'text', text: 'hi' }] }, () => order.push('event'));
  assert.deepEqual(order, ['marker', 'prompt', 'event', 'idle', 'unsubscribe']);
  await Promise.all([execution.cancel(), execution.cancel()]);
  execution.dispose(); execution.dispose();
  assert.equal(order.filter(item => item === 'abort').length, 1);
  assert.equal(order.filter(item => item === 'dispose').length, 1);
});
