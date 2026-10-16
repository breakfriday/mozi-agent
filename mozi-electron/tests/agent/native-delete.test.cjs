const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLoader = require('../helpers/load-ts.cjs');

async function fixture(t, fsOverride) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const load = createLoader({ '@earendil-works/pi-coding-agent': sdk, ...(fsOverride ? { 'node:fs': fsOverride } : {}) });
  const { PiSessionStore } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-store.ts'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = new PiSessionStore({ cwd: root, dataDir: root });
  return { root, history, descriptor: await history.createSession() };
}

test('permanent deletion removes actual Pi JSONL including usage, preserves neighbors and permits retries', async t => {
  const { history, descriptor } = await fixture(t);
  const neighbor = await history.createSession();
  const manager = history.acquire(descriptor);
  manager.appendMessage({ role: 'user', content: 'private message', timestamp: Date.now() });
  manager.appendCustomEntry('mozi.model-call-usage', { id: 'private-usage' });
  assert.throws(() => history.deleteSession(descriptor), e => e.code === 'SESSION_BUSY');
  assert.equal(fs.existsSync(descriptor.locator), true);
  history.release(descriptor);
  history.deleteSession(descriptor);
  assert.equal(fs.existsSync(descriptor.locator), false);
  assert.equal(fs.existsSync(neighbor.locator), true);
  history.deleteSession(descriptor);
  assert.deepEqual(Array.from(await history.listSessions(), s => s.descriptor.sessionId), [neighbor.sessionId]);
});

test('deletion rejects foreign paths, symlinks, directories and mismatched identities', async t => {
  const { history, descriptor, root } = await fixture(t);
  const outside = path.join(root, 'outside.jsonl');
  fs.copyFileSync(descriptor.locator, outside);
  assert.throws(() => history.deleteSession({ ...descriptor, locator: outside }), e => e.code === 'PERMISSION_DENIED');
  assert.throws(() => history.deleteSession({ ...descriptor, sessionId: 'wrong' }), e => e.code === 'INTERNAL_ERROR');
  const link = path.join(root, 'pi-sessions', 'symlink.jsonl');
  fs.symlinkSync(outside, link);
  assert.throws(() => history.deleteSession({ ...descriptor, locator: link }), e => e.code === 'PERMISSION_DENIED');
  const dirLink = path.join(root, 'pi-sessions', 'external');
  fs.symlinkSync(root, dirLink, 'dir');
  assert.throws(() => history.deleteSession({ ...descriptor, locator: path.join(dirLink, 'outside.jsonl') }), e => e.code === 'PERMISSION_DENIED');
  const directory = path.join(root, 'pi-sessions', 'directory.jsonl');
  fs.mkdirSync(directory);
  assert.throws(() => history.deleteSession({ ...descriptor, locator: directory }), e => e.code === 'PERMISSION_DENIED');
  assert.equal(fs.existsSync(descriptor.locator), true);
  assert.equal(fs.existsSync(outside), true);
});

test('unlink failure is reported without losing the JSONL', async t => {
  const { history, descriptor } = await fixture(t, { ...fs, unlinkSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.throws(() => history.deleteSession(descriptor), e => e.code === 'INTERNAL_ERROR' && e.message.includes('记录已保留'));
  assert.equal(fs.existsSync(descriptor.locator), true);
});
