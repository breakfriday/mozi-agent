const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const createLoader = require('../helpers/load-ts.cjs');
async function fixture(t) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const packageLoad = createLoader();
  const extension = packageLoad(path.resolve(__dirname, '../../node_modules/@aiwayds/pi-bailian-token-plan/index.ts'));
  const load = createLoader({ '@earendil-works/pi-coding-agent': sdk, '@aiwayds/pi-bailian-token-plan': extension });
  const { PiProviderManager } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/provider-manager.ts'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-provider-'));
  const config = { dataDir: root, cwd: root, piDir: path.join(root, 'external-pi') };
  mkdirSync(config.piDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new PiProviderManager(config);
  return { manager, root, config, PiProviderManager, load };
}
const custom = (name = 'custom', apiKey = 'fixture-only-key') => ({ providerId: name, name: 'Custom Service',
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:12345/v1', apiKey,
  models: [{ id: 'model', name: 'A Model', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false }],
});

test('real Pi loads the pinned extension model catalog without credentials or ambient extensions', async t => {
  const f = await fixture(t);
  const providers = await f.manager.listProviders();
  const bailian = providers.find(item => item.id === 'bailian-tp');
  assert.ok(bailian); assert.equal(bailian.source, 'extension'); assert.equal(bailian.configured, false);
  assert.equal(bailian.models.length, 8);
  assert.ok(bailian.models.some(model => model.id === 'deepseek-v4-pro'));
  assert.equal(bailian.endpointLocked, true);
  const { isApiResultFor } = f.load(path.resolve(__dirname, '../../../shared/agent'));
  assert.equal(isApiResultFor('model.settings', { ok: true, result: { providers } }), true, 'entire catalog crosses the shared contract');
  assert.equal(existsSync(path.join(f.config.piDir, 'auth.json')), false);
  await assert.rejects(f.manager.prepare({ providerId: 'bailian-tp', modelId: bailian.models[0].id }), e => e.code === 'INVALID_ARGUMENT');
});

