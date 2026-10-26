const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const load = require('../helpers/load-ts.cjs')();
const { ProviderAuthManager } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/providers/provider-auth-manager.ts'));
const { CredentialRepository } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/providers/credential-repository.ts'));
const { isAgentRequest, isProviderAuthEvent, isResponseFor } = load(path.resolve(__dirname, '../../../shared/agent/validation.ts'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const credential = { type: 'oauth', access: 'expired', refresh: 'refresh', expires: 0, projectId: 'fixture' };
function fixture(t, login, timeout = 10000) {
  const events = []; let committed = 0, removed = 0;
  const manager = new ProviderAuthManager(async () => ({ login }), s => {
    assert.equal(isProviderAuthEvent({ protocolVersion: 1, kind: 'provider.auth', state: s }), true); events.push(s);
  }, async () => { committed++; }, async () => { removed++; }, timeout);
  t.after(() => manager.dispose());
  return { manager, events, get committed() { return committed; }, get removed() { return removed; } };
}
const waitForAbort = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
test('OAuth returns immediately, deduplicates starts and accepts only its active callback prompt', async t => {
  let received, calls = 0;
  const f = fixture(t, async (_id, type, interaction) => {
    calls++; assert.equal(type, 'oauth');
    interaction.notify({ type: 'auth_url', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' });
    received = await interaction.prompt({ type: 'text', message: 'provider message' }); return credential;
  });
  const first = f.manager.start('antigravity');
  assert.equal(f.manager.start('antigravity').loginId, first.loginId); await tick();
  const state = f.manager.status('antigravity'); assert.equal(calls, 1); assert.equal(state.phase, 'waiting');
  const input = { providerId: 'antigravity', loginId: first.loginId, promptId: state.prompt.id, callbackUrl: '1//refresh' };
  assert.throws(() => f.manager.submit(input), e => e.code === 'INVALID_ARGUMENT');
  input.callbackUrl = 'http://localhost:51121/oauth-callback?code=fixture&state=fixture';
  f.manager.submit(input); await tick();
  assert.equal(received, input.callbackUrl); assert.equal(f.committed, 1);
  assert.equal(f.manager.status('antigravity').phase, 'succeeded');
  assert.equal(f.manager.status('antigravity').prompt, undefined);
  assert.throws(() => f.manager.submit(input), e => e.code === 'INVALID_ARGUMENT');
});
test('automatic callback completion dismisses manual input', async t => {
  let complete;
  const f = fixture(t, async (_id, _type, interaction) => {
    void interaction.prompt({ type: 'text', message: 'paste' }).catch(() => {});
    await new Promise(resolve => { complete = resolve; }); return credential;
  });
  f.manager.start('antigravity'); await tick(); complete(); await tick();
  assert.equal(f.manager.status('antigravity').phase, 'succeeded'); assert.equal(f.manager.status('antigravity').prompt, undefined);
});
test('cancel and logout prevent late commit and reject stale login IDs', async t => {
  const f = fixture(t, async (_id, _type, interaction) => waitForAbort(interaction.signal));
  const first = f.manager.start('antigravity'); await tick(); f.manager.cancel('antigravity', first.loginId);
  assert.equal(f.manager.status('antigravity').phase, 'cancelled');
  const second = f.manager.start('antigravity'); await tick(); assert.notEqual(first.loginId, second.loginId);
  assert.throws(() => f.manager.cancel('antigravity', first.loginId));
  await f.manager.logout('antigravity');
  assert.equal(f.committed, 0); assert.equal(f.removed, 1); assert.equal(f.manager.status('antigravity').phase, 'idle');
});
test('timeouts abort login and provider errors are sanitized', async t => {
  const f = fixture(t, async (_id, _type, interaction) => waitForAbort(interaction.signal), 15);
  f.manager.start('antigravity'); await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.manager.status('antigravity').phase, 'expired');
  const g = fixture(t, async () => { throw new Error('access_token=secret'); });
  g.manager.start('antigravity'); await tick(); assert.equal(g.manager.status('antigravity').phase, 'failed');
  assert.ok(!JSON.stringify(g.events).includes('secret'));
});
function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-auth-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json'); return { repo: new CredentialRepository(file), file };
}
test('runtime snapshots share refresh serialization and never inherit Antigravity after logout', async t => {
  const { repo, file } = repository(t); await repo.modify('antigravity', async () => credential);
  const a = repo.snapshot(repo.readAll(), { antigravity: { ...credential, access: 'external' } });
  const b = repo.snapshot(repo.readAll(), {}); a.activate(); b.activate(); let refreshed = 0;
  const refresh = async current => {
    if (current.expires === 0) { refreshed++; await tick(); return { ...current, access: 'new', expires: Date.now() + 100000 }; } return current;
  };
  await Promise.all([a.store.modify('antigravity', refresh), b.store.modify('antigravity', refresh)]);
  assert.equal(refreshed, 1); assert.equal((await a.store.read('antigravity')).access, 'new');
  await repo.delete('antigravity'); assert.equal(await a.store.read('antigravity'), undefined); assert.equal(await b.store.read('antigravity'), undefined);
  const reopened = repo.snapshot(repo.readAll(), { antigravity: credential }); reopened.activate();
  assert.equal(await reopened.store.read('antigravity'), undefined); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('logout removes the result of an in-flight refresh', async t => {
  const { repo } = repository(t); await repo.modify('antigravity', async () => credential); let release;
  const refresh = repo.modify('antigravity', async value => { await new Promise(resolve => { release = resolve; }); return { ...value, access: 'rotated' }; });
  await tick(); const logout = repo.delete('antigravity'); release(); await Promise.all([refresh, logout]); assert.equal(repo.readAll().antigravity, undefined);
});
test('protocol rejects malformed auth data; logs redact callback URLs and credentials', () => {
  const request = { protocolVersion: 1, kind: 'request', requestId: 'r', method: 'provider.auth.submit', params: {
    providerId: 'antigravity', loginId: 'l', promptId: 'p', callbackUrl: 'http://localhost:51121/oauth-callback?code=secret' } };
  assert.equal(isAgentRequest(request), true);
  assert.equal(isAgentRequest({ ...request, params: { ...request.params, callbackUrl: 1 } }), false);
  assert.equal(isResponseFor('provider.auth.start', { protocolVersion: 1, kind: 'response', requestId: 'r', ok: true,
    result: { providerId: 'antigravity', loginId: 'l', phase: 'starting', revision: 1, access: 'secret' } }), false);
  const logging = load(path.resolve(__dirname, '../../../shared/agent/logging.ts')); const logs = [];
  logging.configureAgentLogging({ enabled: true, level: 'debug', payloads: true }, item => logs.push(item));
  logging.createAgentLogger('main').debug('test', request, { access: 'access-secret', refresh: 'refresh-secret', authUrl: 'url-secret' });
  assert.ok(!JSON.stringify(logs).includes('secret')); logging.configureAgentLogging({ enabled: false });
});
test('pinned adapter registers real SDK OAuth and chat models without CLI account storage', async () => {
  const { getAntigravityProviderConfig } = await require('../helpers/antigravity.cjs')();
  const sdk = await import('@earendil-works/pi-coding-agent');
  const runtime = await sdk.ModelRuntime.create({ modelsPath: '/nonexistent/mozi-auth-models.json', allowModelNetwork: false });
  runtime.registerProvider('antigravity', getAntigravityProviderConfig()); await runtime.refresh({ allowNetwork: false });
  assert.ok(runtime.getModels('antigravity').length > 0); assert.ok(runtime.getProvider('antigravity').auth.oauth.login);
  assert.ok(runtime.getModels('antigravity').every(m => m.api === 'antigravity-api'));
});
test('real extension opens a loopback callback listener, rejects wrong state and releases its port on cancel', async () => {
  const { getAntigravityProviderConfig } = await require('../helpers/antigravity.cjs')();
  const sdk = await import('@earendil-works/pi-coding-agent');
  const saved = [];
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, credentials: {
    read: async () => undefined, list: async () => [], delete: async () => {},
    modify: async (_id, fn) => { const value = await fn(undefined); saved.push(value); return value; },
  } });
  runtime.registerProvider('antigravity', getAntigravityProviderConfig());
  const controller = new AbortController(); let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const login = runtime.login('antigravity', 'oauth', {
    signal: controller.signal,
    notify: event => { if (event.type === 'auth_url') ready(event.url); },
    prompt: async () => waitForAbort(controller.signal),
  });
  const outcome = login.then(() => 'unexpected', () => 'cancelled');
  try {
    const url = new URL(await opened);
    assert.equal(url.origin, 'https://accounts.google.com');
    const redirect = url.searchParams.get('redirect_uri');
    assert.equal(redirect, 'http://localhost:51121/oauth-callback');
    const response = await fetch(`${redirect}?code=fixture&state=wrong`);
    assert.equal(response.status, 400);
    await response.text();
  } finally { controller.abort(); }
  assert.equal(await outcome, 'cancelled'); assert.equal(saved.length, 0);
  await tick();
  await assert.rejects(fetch('http://localhost:51121/oauth-callback'));
});

test('a provider that resolves after cancellation cannot persist a login', async t => {
  let release;
  const f = fixture(t, async () => { await new Promise(resolve => { release = resolve; }); return credential; });
  const login = f.manager.start('antigravity'); await tick();
  f.manager.cancel('antigravity', login.loginId); release(); await tick();
  assert.equal(f.committed, 0); assert.equal(f.manager.status('antigravity').phase, 'cancelled');
});
