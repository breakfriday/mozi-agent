const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { AgentRepository } = load(path.resolve(__dirname, '../../src/agent/repository.ts'));
const { AgentService } = load(path.resolve(__dirname, '../../src/agent/service.ts'));
const { AgentServer } = load(path.resolve(__dirname, '../../src/agent/transport.ts'));
const { isAgentEvent, responseMatchesRequest } = load(path.resolve(__dirname, '../../../shared/agent/index.ts'));
const tick = () => new Promise(setImmediate);
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mozi-service-'));
  const events = [], fatal = [], executions = [];
  let sessionCount = 0;
  const runtime = {
    async createSession() { return { sessionId: `s${++sessionCount}`, cwd: directory, filePath: path.join(directory, 'pi.jsonl') }; },
    readHistory() { return []; },
    async openSession() { return {
      execute(input, emit) { return new Promise((resolve, reject) => executions.push({ input, emit, resolve, reject })); },
      async cancel() { executions.at(-1)?.resolve(); }, dispose() {},
    }; }, dispose() {},
  };
  const filename = path.join(directory, 'state.sqlite');
  const repository = new AgentRepository(filename);
  const service = new AgentService(repository, runtime, e => { assert.equal(isAgentEvent(e), true); events.push(e); }, e => fatal.push(e));
  service.initialize();
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  let id = 0;
  const call = (method, params) => service.dispatch({ protocolVersion: 1, kind: 'request', requestId: `req${++id}`, method, params });
  return { service, repository, runtime, call, events, executions, fatal, filename };
}
const input = (sessionId, clientMessageId = 'client', text = 'hello') => ({ sessionId, clientMessageId, content: [{ type: 'text', text }] });

test('durable acceptance deduplicates before busy checks and responds before model completion', async t => {
  const f = fixture(t); t.after(() => f.service.close());
  const [{ sessionId }, again] = await Promise.all([f.call('session.create', { clientOperationId: 'create' }), f.call('session.create', { clientOperationId: 'create' })]);
  assert.equal(sessionId, again.sessionId);
  await assert.rejects(f.call('session.create', { clientOperationId: 'create', title: 'different' }), e => e.code === 'SUBMISSION_CONFLICT');
  const accepted = await f.call('run.start', input(sessionId));
  assert.equal(accepted.disposition, 'accepted'); assert.equal(f.executions.length, 0);
  const duplicate = await f.call('run.start', input(sessionId));
  assert.equal(duplicate.runId, accepted.runId); assert.equal(duplicate.disposition, 'duplicate');
  await assert.rejects(f.call('run.start', input(sessionId, 'client', 'different')), e => e.code === 'SUBMISSION_CONFLICT');
  await assert.rejects(f.call('run.start', input(sessionId, 'new')), e => e.code === 'SESSION_BUSY');
  await tick(); assert.equal(f.executions.length, 1);
  const run = f.executions[0];
  run.emit({ type: 'message.start', ordinal: 0 });
  run.emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'a' });
  const snapshot = await f.call('session.snapshot', { sessionId });
  assert.equal(snapshot.messages[1].content[0].text, 'a');
  assert.equal(snapshot.lastSeq, f.events.at(-1).seq);
  run.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, text: 'abc' }] }); run.resolve(); await tick();
  assert.equal((await f.call('run.get', { sessionId, runId: accepted.runId })).status, 'completed');
  assert.deepEqual(f.events.map(e => e.seq), f.events.map((_, index) => index + 1));
  assert.equal(f.events.filter(e => e.type === 'run.finished').length, 1);
  assert.equal((await f.call('run.cancel', { sessionId, runId: accepted.runId })).disposition, 'already_finished');
  assert.deepEqual(f.fatal, []);
});

test('cancel is independent of the running prompt, retains partial text and closes once', async t => {
  const f = fixture(t); t.after(() => f.service.close());
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId } = await f.call('run.start', input(sessionId)); await tick();
  f.executions[0].emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'partial' });
  assert.equal((await f.call('run.cancel', { sessionId, runId })).disposition, 'requested'); await tick();
  const snapshot = await f.call('session.snapshot', { sessionId });
  assert.equal(snapshot.runs[0].status, 'cancelled');
  assert.equal(snapshot.messages[1].status, 'cancelled');
  assert.equal(snapshot.messages[1].content[0].text, 'partial');
  assert.equal(f.events.filter(e => e.type === 'run.finished').length, 1);
});

test('process recovery interrupts durable reservations and never resubmits original input', async t => {
  const f = fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId, messageId } = await f.call('run.start', input(sessionId));
  // Simulate the durable image left after a crash, without executing the scheduled job.
  const copy = path.join(path.dirname(f.filename), 'recovered.sqlite');
  const record = structuredClone(f.repository.load()[0]);
  const recoveredRepo = new AgentRepository(copy);
  recoveredRepo.create('create', '新会话', record);
  recoveredRepo.accept(record, { input: input(sessionId), runId, messageId });
  const recovered = new AgentService(recoveredRepo, f.runtime, () => {}, e => { throw e; });
  recovered.initialize();
  const reply = await recovered.dispatch({ method: 'run.start', params: input(sessionId) });
  assert.equal(reply.disposition, 'duplicate'); assert.equal(reply.runId, runId);
  const snapshot = await recovered.dispatch({ method: 'session.snapshot', params: { sessionId } });
  assert.equal(snapshot.runs[0].status, 'interrupted'); assert.equal(snapshot.lastSeq, 0);
  assert.equal(snapshot.messages[0].id, messageId);
  await recovered.close(); await f.service.close();
});

test('server validates shared requests and returns structured errors without waiting on runs', async t => {
  const f = fixture(t); t.after(() => f.service.close());
  const sent = []; const server = new AgentServer(f.service, packet => sent.push(packet));
  await server.receive({ protocolVersion: 1, kind: 'request', requestId: 'bad', method: 'run.start', params: {} });
  assert.equal(sent.pop().error.code, 'INVALID_ARGUMENT');
  const request = { protocolVersion: 1, kind: 'request', requestId: 'create', method: 'session.create', params: { clientOperationId: 'create' } };
  await server.receive(request); const reply = sent.pop();
  assert.equal(responseMatchesRequest(request, reply), true);
  await server.receive({ ...request, method: 'session.snapshot', params: { sessionId: 'missing' } });
  assert.equal(sent.pop().error.code, 'SESSION_NOT_FOUND');
});

test('model setup failure produces a failed Run without a simulated assistant message', async t => {
  const f = fixture(t);
  f.runtime.openSession = async () => { throw new Error('No configured model credentials'); };
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId } = await f.call('run.start', input(sessionId)); await tick();
  const snapshot = await f.call('session.snapshot', { sessionId });
  assert.equal(snapshot.runs[0].id, runId); assert.equal(snapshot.runs[0].status, 'failed');
  assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].role, 'user');
  assert.equal(f.events.filter(e => e.type === 'run.finished').length, 1);
});

test('output capacity failure preserves the valid projection for recovery', async t => {
  const f = fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.call('run.start', input(sessionId)); await tick();
  const execution = f.executions[0];
  execution.emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'keep me' });
  try { execution.emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'x'.repeat(256_000) }); }
  catch (error) { assert.equal(error.code, 'CAPACITY_EXCEEDED'); execution.reject(error); }
  await tick();
  const snapshot = await f.call('session.snapshot', { sessionId });
  assert.equal(snapshot.messages[1].content[0].text, 'keep me');
  assert.equal(snapshot.runs[0].status, 'failed');
  assert.equal(f.repository.load()[0].snapshot.messages[1].content[0].text, 'keep me');
});