test('custom provider/key persist privately, are not returned, and edits do not mutate a prepared runtime', async t => {
  const f = await fixture(t);
  await f.manager.saveProvider(custom());
  const selection = { providerId: 'custom', modelId: 'model' };
  const first = await f.manager.prepare(selection);
  await f.manager.saveProvider({ providerId: 'custom', apiKey: 'replacement-secret' });
  const second = await f.manager.prepare(selection);
  assert.notEqual(first.runtime, second.runtime); assert.notEqual(first.version, second.version);
  assert.equal((await first.runtime.getAuth(first.model)).auth.apiKey, 'fixture-only-key');
  assert.equal((await second.runtime.getAuth(second.model)).auth.apiKey, 'replacement-secret');
  assert.equal(first.model.baseUrl, 'http://127.0.0.1:12345/v1');
  const reopened = new f.PiProviderManager(f.config);
  assert.equal((await reopened.prepare(selection)).model.id, 'model');
  const response = JSON.stringify(await reopened.listProviders());
  assert.equal(response.includes('replacement-secret'), false);
  assert.equal(readFileSync(path.join(f.root, 'providers/models.json'), 'utf8').includes('replacement-secret'), false);
  assert.equal(statSync(path.join(f.root, 'providers/auth.json')).mode & 0o777, 0o600);
  await reopened.removeProvider('custom');
  await assert.rejects(reopened.prepare(selection), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(readFileSync(path.join(f.root, 'providers/auth.json'), 'utf8').includes('replacement-secret'), false);
});

test('Token Plan refuses endpoint overrides and retains package model compatibility when adding models', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.saveProvider({ providerId: 'bailian-tp', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), e => e.code === 'INVALID_ARGUMENT');
  await f.manager.saveProvider({ providerId: 'bailian-tp', apiKey: 'fixture-plan-key', models: custom().models });
  const configured = (await f.manager.listProviders()).find(p => p.id === 'bailian-tp');
  assert.equal(configured.models.length, 9); assert.equal(configured.configured, true);
  const prepared = await f.manager.prepare({ providerId: 'bailian-tp', modelId: 'model' });
  assert.equal(prepared.model.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(prepared.model.compat.thinkingFormat, 'qwen');
  assert.equal(prepared.model.compat.supportsDeveloperRole, false);
  await assert.rejects(f.manager.removeProvider('bailian-tp'), e => e.code === 'INVALID_ARGUMENT');
});

test('external Pi configuration is read without rewriting it; plan registration keeps its dedicated endpoint', async t => {
  const f = await fixture(t);
  const external = { providers: { 'bailian-tp': { baseUrl: 'https://example.com/wrong' } } };
  const filename = path.join(f.config.piDir, 'models.json');
  writeFileSync(filename, JSON.stringify(external));
  const providers = await f.manager.listProviders();
  assert.equal(providers.find(p => p.id === 'bailian-tp').baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(readFileSync(filename, 'utf8'), JSON.stringify(external));
});


test('real Pi sessions send through the selected provider, preserve history, and keep captured keys/endpoints', async t => {
  const f = await fixture(t);
  const { createServer } = require('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => ({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'local fixture answer' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { PiAdapter } = f.load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/pi-adapter.ts'));
  const adapter = new PiAdapter(f.config);
  await adapter.saveProvider({ ...custom('first', 'first-key'), baseUrl: `${base}/first/v1` });
  await adapter.saveProvider({ ...custom('second', 'second-key'), baseUrl: `${base}/second/v1` });
  const descriptor = await adapter.createSession();
  const prepared = await adapter.prepareModel({ providerId: 'first', modelId: 'model' });
  await adapter.saveProvider({ providerId: 'first', baseUrl: `${base}/changed/v1`, apiKey: 'changed-key' });
  for (const [index, selected] of [prepared, await adapter.prepareModel({ providerId: 'second', modelId: 'model' })].entries()) {
    const session = await selected.openSession(descriptor);
    try { await session.execute({ runId: `run-${index}`, clientMessageId: `client-${index}`, content: [{ type: 'text', text: `hello ${index}` }] }, () => {}); }
    finally { session.dispose(); }
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/first/v1/chat/completions');
  assert.equal(requests[0].auth, 'Bearer first-key');
  assert.equal(requests[1].url, '/second/v1/chat/completions');
  assert.equal(requests[1].auth, 'Bearer second-key');
  assert.equal(requests[1].body.model, 'model');
  assert.ok(JSON.stringify(requests[1].body.messages).includes('hello 0'), 'switching provider retains native conversation history');
  assert.equal((await adapter.readHistory(descriptor)).filter(m => m.role === 'assistant').length, 2);
});


test('inherited credentials stay read-only and are never included in the catalog', async t => {
  const f = await fixture(t);
  const filename = path.join(f.config.piDir, 'auth.json');
  const contents = JSON.stringify({ 'bailian-tp': { type: 'api_key', key: 'external-plan-secret' } });
  writeFileSync(filename, contents);
  const binding = await f.manager.prepare({ providerId: 'bailian-tp', modelId: 'deepseek-v4-pro' });
  assert.equal((await binding.runtime.getAuth(binding.model)).auth.apiKey, 'external-plan-secret');
  await f.manager.saveProvider({ providerId: 'bailian-tp', apiKey: 'managed-plan-secret' });
  assert.equal(readFileSync(filename, 'utf8'), contents);
  assert.equal((await binding.runtime.getAuth(binding.model)).auth.apiKey, 'external-plan-secret');
  const response = JSON.stringify(await f.manager.listProviders());
  assert.equal(response.includes('external-plan-secret'), false);
  assert.equal(response.includes('managed-plan-secret'), false);
});

test('response model evidence comes only from HTTP chunks, survives native history, and never leaks between requests', async t => {
  const f = await fixture(t);
  const { createServer } = require('node:http');
  const modes = ['model', 'server-model-2026', undefined, '', 'conflict'];
  let requestIndex = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.model, 'model');
    assert.equal(JSON.stringify(request.messages).includes('mozi.provider-response-model'), false);
    assert.equal(JSON.stringify(request.messages).includes('server-model-2026'), false, 'response metadata is not sent as dialogue');
    const reported = modes[requestIndex++];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const index of [0, 1]) {
      const model = reported === 'conflict' ? `conflicting-model-${index}` : reported;
      const chunk = { id: `response-${requestIndex}`, object: 'chat.completion.chunk', created: 1,
        ...(model !== undefined ? { model } : {}),
        choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content: 'answer' } : {}, finish_reason: index === 1 ? 'stop' : null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { PiAdapter } = f.load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/pi-adapter.ts'));
  const adapter = new PiAdapter(f.config);
  await adapter.saveProvider({ ...custom('fixture'), baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  const descriptor = await adapter.createSession();
  const expected = ['model', 'server-model-2026', undefined, undefined, undefined];
  for (let index = 0; index < modes.length; index++) {
    const prepared = await adapter.prepareModel({ providerId: 'fixture', modelId: 'model' });
    const session = await prepared.openSession(descriptor);
    const events = [];
    try { await session.execute({ runId: `evidence-${index}`, clientMessageId: `input-${index}`, content: [{ type: 'text', text: 'Compare this answer' }] }, event => events.push(event)); }
    finally { session.dispose(); }
    assert.equal(events.find(e => e.type === 'message.model')?.responseModelId, expected[index]);
    assert.equal(events.filter(e => e.type === 'message.model').length, expected[index] ? 1 : 0);
    const reopened = new PiAdapter(f.config);
    const history = (await reopened.readHistory(descriptor)).filter(m => m.role === 'assistant');
    assert.equal(history.length, index + 1);
    assert.deepEqual(Array.from(history, m => m.responseModelId), expected.slice(0, index + 1));
  }
  const native = readFileSync(descriptor.locator, 'utf8');
  assert.equal(native.split('\n').filter(line => line.includes('mozi.provider-response-model')).length, 2);
});
