const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const load = require('../helpers/load-ts.cjs')();
const { SqliteMetadataRepository } = load(path.resolve(__dirname, '../../src/agent/infrastructure/sqlite/metadata-repository.ts'));
const { AgentApplication } = load(path.resolve(__dirname, '../../src/agent/application/agent-application.ts'));
const { AgentController } = load(path.resolve(__dirname, '../../src/agent/transport/agent-controller.ts'));
function createApplication(...args) {
  const application = new AgentApplication(...args);
  const controller = new AgentController(application);
  return { application, controller, sessions: application.sessions,
    initialize: () => application.initialize(), close: () => application.close(), dispatch: request => controller.dispatch(request) };
}
const { IpcServer } = load(path.resolve(__dirname, '../../src/agent/transport/ipc-server.ts'));
const { isAgentEvent, responseMatchesRequest } = load(path.resolve(__dirname, '../../../shared/agent/index.ts'));
const { titleFromFirstMessage } = load(path.resolve(__dirname, '../../src/agent/domain/session-title.ts'));
const tick = () => new Promise(setImmediate);
async function fixture(t, catalogFactory) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mozi-service-'));
  const events = [], fatal = [], executions = [];
  let sessionCount = 0;
  const nativeSessions = [], histories = new Map();
  let historyReads = 0;
  const runtime = {
    async createSession() {
      const descriptor = { sessionId: `s${++sessionCount}`, engine: 'fixture', cwd: directory, locator: `native-${sessionCount}` };
      nativeSessions.push({ descriptor, title: '新会话', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      histories.set(descriptor.sessionId, []); return descriptor;
    },
    async listSessions() { return structuredClone(nativeSessions); },
    setSessionName(descriptor, name) {
      Object.assign(nativeSessions.find(s => s.descriptor.sessionId === descriptor.sessionId), { name, title: name });
    },
    async readHistory(descriptor) { historyReads++; return structuredClone(histories.get(descriptor.sessionId) ?? []); },
    async openSession(descriptor) { return {
      execute(input, emit) {
        const history = histories.get(descriptor.sessionId);
        history.push({ runId: input.runId, role: 'user', ordinal: 0, nativeEntryId: `${input.runId}-user`,
          status: 'completed', createdAt: new Date().toISOString(), parts: input.content.map((p, index) => ({ index, type: p.type, text: p.text })) });
        const native = nativeSessions.find(s => s.descriptor.sessionId === descriptor.sessionId);
        native.title = native.name || titleFromFirstMessage(history.find(m => m.role === 'user').parts.map(p => p.text).join('\n'));
        emit({ type: 'session.title', title: native.title });
        return new Promise((resolve, reject) => executions.push({ input, resolve, reject, emit(event) {
          emit(event);
          if (event.type === 'message.complete') history.push({ runId: input.runId, role: 'assistant', ordinal: event.ordinal,
            nativeEntryId: `${input.runId}-assistant-${event.ordinal}`, status: 'completed', createdAt: new Date().toISOString(), parts: event.parts });
        } }));
      },
      async cancel() { executions.at(-1)?.resolve(); }, dispose() {},
    }; }, dispose() {},
  };
  const filename = path.join(directory, 'state.sqlite');
  const repository = new SqliteMetadataRepository(filename);
  const service = createApplication(repository, runtime, e => { assert.equal(isAgentEvent(e), true); events.push(e); }, e => fatal.push(e), catalogFactory?.(runtime));
  await service.initialize();
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  let id = 0;
  const call = (method, params) => service.dispatch({ protocolVersion: 1, kind: 'request', requestId: `req${++id}`, method, params });
  return { service, repository, runtime, call, events, executions, fatal, filename, nativeSessions, histories, historyReads: () => historyReads };
}
const input = (sessionId, clientMessageId = 'client', text = 'hello') => ({ sessionId, clientMessageId, content: [{ type: 'text', text }] });

test('reasoning streams through application events and preserves part identities after native-history recovery', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'reasoning' });
  await f.call('run.start', input(sessionId)); await tick();
  const execution = f.executions[0];
  execution.emit({ type: 'message.reasoning.delta', ordinal: 0, partIndex: 0, delta: '分析' });
  execution.emit({ type: 'message.reasoning.delta', ordinal: 0, partIndex: 0, delta: '问题' });
  execution.emit({ type: 'message.delta', ordinal: 0, partIndex: 1, delta: '答案' });
  const streaming = (await f.call('session.snapshot', { sessionId })).messages.at(-1);
  assert.deepEqual(streaming.content.map(p => p.type), ['reasoning', 'text']);
  assert.equal(streaming.content[0].text, '分析问题');
  assert.equal(f.events.filter(e => e.type === 'message.reasoning.delta').length, 2);
  execution.emit({ type: 'message.complete', ordinal: 0, parts: [
    { index: 0, type: 'reasoning', text: '完整分析' }, { index: 1, type: 'text', text: '完整答案' },
  ] });
  execution.resolve(); await tick();
  const finished = (await f.call('session.snapshot', { sessionId })).messages.at(-1);
  assert.deepEqual(finished.content.map(p => p.id), streaming.content.map(p => p.id));
  assert.equal(finished.status, 'completed');
  await f.service.close();
  const restored = await reopen(t, f);
  const recovered = (await restored.call('session.snapshot', { sessionId })).messages.at(-1);
  assert.deepEqual(recovered.content, finished.content);
  assert.equal(recovered.id, finished.id);
  assert.deepEqual(f.fatal, []);
});

