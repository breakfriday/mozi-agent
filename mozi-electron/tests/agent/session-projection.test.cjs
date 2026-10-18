const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { SessionProjection } = load(path.resolve(__dirname, '../../src/agent/sessions/session-projection.ts'));
const { projectHistory } = load(path.resolve(__dirname, '../../src/agent/sessions/history-projection.ts'));
const { AGENT_MAX_MESSAGE_BYTES } = load(path.resolve(__dirname, '../../../shared/agent'));
const at = '2026-10-18T00:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const seed = () => ({ snapshot: { session: { sessionId: 's', title: 'session', createdAt: at, updatedAt: at },
  lastSeq: 0, messages: [], runs: [], tools: [], approvals: [] }, messageLinks: [] });
const accepted = () => ({
  metadata: { run: { id: 'r', sessionId: 's', userMessageId: 'u', status: 'accepted', createdAt: at, updatedAt: at },
    clientMessageId: 'c', contentHash: 'hash', pendingContent: [{ type: 'text', text: 'hello' }] },
  message: { id: 'u', sessionId: 's', runId: 'r', clientMessageId: 'c', role: 'user', status: 'accepted', content: [{ id: 'u:text:0', type: 'text', text: 'hello' }] },
  link: { messageId: 'u', runId: 'r', role: 'user', ordinal: 0 },
});
const assistant = () => ({ message: { id: 'a', sessionId: 's', runId: 'r', role: 'assistant', status: 'streaming', content: [] },
  link: { messageId: 'a', runId: 'r', role: 'assistant', ordinal: 0 } });

test('construction, prepared inputs, query results and execution Runs cannot mutate projection data', () => {
  const initial = seed(), projection = new SessionProjection(initial), input = accepted();
  initial.snapshot.session.title = 'outside';
  const change = projection.prepareRunAccepted(input);
  input.metadata.run.status = 'cancelled'; input.message.content[0].text = 'outside'; input.link.nativeEntryId = 'outside';
  assert.equal(projection.toSnapshot().runs.length, 0, 'preparation is invisible');
  change.commit();
  const snapshot = projection.toSnapshot();
  assert.equal(snapshot.session.title, 'session');
  assert.equal(snapshot.runs[0].status, 'accepted');
  assert.equal(snapshot.messages[0].content[0].text, 'hello');
  snapshot.runs[0].status = 'failed'; snapshot.messages.length = 0;
  const link = projection.findMessageLink('r', 'user', 0); link.nativeEntryId = 'outside';
  assert.equal(projection.toSnapshot().messages.length, 1);
  assert.equal(projection.toSnapshot().runs[0].status, 'accepted');
  assert.equal(projection.findMessageLink('r', 'user', 0).nativeEntryId, undefined);
  for (const field of ['record', 'messages', 'runs', 'links', 'messagesByRun']) assert.equal(projection[field], undefined);
  assert.throws(() => change.commit(), error => error.code === 'PROTOCOL_MISMATCH');
});

test('invalid/capacity-rejected composite changes leave no Run, message or identity behind', () => {
  const projection = new SessionProjection(seed()), input = accepted(), before = projection.toSnapshot();
  input.message.content[0].text = 'x'.repeat(256_001);
  assert.throws(() => projection.prepareRunAccepted(input), error => error.code === 'CAPACITY_EXCEEDED');
  assert.deepEqual(projection.toSnapshot(), before);
  assert.equal(projection.findMessageLink('r', 'user', 0), undefined);
  const mismatched = accepted(); mismatched.link.messageId = 'wrong';
  assert.throws(() => projection.prepareRunAccepted(mismatched), error => error.code === 'PROTOCOL_MISMATCH');
  projection.prepareRunAccepted(accepted()).commit();
  projection.prepareAssistantStarted(assistant()).commit();
  const streaming = projection.toSnapshot();
  assert.throws(() => projection.prepareMessageCompleted({ messageId: 'a', links: [], content: [
    { id: 'duplicate', type: 'text', text: 'one' }, { id: 'duplicate', type: 'text', text: 'two' },
  ] }), error => error.code === 'PROTOCOL_MISMATCH');
  assert.deepEqual(projection.toSnapshot(), streaming);
  assert.throws(() => projection.reportUsage({ id: 'missing-run', provider: 'fixture', model: 'm', status: 'running', startedAt: at }),
    error => error.code === 'PROTOCOL_MISMATCH');
  assert.deepEqual(projection.toSnapshot(), streaming);
});

test('terminal projection change settles messages, tools and links together without deciding the Run outcome', () => {
  const projection = new SessionProjection(seed()), input = accepted();
  projection.prepareRunAccepted(input).commit(); projection.prepareAssistantStarted(assistant()).commit();
  projection.appendMessageDelta({ messageId: 'a', partId: 'a:text:0', type: 'text', delta: 'partial' });
  projection.reportTool({ toolCallId: 't', messageId: 'a', runId: 'r', toolName: 'read', status: 'running' });
  const before = projection.toSnapshot();
  const change = projection.prepareRunFinished({ run: { ...input.metadata.run, status: 'cancelled' }, outcome: { status: 'cancelled' },
    links: [{ ...input.link, nativeEntryId: 'native-u' }] });
  assert.deepEqual(projection.toSnapshot(), before);
  change.tools[0].status = 'failed';
  change.commit();
  const after = projection.toSnapshot();
  assert.equal(after.runs[0].status, 'cancelled');
  assert.deepEqual(after.messages.map(message => message.status), ['completed', 'cancelled']);
  assert.equal(after.messages[1].content[0].text, 'partial');
  assert.equal(after.tools[0].status, 'cancelled');
  assert.equal(projection.findMessageLink('r', 'user', 0).nativeEntryId, 'native-u');
});

