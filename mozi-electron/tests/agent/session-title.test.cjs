const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const os = require('node:os');
const createLoader = require('../helpers/load-ts.cjs');
const load = createLoader();
const { titleFromFirstMessage } = load(path.resolve(__dirname, '../../src/agent/domain/session-title.ts'));
const { isAgentEvent } = load(path.resolve(__dirname, '../../../shared/agent/index.ts'));
const { initialAgentState, applyAgentEvent } = load(path.resolve(__dirname, '../../../mozi-app/src/agent/agentState.ts'));

test('automatic title normalization is bounded and does not split Unicode characters', () => {
  assert.equal(titleFromFirstMessage('  第一行\n\t第二行  '), '第一行 第二行');
  assert.equal(titleFromFirstMessage(' \n '), '新会话');
  assert.equal(titleFromFirstMessage('😀'.repeat(90)), '😀'.repeat(80));
});

test('title events validate session identity and update the frontend list without replacing messages', () => {
  const session = { sessionId: 's', title: '自动标题', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' };
  const event = { protocolVersion: 1, kind: 'event', type: 'session.updated', sessionId: 's', runId: 'r', seq: 1, data: { session } };
  assert.equal(isAgentEvent(event), true);
  assert.equal(isAgentEvent({ ...event, sessionId: 'other' }), false);
  const state = initialAgentState('s');
  const next = applyAgentEvent(state, event);
  assert.equal(next.sessions[0].title, '自动标题');
  assert.equal(next.messages, state.messages);
  assert.equal(next.lastSeq, 1);
});

test('real Pi JSONL keeps explicit names and the live writer cursor through rename and further messages', async t => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const loadNative = createLoader({ '@earendil-works/pi-coding-agent': sdk });
  const { PiNativeHistory } = loadNative(path.resolve(__dirname, '../../src/agent/infrastructure/pi/native-history.ts'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-title-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new PiNativeHistory({ cwd: root, dataDir: root });
  const descriptor = await history.createSession();
  assert.equal((await history.listSessions())[0].title, '新会话');
  const manager = history.acquire(descriptor);
  const userId = manager.appendMessage({ role: 'user', content: '  第一条\n消息  ', timestamp: Date.now() });
  assert.equal((await history.listSessions())[0].title, '第一条 消息');
  history.setSessionName(descriptor, '手动名称');
  const nameEntry = manager.getEntries().at(-1);
  assert.equal(nameEntry.type, 'session_info');
  assert.equal(nameEntry.parentId, userId);
  manager.appendMessage({ role: 'user', content: '第二条消息', timestamp: Date.now() });
  assert.equal(manager.getEntries().at(-1).parentId, nameEntry.id, 'active writer follows the name entry');
  history.release(descriptor);
  assert.equal(history.open(descriptor).getSessionName(), '手动名称');
  assert.equal((await history.listSessions())[0].title, '手动名称');
  const entries = readFileSync(descriptor.locator, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(e => e.type === 'session_info').length, 1, 'automatic fallback was never written as a name');
  const empty = await history.createSession();
  history.setSessionName(empty, '空会话手动命名');
  assert.equal(history.open(empty).getSessionName(), '空会话手动命名');
});