test('cancellation retains partial reasoning and rejects late execution deltas', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'reasoning-cancel' });
  const { runId } = await f.call('run.start', input(sessionId)); await tick();
  f.executions[0].emit({ type: 'message.reasoning.delta', ordinal: 0, partIndex: 0, delta: '已思考部分' });
  await f.call('run.cancel', { sessionId, runId }); await tick();
  f.executions[0].emit({ type: 'message.reasoning.delta', ordinal: 0, partIndex: 0, delta: '迟到内容' });
  const message = (await f.call('session.snapshot', { sessionId })).messages.at(-1);
  assert.equal(message.status, 'cancelled');
  assert.equal(message.content[0].text, '已思考部分');
  assert.equal(message.content[0].type, 'reasoning');
});

test('durable acceptance deduplicates before busy checks and responds before model completion', async t => {
  const f = await fixture(t); t.after(() => f.service.close());
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
  run.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'abc' }] }); run.resolve(); await tick();
  assert.equal((await f.call('run.get', { sessionId, runId: accepted.runId })).status, 'completed');
  assert.deepEqual(f.events.map(e => e.seq), f.events.map((_, index) => index + 1));
  assert.equal(f.events.filter(e => e.type === 'run.finished').length, 1);
  assert.equal((await f.call('run.cancel', { sessionId, runId: accepted.runId })).disposition, 'already_finished');
  assert.deepEqual(f.fatal, []);
});

test('cancel is independent of the running prompt, retains partial text and closes once', async t => {
  const f = await fixture(t); t.after(() => f.service.close());
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
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId, messageId } = await f.call('run.start', input(sessionId));
  // Simulate the durable image left after a crash, without executing the scheduled job.
  const copy = path.join(path.dirname(f.filename), 'recovered.sqlite');
  const source = new DatabaseSync(f.filename);
  source.prepare('VACUUM INTO ?').run(copy); source.close();
  const recoveredRepo = new SqliteMetadataRepository(copy);
  const recovered = createApplication(recoveredRepo, f.runtime, () => {}, e => { throw e; });
  await recovered.initialize();
  const reply = await recovered.dispatch({ method: 'run.start', params: input(sessionId) });
  assert.equal(reply.disposition, 'duplicate'); assert.equal(reply.runId, runId);
  const snapshot = await recovered.dispatch({ method: 'session.snapshot', params: { sessionId } });
  assert.equal(snapshot.runs[0].status, 'interrupted'); assert.equal(snapshot.lastSeq, 0);
  assert.equal(snapshot.messages[0].id, messageId);
  await recovered.close(); await f.service.close();
});