test('stale prepared changes cannot overwrite intervening updates', () => {
  const projection = new SessionProjection(seed());
  const change = projection.prepareRunAccepted(accepted());
  projection.prepareSessionUpdated({ ...seed().snapshot.session, title: 'renamed' }).commit();
  assert.throws(() => change.commit(), error => error.code === 'PROTOCOL_MISMATCH');
  assert.equal(projection.toSnapshot().runs.length, 0);
  assert.equal(projection.toSnapshot().session.title, 'renamed');
});

test('metadata growth is retained in the budget used by subsequent message deltas', () => {
  const initial = seed(), message = assistant().message;
  initial.snapshot.messages.push(message);
  initial.snapshot.session.title = 'x'.repeat(AGENT_MAX_MESSAGE_BYTES - 64_000 - Buffer.byteLength(JSON.stringify(initial.snapshot)) - 100);
  const projection = new SessionProjection(initial);
  const snapshot = projection.toSnapshot();
  projection.prepareSessionUpdated({ ...snapshot.session, title: snapshot.session.title + 'x'.repeat(80) }).commit();
  const before = projection.toSnapshot();
  assert.throws(() => projection.appendMessageDelta({ messageId: 'a', partId: 'a:text:0', type: 'text', delta: 'x'.repeat(40) }),
    error => error.code === 'CAPACITY_EXCEEDED');
  assert.deepEqual(projection.toSnapshot(), before);
});

test('session metadata growth participates in incremental capacity accounting and terminal reserve remains usable', () => {
  const projection = new SessionProjection(seed());
  const input = accepted(); projection.prepareRunAccepted(input).commit(); projection.prepareAssistantStarted(assistant()).commit();
  // Fill via many bounded messages, leaving less room than a metadata change requires.
  let ordinal = 1;
  for (;;) {
    const next = assistant(); next.message.id = `a${ordinal}`; next.link.messageId = next.message.id; next.link.ordinal = ordinal++;
    next.message.content = [{ id: `${next.message.id}:text:0`, type: 'text', text: 'x'.repeat(200_000) }];
    try { projection.prepareAssistantStarted(next).commit(); }
    catch (error) { assert.equal(error.code, 'CAPACITY_EXCEEDED'); break; }
  }
  const snapshot = projection.toSnapshot();
  const available = AGENT_MAX_MESSAGE_BYTES - 64_000 - Buffer.byteLength(JSON.stringify(snapshot));
  assert.throws(() => projection.prepareSessionUpdated({ ...snapshot.session, title: 'x'.repeat(available + 1000) }), error => error.code === 'CAPACITY_EXCEEDED');
  assert.deepEqual(projection.toSnapshot(), snapshot);
  projection.prepareRunFinished({ run: { ...input.metadata.run, status: 'failed', error: { code: 'CAPACITY_EXCEEDED', message: 'full' } },
    outcome: { status: 'failed', error: { code: 'CAPACITY_EXCEEDED', message: 'full' } }, links: [] }).commit();
  assert.equal(projection.toSnapshot().runs[0].status, 'failed');
});

test('history conversion does not mutate sources and rebuild agrees with completed incremental representation', () => {
  const input = accepted(), metadata = { descriptor: { sessionId: 's', engine: 'fixture' }, session: seed().snapshot.session };
  const run = { ...input.metadata.run, status: 'completed' };
  const details = { runs: [{ ...input.metadata, run }], links: [input.link, assistant().link] };
  const history = [
    { runId: 'r', role: 'user', ordinal: 0, nativeEntryId: 'native-u', status: 'completed', createdAt: at, parts: [{ index: 0, type: 'text', text: 'hello' }] },
    { runId: 'r', role: 'assistant', ordinal: 0, nativeEntryId: 'native-a', status: 'completed', createdAt: at, parts: [{ index: 0, type: 'text', text: 'answer' }] },
  ];
  const original = structuredClone({ metadata, details, history });
  const rebuilt = projectHistory(metadata, details, history);
  assert.deepEqual({ metadata, details, history }, original);
  const restored = new SessionProjection(rebuilt.seed), live = new SessionProjection(seed());
  live.prepareRunAccepted(input).commit(); live.prepareAssistantStarted(assistant()).commit();
  live.prepareMessageCompleted({ messageId: 'a', content: [{ id: 'a:text:0', type: 'text', text: 'answer' }], links: [] }).commit();
  live.prepareRunFinished({ run, outcome: { status: 'completed' }, links: rebuilt.confirmedLinks }).commit();
  assert.deepEqual(plain(live.toSnapshot()), plain(restored.toSnapshot()));
  rebuilt.seed.snapshot.session.title = 'outside';
  assert.equal(restored.toSnapshot().session.title, 'session');
});
