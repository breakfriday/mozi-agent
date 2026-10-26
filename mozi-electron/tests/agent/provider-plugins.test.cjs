const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const createLoader = require('../helpers/load-ts.cjs');
const source = name => path.resolve(__dirname, '../../src/agent/runtime/pi/providers', name);
const tick = () => new Promise(resolve => setImmediate(resolve));
const policy = { prompt: { message: 'Fixture code' }, normalizeInput: value => value.trim(), successMessage: 'Connected', failureMessage: () => 'Failed' };
const model = { id: 'model', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const base = id => ({ id, source: 'extension', authMethods: ['api_key'], 
  createConfig: () => ({ api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models: [model] }) });

test('registry rejects duplicate identities and inconsistent OAuth declarations', () => {
  const load = createLoader(); const { ProviderRegistry } = load(source('provider-registry.ts'));
  assert.throws(() => new ProviderRegistry([base('one'), base('one')]), /Duplicate/);
  assert.throws(() => new ProviderRegistry([{ ...base('oauth'), authMethods: ['oauth'] }]), /OAuth/);
});

test('a new provider integrates through declarations alone, including isolated OAuth and session hooks', async t => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const load = createLoader({ '@earendil-works/pi-coding-agent': sdk });
  const { ProviderRegistry } = load(source('provider-registry.ts'));
  const { CredentialRepository } = load(source('credential-repository.ts'));
  const { FileProviderConfigurationStore } = load(source('provider-configuration-store.ts'));
  const { PiRuntimeFactory } = load(source('pi-runtime-factory.ts'));
  const { PiProviderManager } = load(source('provider-manager.ts'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-plugins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, piDir: path.join(dir, 'external'), cwd: dir }; fs.mkdirSync(config.piDir);
  const token = { access: 'fixture', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
  fs.writeFileSync(path.join(config.piDir, 'auth.json'), JSON.stringify({ 'new-oauth': { type: 'oauth', ...token } }));
  let hooks = 0;
  const plugin = { ...base('new-oauth'), authMethods: ['oauth'], oauth: policy,  settingsEditable: false,
    prepareModel: value => ({ ...value, name: 'Prepared by plugin' }), configureAgent: () => { hooks++; },
    createConfig: () => ({ ...base('new-oauth').createConfig(), oauth: {
      name: 'Fixture OAuth', login: async () => token, refreshToken: async value => value, getApiKey: value => value.access,
    } }),
  };
  const registry = new ProviderRegistry([plugin, base('new-key')]);
  const configuration = new FileProviderConfigurationStore(path.join(dir, 'providers'));
  const credentials = new CredentialRepository(path.join(dir, 'providers/auth.json'), id => registry.credentialPolicy(id));
  const runtimeFactory = new PiRuntimeFactory({ config, registry, credentials });
  const states = [];
  const manager = new PiProviderManager({ registry, configuration, credentials, runtimeFactory, visualBrowser: false,
    emitAuth: state => states.push(state), emitCatalog: () => {} });
  t.after(() => manager.dispose());
  assert.equal((await manager.listProviders()).find(p => p.id === plugin.id).configured, false, 'new identity cannot inherit CLI credentials');
  const login = manager.auth.start(plugin.id);
  for (let i = 0; i < 100 && manager.auth.status(plugin.id).phase !== 'succeeded'; i++) await tick();
  assert.equal(manager.auth.status(plugin.id).phase, 'succeeded', JSON.stringify(states));
  assert.equal(manager.auth.status(plugin.id).loginId, login.loginId);
  const binding = await manager.prepare({ providerId: plugin.id, modelId: 'model' });
  assert.equal(binding.model.name, 'Prepared by plugin'); binding.configureAgent({}, false); assert.equal(hooks, 1);
  await manager.auth.logout(plugin.id);
  assert.equal((await manager.listProviders()).find(p => p.id === plugin.id).configured, false);
  assert.equal(await binding.runtime.getAuth(plugin.id), undefined, 'existing runtime sees logout');
  await manager.saveProvider({ providerId: 'new-key', apiKey: 'fixture-key' });
  assert.equal((await manager.listProviders()).find(p => p.id === 'new-key').configured, true);
});

test('catalog work is deduplicated per provider, independent across providers and ignores reset results', async t => {
  const load = createLoader(); const { ProviderRegistry } = load(source('provider-registry.ts'));
  const { ProviderCatalogService } = load(source('provider-catalog-service.ts'));
  const releases = new Map(), calls = [], events = [];
  const registry = new ProviderRegistry(['alpha', 'beta'].map(id => ({ ...base(id), dynamicModels: true })));
  const service = new ProviderCatalogService({ registry, hasCredential: () => true, emit: id => events.push(id),
    refresh: (id, signal) => new Promise(resolve => { calls.push(id); releases.set(id, { resolve, signal }); }) });
  t.after(() => service.dispose());
  assert.equal(service.view('alpha').catalogStatus, 'idle'); assert.equal(calls.length, 0);
  const a = service.refresh('alpha'); assert.equal(service.refresh('alpha'), a);
  const b = service.refresh('beta'); await tick(); assert.equal(calls.length, 2);
  releases.get('beta').resolve(); await b;
  assert.equal(service.view('alpha').catalogStatus, 'refreshing'); assert.equal(service.view('beta').catalogStatus, 'ready');
  service.reset('alpha'); assert.equal(releases.get('alpha').signal.aborted, true);
  releases.get('alpha').resolve(); await a;
  assert.equal(service.view('alpha').catalogStatus, 'idle');
  assert.equal(events.filter(id => id === 'alpha').length, 1, 'obsolete completion is not published');
});

test('OAuth sessions and cancellation are independent for different declared providers', async t => {
  const load = createLoader(); const { ProviderAuthManager } = load(source('provider-auth-manager.ts'));
  const commits = [];
  const manager = new ProviderAuthManager({ policy: () => policy, emit: () => {},
    runtime: async () => ({ login: async (_id, _type, interaction) => {
      const code = await interaction.prompt({ type: 'text', message: 'Code' }); return { type: 'oauth', access: code, refresh: code, expires: 1 };
    } }), committed: async (id, credential) => { commits.push({ id, credential }); }, removeCredential: async () => {} });
  t.after(() => manager.dispose());
  const a = manager.start('alpha'), b = manager.start('beta'); await tick();
  manager.cancel('alpha', a.loginId);
  manager.submit({ providerId: 'beta', loginId: b.loginId, promptId: manager.status('beta').prompt.id, callbackUrl: ' beta-code ' });
  await tick();
  assert.equal(manager.status('alpha').phase, 'cancelled'); assert.equal(manager.status('beta').phase, 'succeeded');
  assert.equal(commits.length, 1); assert.equal(commits[0].id, 'beta'); assert.equal(commits[0].credential.access, 'beta-code');
});

test('runtime builds retain their own invalid-grant callbacks, including concurrent builds', async t => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const load = createLoader({ '@earendil-works/pi-coding-agent': sdk });
  const { ProviderRegistry } = load(source('provider-registry.ts'));
  const { CredentialRepository } = load(source('credential-repository.ts'));
  const { FileProviderConfigurationStore } = load(source('provider-configuration-store.ts'));
  const { PiRuntimeFactory } = load(source('pi-runtime-factory.ts'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mozi-build-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, piDir: path.join(dir, 'external'), cwd: dir };
  fs.mkdirSync(config.piDir);
  const plugin = { ...base('context-oauth'), authMethods: ['oauth'], oauth: policy,
    createConfig: ({ onInvalidGrant }) => ({ ...base('context-oauth').createConfig(), oauth: {
      name: 'Context OAuth', login: async () => ({}), getApiKey: value => value.access,
      refreshToken: async () => { onInvalidGrant(); throw new Error('invalid_grant'); },
    } }),
  };
  const registry = new ProviderRegistry([plugin]);
  const configuration = new FileProviderConfigurationStore(path.join(dir, 'providers'));
  const credentials = new CredentialRepository(path.join(dir, 'providers/auth.json'), id => registry.credentialPolicy(id));
  const factory = new PiRuntimeFactory({ config, registry, credentials });
  const events = [];
  const [first, second] = await Promise.all(['first', 'second'].map(label => factory.build(configuration.read(), {}, {
    onInvalidGrant: id => events.push(`${label}:${id}`),
  })));
  for (const snapshot of [second, first, second]) {
    await assert.rejects(snapshot.runtime.getRegisteredProviderConfig(plugin.id).oauth.refreshToken({}), /invalid_grant/);
  }
  assert.deepEqual(events, ['second:context-oauth', 'first:context-oauth', 'second:context-oauth']);
});

test('Bailian caches package loading per instance and directory, and retries failures', async () => {
  let calls = 0;
  const load = createLoader({ [source('bailian/provider.ts')]: {
    loadBailianProvider: async () => {
      calls++;
      if (calls === 1) throw new Error('load failed');
      return { apiKey: '$ENV', models: [] };
    },
  } });
  const { createBailianPlugin } = load(source('bailian/index.ts'));
  const plugin = createBailianPlugin();
  const context = { cwd: '/fixture', agentDir: '/fixture/pi', onInvalidGrant: () => {} };
  await assert.rejects(plugin.createConfig(context), /load failed/);
  const [first, second] = await Promise.all([plugin.createConfig(context), plugin.createConfig(context)]);
  assert.equal(calls, 2);
  assert.notEqual(first, second);
  assert.equal(first.apiKey, undefined);
  await plugin.createConfig({ ...context, agentDir: '/another/pi' });
  assert.equal(calls, 3);
  await createBailianPlugin().createConfig(context);
  assert.equal(calls, 4);
});