function audit(filename) {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE write_audit (table_name TEXT, kind TEXT, row_id TEXT)');
  for (const table of ['sessions', 'runs', 'message_links']) {
    for (const kind of ['INSERT', 'UPDATE']) {
      const id = table === 'message_links' ? 'message_id' : 'id';
      db.exec(`CREATE TRIGGER audit_${table}_${kind} AFTER ${kind} ON ${table} BEGIN INSERT INTO write_audit VALUES ('${table}', '${kind}', NEW.${id}); END`);
    }
  }
  return { db, clear() { db.exec('DELETE FROM write_audit'); }, writes() { return db.prepare('SELECT * FROM write_audit').all(); }, close() { db.close(); } };
}

test('deltas and completed assistant bodies never enter SQLite; confirmed input is cleared', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.call('run.start', input(sessionId)); await tick();
  const execution = f.executions[0]; execution.emit({ type: 'message.start', ordinal: 0 });
  const a = audit(f.filename); t.after(() => a.close());
  const reads = f.historyReads();
  for (let i = 0; i < 1000; i++) execution.emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: '中' });
  assert.equal(a.writes().length, 0);
  assert.equal(f.historyReads(), reads);
  assert.equal((await f.call('session.snapshot', { sessionId })).messages[1].content[0].text, '中'.repeat(1000));
  execution.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'native final' }] });
  execution.resolve(); await tick();
  assert.equal(a.db.prepare('SELECT pending_content FROM runs').get().pending_content, null);
  assert.equal(f.repository.readSession(sessionId).links.every(link => link.nativeEntryId), true);
  assert.deepEqual(a.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages','tools','approvals','submissions')").all(), []);
  a.clear(); await f.service.close();
  assert.equal(a.writes().length, 0);
});

test('acceptance rollback emits nothing and retains the same retry identity', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_submission BEFORE INSERT ON message_links BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(f.call('run.start', input(sessionId)), /test failure/);
  assert.equal(f.events.length, 0);
  for (const table of ['runs', 'message_links']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal((await f.call('session.snapshot', { sessionId })).messages.length, 0);
  db.exec('DROP TRIGGER fail_submission');
  assert.equal((await f.call('run.start', input(sessionId))).disposition, 'accepted');
});

test('crash recovery uses native history, preserves IDs and interrupts without replaying lost deltas', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const accepted = await f.call('run.start', input(sessionId)); await tick();
  f.executions[0].emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'not persisted by native engine' });
  const before = await f.call('session.snapshot', { sessionId });
  const copy = path.join(path.dirname(f.filename), 'crash.sqlite');
  const db = new DatabaseSync(f.filename); db.prepare('VACUUM INTO ?').run(copy); db.close();
  const repo = new SqliteMetadataRepository(copy);
  const recovered = createApplication(repo, f.runtime, () => {}, error => { throw error; });
  await recovered.initialize();
  const snapshot = await recovered.dispatch({ method: 'session.snapshot', params: { sessionId } });
  assert.equal(snapshot.messages[1].id, before.messages[1].id);
  assert.equal(snapshot.messages[1].content.length, 0);
  assert.equal(snapshot.messages[1].status, 'interrupted'); assert.equal(snapshot.lastSeq, 0);
  assert.equal(snapshot.runs[0].status, 'interrupted');
  assert.equal(repo.readSession(sessionId).runs[0].pendingContent, undefined);
  const duplicate = await recovered.dispatch({ method: 'run.start', params: input(sessionId) });
  assert.equal(duplicate.runId, accepted.runId); assert.equal(duplicate.disposition, 'duplicate');
  assert.equal(f.executions.length, 1);
  await recovered.close();
});

test('metadata write failure stops execution before advertising a new assistant message', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.call('run.start', input(sessionId)); await tick();
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON message_links BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  assert.throws(() => f.executions[0].emit({ type: 'message.start', ordinal: 0 }), /disk failed/);
  await tick();
  assert.equal(f.fatal.length, 1);
  assert.equal(f.events.some(event => event.type === 'message.started' || event.type === 'run.finished'), false);
  await assert.rejects(f.call('session.snapshot', { sessionId }), error => error.code === 'RUNTIME_UNAVAILABLE');
});

test('new execution writes the same rows with short and long history and never serializes old content', async t => {
  const measurements = [];
  for (const historyCount of [1, 120]) {
    const f = await fixture(t);
    const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
    for (let i = 0; i < historyCount; i++) {
      await f.call('run.start', input(sessionId, `history-${i}`)); await tick();
      const execution = f.executions.at(-1);
      execution.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'history '.repeat(100) }] });
      execution.resolve(); await tick();
    }
    const state = f.service.sessions.peek(sessionId);
    for (const message of state.record.snapshot.messages) {
      Object.defineProperty(message.content, 'toJSON', { configurable: true, value() { throw Error('Historical message serialized'); } });
    }
    const a = audit(f.filename); t.after(() => a.close());
    const accepted = await f.call('run.start', input(sessionId, 'new')); await tick();
    const execution = f.executions.at(-1);
    for (let i = 0; i < 1000; i++) execution.emit({ type: 'message.delta', ordinal: 0, partIndex: 0, delta: 'a' });
    execution.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'a'.repeat(1000) }] });
    execution.resolve(); await tick();
    assert.deepEqual(f.fatal, []);
    const writes = a.writes();
    assert.ok(writes.filter(x => x.table_name === 'runs').every(x => x.row_id === accepted.runId));
    measurements.push({ rows: writes.length });
    for (const message of state.record.snapshot.messages) delete message.content.toJSON;
    const snapshot = await f.call('session.snapshot', { sessionId });
    assert.equal(snapshot.messages.length, historyCount * 2 + 2);
    a.clear(); await f.service.close(); assert.equal(a.writes().length, 0);
  }
  assert.deepEqual(measurements[0], measurements[1]);
  t.diagnostic(JSON.stringify({ shortHistory: measurements[0], longHistory: measurements[1] }));
});

test('server validates shared requests and returns structured errors without waiting on runs', async t => {
  const f = await fixture(t); t.after(() => f.service.close());
  const sent = []; const server = new IpcServer(f.service.controller, packet => sent.push(packet));
  await server.receive({ protocolVersion: 1, kind: 'request', requestId: 'bad', method: 'run.start', params: {} });
  assert.equal(sent.pop().error.code, 'INVALID_ARGUMENT');
  const request = { protocolVersion: 1, kind: 'request', requestId: 'create', method: 'session.create', params: { clientOperationId: 'create' } };
  await server.receive(request); const reply = sent.pop();
  assert.equal(responseMatchesRequest(request, reply), true);
  await server.receive({ ...request, method: 'session.snapshot', params: { sessionId: 'missing' } });
  assert.equal(sent.pop().error.code, 'SESSION_NOT_FOUND');
});

test('model setup failure produces a failed Run without a simulated assistant message', async t => {
  const f = await fixture(t);
  f.runtime.openSession = async () => { throw new Error('No configured model credentials'); };
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId } = await f.call('run.start', input(sessionId)); await tick();
  const snapshot = await f.call('session.snapshot', { sessionId });
  assert.equal(snapshot.runs[0].id, runId); assert.equal(snapshot.runs[0].status, 'failed');
  assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].role, 'user');
  assert.equal(f.events.filter(e => e.type === 'run.finished').length, 1);
});

test('output capacity failure preserves the valid in-memory projection', async t => {
  const f = await fixture(t);
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
  assert.equal(f.repository.readSession(sessionId).runs[0].run.status, 'failed');
});

async function reopen(t, f, filename = f.filename) {
  const repository = new SqliteMetadataRepository(filename);
  const service = createApplication(repository, f.runtime, () => {}, error => { throw error; });
  await service.initialize(); t.after(() => service.close());
  return { repository, service, call: (method, params) => service.dispatch({ method, params }) };
}

test('native-only sessions are discovered without SQL history and loaded only when selected', async t => {
  const f = await fixture(t);
  const descriptor = await f.runtime.createSession();
  const { sessionId } = descriptor;
  f.histories.get(sessionId).push(
    { role: 'user', ordinal: 0, nativeEntryId: 'native-user', createdAt: '2026-10-05T00:00:00Z', status: 'completed', parts: [{ index: 0, type: 'text', text: 'imported question' }] },
    { role: 'assistant', ordinal: 0, nativeEntryId: 'native-answer', createdAt: '2026-10-05T00:00:01Z', status: 'completed', parts: [{ index: 0, type: 'text', text: 'imported answer' }] });
  await f.service.close();
  const restored = await reopen(t, f);
  assert.equal(f.historyReads(), 0, 'discovery must not request full UI histories');
  assert.equal((await restored.call('session.list', {})).items[0].sessionId, sessionId);
  assert.equal(f.historyReads(), 0);
  const snapshots = await Promise.all([restored.call('session.snapshot', { sessionId }), restored.call('session.snapshot', { sessionId })]);
  assert.equal(f.historyReads(), 1, 'concurrent cold queries share one history read');
  assert.equal(snapshots[0].messages[1].content[0].text, 'imported answer');
  assert.equal(snapshots[0].runs.length, 0);
  assert.equal(snapshots[0].messages[0].runId, undefined);
  await restored.service.close();
  const second = await reopen(t, f);
  const snapshot = await second.call('session.snapshot', { sessionId });
  assert.equal(snapshot.messages[0].id, snapshots[0].messages[0].id);
  assert.equal(snapshot.messages[1].id, snapshots[0].messages[1].id);
});

test('restart projects completed content from native history with stable IDs and no resubmission', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const accepted = await f.call('run.start', input(sessionId)); await tick();
  f.executions[0].emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'answer' }] });
  f.executions[0].resolve(); await tick();
  const before = await f.call('session.snapshot', { sessionId });
  await f.service.close();
  f.histories.get(sessionId)[1].parts[0].text = 'native is authoritative';
  const restored = await reopen(t, f);
  const after = await restored.call('session.snapshot', { sessionId });
  assert.equal(after.messages[1].content[0].text, 'native is authoritative');
  assert.equal(after.messages[1].id, before.messages[1].id);
  assert.equal(after.messages[0].id, accepted.messageId);
  assert.equal(after.messages[0].clientMessageId, 'client');
  assert.equal((await restored.call('run.start', input(sessionId))).disposition, 'duplicate');
  assert.equal(f.executions.length, 1);
});

test('missing native history fails that query instead of substituting a SQL transcript', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.service.close();
  f.runtime.listSessions = async () => [];
  f.runtime.readHistory = async () => { throw Error('native file missing'); };
  const restored = await reopen(t, f);
  assert.equal((await restored.call('session.list', {})).items[0].sessionId, sessionId);
  await assert.rejects(restored.call('session.snapshot', { sessionId }), /native file missing/);
  assert.equal(restored.service.sessions.peek(sessionId), undefined);
});

test('simultaneous submissions after a cold native-history load accept only once', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.service.close();
  const restored = await reopen(t, f);
  let release;
  const read = f.runtime.readHistory;
  f.runtime.readHistory = async descriptor => { await new Promise(resolve => { release = resolve; }); return read(descriptor); };
  const a = restored.call('run.start', input(sessionId));
  const b = restored.call('run.start', input(sessionId));
  const c = restored.call('run.start', input(sessionId, 'different'));
  const busy = assert.rejects(c, error => error.code === 'SESSION_BUSY');
  release();
  const [first, second] = await Promise.all([a, b]); await busy;
  assert.equal(first.runId, second.runId);
  assert.equal(first.disposition, 'accepted'); assert.equal(second.disposition, 'duplicate');
  assert.equal(restored.repository.readSession(sessionId).runs.length, 1);
  // Restore reads before shutdown; no pending model run needs to finish the test.
  f.runtime.readHistory = read;
  await restored.service.close();
});

test('deduplication and Run queries survive a native history read failure', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const accepted = await f.call('run.start', input(sessionId));
  await f.service.close();
  f.runtime.readHistory = async () => { throw Error('native unavailable'); };
  const restored = await reopen(t, f);
  const duplicate = await restored.call('run.start', input(sessionId));
  assert.equal(duplicate.runId, accepted.runId); assert.equal(duplicate.disposition, 'duplicate');
  assert.equal((await restored.call('run.get', { sessionId, runId: accepted.runId })).status, 'cancelled');
  await assert.rejects(restored.call('session.snapshot', { sessionId }), /native unavailable/);
  assert.equal(restored.service.sessions.peek(sessionId), undefined);
});

test('cancel during native reconciliation wins before the terminal decision and emits one finish', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  const { runId } = await f.call('run.start', input(sessionId)); await tick();
  const execution = f.executions[0];
  execution.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'done' }] });
  const read = f.runtime.readHistory;
  let release;
  f.runtime.readHistory = async descriptor => { await new Promise(resolve => { release = resolve; }); return read(descriptor); };
  execution.resolve(); await tick();
  assert.equal((await f.call('run.cancel', { sessionId, runId })).disposition, 'requested');
  release(); await tick();
  assert.equal((await f.call('run.get', { sessionId, runId })).status, 'cancelled');
  assert.equal(f.repository.findRun(sessionId, runId).status, 'cancelled');
  assert.equal(f.events.filter(event => event.type === 'run.finished').length, 1);
  assert.deepEqual(f.fatal, []);
  f.runtime.readHistory = read;
});

test('shutdown during session loading blocks late acceptance and waits before closing resources', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'create' });
  await f.service.close();
  const restored = await reopen(t, f);
  const read = f.runtime.readHistory;
  let release;
  f.runtime.readHistory = async descriptor => { await new Promise(resolve => { release = resolve; }); return read(descriptor); };
  const request = restored.call('run.start', input(sessionId));
  const rejected = assert.rejects(request, error => error.code === 'RUNTIME_UNAVAILABLE');
  let disposed = false; f.runtime.dispose = () => { disposed = true; };
  const close = restored.service.close();
  await tick(); assert.equal(disposed, false);
  release(); await rejected; await close;
  assert.equal(disposed, true); assert.equal(f.executions.length, 0);
  const db = new DatabaseSync(f.filename); assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0); db.close();
  f.runtime.readHistory = read;
});

test('failed initialization can be closed once and requests remain unavailable', async () => {
  let disposed = 0, closed = 0;
  const service = createApplication({ close() { closed++; } }, {
    async listSessions() { throw Error('discovery failed'); }, dispose() { disposed++; },
  }, () => {}, () => {});
  await assert.rejects(service.initialize(), /discovery failed/);
  await assert.rejects(service.dispatch({ method: 'session.list', params: {} }), error => error.code === 'RUNTIME_UNAVAILABLE');
  await Promise.all([service.close(), service.close()]);
  assert.equal(closed, 1); assert.equal(disposed, 1);
});

test('rename updates snapshots and survives native discovery; deleted sessions never reappear', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'managed', title: 'Original' });
  const result = await f.call('session.rename', { sessionId, title: '  Renamed  ' });
  assert.equal(result.session.title, 'Renamed');
  assert.equal((await f.call('session.snapshot', { sessionId })).session.title, 'Renamed');
  await f.service.close();
  let recovered = createApplication(new SqliteMetadataRepository(f.filename), f.runtime, () => {}, () => {});
  await recovered.initialize();
  assert.equal(recovered.sessions.list({}).items[0].title, 'Renamed');
  assert.equal(recovered.sessions.delete({ sessionId }).sessionId, sessionId);
  assert.equal(recovered.sessions.delete({ sessionId }).sessionId, sessionId, 'delete retry is idempotent');
  await assert.rejects(recovered.sessions.snapshot({ sessionId }), e => e.code === 'SESSION_NOT_FOUND');
  await assert.rejects(recovered.sessions.create({ clientOperationId: 'managed', title: 'Original' }), e => e.code === 'SESSION_NOT_FOUND');
  await recovered.close();
  recovered = createApplication(new SqliteMetadataRepository(f.filename), f.runtime, () => {}, () => {});
  await recovered.initialize();
  assert.equal(recovered.sessions.list({}).items.length, 0);
  assert.equal(f.nativeSessions.length, 1, 'native history remains owned by the runtime');
  await recovered.close();
});

test('delete refuses active runs, then succeeds after cancellation reaches a terminal state', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'busy-delete' });
  const { runId } = await f.call('run.start', input(sessionId));
  await assert.rejects(f.call('session.delete', { sessionId }), e => e.code === 'SESSION_BUSY');
  await f.call('run.cancel', { sessionId, runId });
  await tick(); await tick();
  await f.call('session.delete', { sessionId });
  assert.equal(f.service.sessions.list({}).items.length, 0);
  await assert.rejects(f.call('run.start', input(sessionId, 'another')), e => e.code === 'SESSION_NOT_FOUND');
});

test('deleting during history loading cannot resurrect a cached session or accept a run', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'loading-delete' });
  await f.service.close();
  let release;
  f.runtime.readHistory = () => new Promise(resolve => { release = resolve; });
  const recovered = createApplication(new SqliteMetadataRepository(f.filename), f.runtime, () => {}, () => {});
  await recovered.initialize();
  const pending = recovered.application.runs.start(input(sessionId));
  recovered.sessions.delete({ sessionId });
  release([]);
  await assert.rejects(pending, e => e.code === 'SESSION_NOT_FOUND');
  assert.equal(recovered.sessions.peek(sessionId), undefined);
  await recovered.close();
});


test('provider defaults, session choices and accepted Runs persist independently', async t => {
  let version = 'configuration-one'; const opened = [];
  const a = { providerId: 'first', modelId: 'same-model' };
  const b = { providerId: 'second', modelId: 'same-model' };
  const f = await fixture(t, runtime => ({
    listProviders: async () => [], saveProvider: async () => {}, removeProvider: async () => {},
    prepareModel: async selection => {
      if (!['first', 'second'].includes(selection.providerId)) throw { code: 'INVALID_ARGUMENT' };
      const captured = version;
      return { selection, configVersion: captured, openSession: descriptor => {
        opened.push({ selection, version: captured }); return runtime.openSession(descriptor);
      } };
    },
  }));
  await f.call('model.setDefault', { model: a });
  const { sessionId } = await f.call('session.create', { clientOperationId: 'model-session' });
  assert.deepEqual((await f.call('session.snapshot', { sessionId })).session.model, a);
  await f.call('model.setDefault', { model: b });
  assert.deepEqual((await f.call('session.snapshot', { sessionId })).session.model, a);
  const accepted = await f.call('run.start', input(sessionId));
  version = 'configuration-two';
  await assert.rejects(f.call('session.setModel', { sessionId, model: b }), e => e.code === 'SESSION_BUSY');
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ selection: a, version: 'configuration-one' }]);
  const run = await f.call('run.get', { sessionId, runId: accepted.runId });
  assert.deepEqual(run.model, a); assert.equal(run.modelConfigVersion, 'configuration-one');
  f.executions[0].resolve(); await tick();
  await f.call('session.setModel', { sessionId, model: b });
  await assert.rejects(f.call('provider.remove', { providerId: 'second' }), e => e.code === 'INVALID_ARGUMENT');
  assert.deepEqual(JSON.parse(JSON.stringify(f.repository.listSessions()[0].session.model)), b);
  assert.deepEqual(JSON.parse(JSON.stringify(f.repository.getDefaultModel())), b);
  assert.deepEqual(JSON.parse(JSON.stringify(f.repository.readSession(sessionId).runs[0].run.model)), a);
  assert.equal((await f.call('run.start', input(sessionId))).disposition, 'duplicate');
  const next = await f.call('run.start', input(sessionId, 'next')); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened[1])), { selection: b, version: 'configuration-two' });
  f.executions[1].resolve(); await tick();
  assert.equal((await f.call('run.get', { sessionId, runId: next.runId })).status, 'completed');
});

test('session creation deduplication compares the requested model, not a later default', async t => {
  const f = await fixture(t, runtime => ({ listProviders: async () => [],
    prepareModel: async selection => ({ selection, configVersion: 'one', openSession: d => runtime.openSession(d) }),
  }));
  const a = { providerId: 'a', modelId: 'm' }, b = { providerId: 'b', modelId: 'm' };
  await f.call('model.setDefault', { model: a });
  const created = await f.call('session.create', { clientOperationId: 'implicit' });
  await f.call('model.setDefault', { model: b });
  assert.deepEqual(await f.call('session.create', { clientOperationId: 'implicit' }), created);
  const request = { clientOperationId: 'explicit', model: a };
  const explicit = await f.call('session.create', request);
  await f.call('session.setModel', { sessionId: explicit.sessionId, model: b });
  assert.deepEqual(await f.call('session.create', { ...request, model: { modelId: a.modelId, providerId: a.providerId } }), explicit);
  await assert.rejects(f.call('session.create', { ...request, model: b }), e => e.code === 'SUBMISSION_CONFLICT');
});

test('provider-reported model travels through events and snapshots independently of the selected model', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'reported-model' });
  await f.call('run.start', input(sessionId)); await tick();
  const execution = f.executions[0];
  execution.emit({ type: 'message.start', ordinal: 0 });
  execution.emit({ type: 'message.model', ordinal: 0, responseModelId: 'server-reported-version' });
  execution.emit({ type: 'message.complete', ordinal: 0, parts: [{ index: 0, type: 'text', text: 'answer' }] });
  execution.resolve(); await tick();
  assert.equal(f.events.find(event => event.type === 'message.model.reported').data.responseModelId, 'server-reported-version');
  assert.equal((await f.call('session.snapshot', { sessionId })).messages.at(-1).responseModelId, 'server-reported-version');
});

test('automatic titles publish before model output, remain based on first input and recover without becoming explicit', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'automatic-title' });
  assert.equal((await f.call('session.list', {})).items[0].title, '新会话');
  await f.call('run.start', input(sessionId, 'first', '  检查\n 播放器连接  ')); await tick();
  assert.equal(f.events.find(e => e.type === 'session.updated').data.session.title, '检查 播放器连接');
  assert.equal(f.events.some(e => e.type === 'message.started'), false, 'title does not wait for model output');
  assert.equal((await f.call('session.snapshot', { sessionId })).session.title, '检查 播放器连接');
  f.executions[0].resolve(); await tick();
  await f.call('run.start', input(sessionId, 'second', '完全不同的话题')); await tick();
  assert.equal((await f.call('session.list', {})).items[0].title, '检查 播放器连接');
  f.executions[1].resolve(); await tick();
  await f.service.close();
  const restored = await reopen(t, f);
  assert.equal(restored.repository.listSessions()[0].titleSource, 'automatic');
  assert.equal((await restored.call('session.list', {})).items[0].title, '检查 播放器连接');
  assert.equal(f.nativeSessions[0].name, undefined);
});

test('manual names, including the placeholder text, survive late title events and native discovery', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.call('session.create', { clientOperationId: 'manual-title' });
  await f.call('run.start', input(sessionId)); await tick();
  await f.call('session.rename', { sessionId, title: '新会话' });
  f.executions[0].emit({ type: 'session.title', title: 'stale automatic title' });
  assert.equal((await f.call('session.snapshot', { sessionId })).session.title, '新会话');
  assert.equal(f.nativeSessions[0].name, '新会话');
  f.executions[0].resolve(); await tick(); await f.service.close();
  const restored = await reopen(t, f);
  assert.equal(restored.repository.listSessions()[0].titleSource, 'explicit');
  assert.equal((await restored.call('session.list', {})).items[0].title, '新会话');
});

test('legacy placeholder titles refresh while SQLite-only names migrate to native exactly once', async t => {
  const f = await fixture(t);
  for (const title of ['新会话', '我的旧名称']) await f.call('session.create', { clientOperationId: title });
  for (const metadata of f.repository.listSessions()) {
    metadata.titleSource = undefined;
    metadata.session.title = metadata.descriptor.sessionId === 's1' ? '新会话' : '我的旧名称';
    f.repository.saveSession(metadata);
  }
  f.nativeSessions[0].title = '已有的第一条消息';
  f.nativeSessions[1].title = '另一个第一条消息';
  await f.service.close();
  const restored = await reopen(t, f);
  const titles = new Map((await restored.call('session.list', {})).items.map(s => [s.sessionId, s.title]));
  assert.equal(titles.get('s1'), '已有的第一条消息');
  assert.equal(titles.get('s2'), '我的旧名称');
  assert.equal(f.nativeSessions[0].name, undefined);
  assert.equal(f.nativeSessions[1].name, '我的旧名称');
  await restored.service.close();
  // Native edits after migration are authoritative, not overwritten by old cache.
  f.runtime.setSessionName(f.nativeSessions[1].descriptor, '从 Pi 修改的名称');
  const again = await reopen(t, f);
  assert.equal((await again.call('session.list', {})).items.find(s => s.sessionId === 's2').title, '从 Pi 修改的名称');
});
