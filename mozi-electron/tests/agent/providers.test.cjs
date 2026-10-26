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
  const load = createLoader({ './antigravity/provider': await require('../helpers/antigravity.cjs')(), '@earendil-works/pi-coding-agent': sdk, '@aiwayds/pi-bailian-token-plan': extension });
  const { PiProviderManager } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/providers/provider-manager.ts'));
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

test('DeepSeek registration sends thinking off and preserves local tools in native and browser modes', async t => {
  const f = await fixture(t);
  const sdk = await import('@earendil-works/pi-coding-agent');
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    respondWithResponses(res, requests.length, requests.at(-1).body.reasoning.effort !== 'none');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const providers = new f.PiProviderManager(f.config, true);
  await providers.saveProvider({ providerId: 'deepseek', apiKey: 'fixture-only-key',
    baseUrl: `http://127.0.0.1:${server.address().port}` });
  const catalog = (await providers.listProviders()).find(p => p.id === 'deepseek');
  assert.equal(catalog.api, 'openai-responses');
  for (const id of ['deepseek-v4-pro', 'deepseek-flash']) {
    const model = catalog.models.find(m => m.id === id);
    assert.ok(model.thinkingLevels.includes('off'));
    assert.equal(model.supportsWebTools, id === 'deepseek-v4-pro');
    assert.equal(model.supportsWebExtractor, false);
  }
  const { PiSessionFactory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-factory.ts'));
  for (const modelId of ['deepseek-v4-pro', 'deepseek-flash']) {
    for (const thinkingLevel of ['off', 'medium']) {
      for (const mode of ['native', 'disabled', 'browser']) {
        if (modelId === 'deepseek-flash' && mode !== 'browser') continue;
        const binding = await providers.prepare({ providerId: 'deepseek', modelId, thinkingLevel,
          webMode: mode === 'browser' ? 'browser' : 'provider', webSearch: mode !== 'disabled' });
        const manager = sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
        const session = await new PiSessionFactory(f.config, async () => { throw new Error('Unexpected browser call'); })
          .create(manager, { sessionId: manager.getSessionId(), engine: 'pi', cwd: f.root, locator: manager.getSessionFile() }, binding);
        try {
          await session.prompt('Hello');
          const { url, body } = requests.at(-1);
          assert.equal(url, '/responses');
          assert.equal(body.model, modelId);
          assert.equal(body.reasoning.effort, thinkingLevel === 'off' ? 'none' : 'high');
          for (const name of ['read', 'bash', 'edit', 'write']) {
            assert.ok(body.tools.some(tool => tool.type === 'function' && tool.name === name), name);
          }
          assert.equal(body.tools.some(tool => tool.name === 'mozi_browser'), mode === 'browser');
          assert.equal(body.tools.filter(tool => tool.type === 'web_search').length, mode === 'native' ? 1 : 0);
          assert.ok(!body.tools.some(tool => tool.type === 'web_extractor'));
          assert.ok(body.input.some(item => item.role === 'system'));
          assert.equal(session.messages.at(-1).stopReason, 'stop');
          assert.equal(session.messages.at(-1).content.some(part => part.type === 'thinking'), thinkingLevel !== 'off');
        } finally { session.dispose(); }
      }
    }
  }
});

test('real Pi calls visual search then read, returns evidence to the model and persists tool history', async t => {
  const f = await fixture(t);
  const sdk = await import('@earendil-works/pi-coding-agent');
  const requests = [], browserCalls = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const step = requests.length;
    const delta = step <= 2 ? { role: 'assistant', tool_calls: [{ index: 0, id: `browser-${step}`, type: 'function', function: {
      name: 'mozi_browser',
      arguments: JSON.stringify(step === 1 ? { action: 'search', query: 'Mozi evidence', limit: 3 } : { action: 'read', url: 'https://example.com/article' }),
    } }] } : { role: 'assistant', content: 'Summary from browser evidence.' };
    for (const [content, finish] of [[delta, null], [{}, step <= 2 ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: `response-${step}`, object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(f.root, 'auth.json'), modelsPath: path.join(f.root, 'models.json'), allowModelNetwork: false });
  runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'model', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  await runtime.setRuntimeApiKey('fixture', 'fixture-key');
  const { PiSessionFactory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-factory.ts'));
  const { PiExecution } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/execution.ts'));
  const { readHistory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/history-reader.ts'));
  const manager = sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
  const descriptor = { sessionId: manager.getSessionId(), engine: 'pi', cwd: f.root, locator: manager.getSessionFile() };
  const call = async (operation, ctx) => {
    browserCalls.push({ operation, runId: ctx.runId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
    ctx.onProgress({ stage: 'loading', message: 'Browser is loading' });
    return operation.action === 'search'
      ? { kind: 'search', query: operation.query, url: 'https://www.bing.com/search?q=Mozi', results: [{ title: 'Source', url: 'https://example.com/article', snippet: 'Evidence summary' }] }
      : { kind: 'read', title: 'Source', url: operation.url, content: 'Unique browser evidence 739', truncated: false };
  };
  const session = await new PiSessionFactory(f.config, call).create(manager, descriptor, { runtime, model: runtime.getModel('fixture', 'model'), version: 'fixture' });
  const execution = new PiExecution(session, manager);
  t.after(() => execution.dispose());
  const events = [];
  await execution.execute({ runId: 'visual-run', clientMessageId: 'visual-client', content: [{ type: 'text', text: 'Search and read the source' }] }, event => events.push(event));
  assert.deepEqual(browserCalls.map(c => c.operation.action), ['search', 'read']);
  assert.ok(browserCalls.every(c => c.runId === 'visual-run' && c.sessionId === descriptor.sessionId));
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tools.filter(tool => tool.function.name === 'mozi_browser').length, 1);
  assert.ok(requests[0].tools.every(tool => !tool.function.name.startsWith('mozi_visual_')));
  assert.match(JSON.stringify(requests[0].messages), /不要使用 bash/);
  assert.match(JSON.stringify(requests[2].messages), /Unique browser evidence 739/);
  const updates = events.filter(e => e.type === 'tool.update');
  assert.ok(updates.some(e => e.tool.status === 'running' && e.tool.outputText === 'Browser is loading'));
  assert.equal(updates.filter(e => e.tool.status === 'succeeded').length, 2);
  execution.dispose();
  const history = readHistory(sdk.SessionManager.open(manager.getSessionFile()).getBranch());
  assert.ok(history.flatMap(m => m.tools ?? []).some(tool => tool.toolName === 'mozi_browser' && tool.outputText.includes('Unique browser evidence 739')));
  const visualProviders = new f.PiProviderManager(f.config, true);
  const visibleModel = (await visualProviders.listProviders()).find(p => p.id === 'bailian-tp').models[0];
  assert.equal(visibleModel.supportsWebTools, true);
  assert.equal(visibleModel.supportsBrowserTools, true);
});

function respondWithResponses(res, id, thinking = true) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const response = { id: `resp_${id}`, model: 'server-responses-model', status: 'in_progress', output: [] };
  send({ type: 'response.created', response });
  if (thinking) {
    const item = { id: `rs_${id}`, type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'fixture thinking' }] };
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    send({ type: 'response.reasoning_text.delta', output_index: 0, delta: 'fixture thinking' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    response.output.push(item);
  }
  for (const [index, item] of [
    { id: `ws_${id}`, type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['fixture query'], sources: [{ type: 'url', url: 'https://example.com/source' }] } },
    ...(thinking ? [{ id: `we_${id}`, type: 'web_extractor_call', status: 'completed', urls: ['https://example.com/source'], goal: 'Read the source', output: 'fixture evidence' }] : []),
  ].entries()) {
    send({ type: 'response.output_item.added', output_index: index + 1, item: { ...item, status: 'in_progress' } });
    send({ type: 'response.output_item.done', output_index: index + 1, item });
    response.output.push(item);
  }
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'search fixture answer', annotations: [] }] };
  send({ type: 'response.output_item.added', output_index: 3, item: { ...message, status: 'in_progress', content: [] } });
  send({ type: 'response.content_part.added', output_index: 3, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  send({ type: 'response.output_text.delta', output_index: 3, content_index: 0, delta: 'search fixture answer' });
  send({ type: 'response.output_item.done', output_index: 3, item: message });
  response.output.push(message);
  send({ type: 'response.completed', response: { ...response, status: 'completed', usage: {
    input_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens: 10,
    output_tokens_details: { reasoning_tokens: thinking ? 3 : 0 }, total_tokens: 30,
    x_tools: { web_search: { count: 1 }, web_extractor: { count: thinking ? 1 : 0 } },
  } } });
  res.end();
}

test('real Responses tool calls execute locally and expose success and failure in live events and native history', async t => {
  const f = await fixture(t);
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { createServer } = require('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length > 1) return respondWithResponses(res, 'answer', false);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const response = { id: 'resp_tools', model: 'fixture', status: 'in_progress', output: [] };
    send({ type: 'response.created', response });
    for (const [index, filename] of ['evidence.txt', 'does-not-exist.txt'].entries()) {
      const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'read', arguments: JSON.stringify({ path: filename }), status: 'completed' };
      send({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
      send({ type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments });
      send({ type: 'response.function_call_arguments.done', output_index: index, arguments: item.arguments });
      send({ type: 'response.output_item.done', output_index: index, item });
      response.output.push(item);
    }
    send({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(path.join(f.root, 'evidence.txt'), 'unique local evidence 729');
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(f.root, 'auth.json'), modelsPath: path.join(f.root, 'models.json'), allowModelNetwork: false });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  runtime.registerProvider('fixture', { api: 'openai-responses', baseUrl, models: [{ id: 'model', name: 'Fixture', input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  await runtime.setRuntimeApiKey('fixture', 'fixture-key');
  const { PiSessionFactory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-factory.ts'));
  const { PiExecution } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/execution.ts'));
  const { readHistory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/history-reader.ts'));
  const manager = sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
  const descriptor = { sessionId: manager.getSessionId(), engine: 'pi', cwd: f.root, locator: manager.getSessionFile() };
  const session = await new PiSessionFactory(f.config).create(manager, descriptor, { runtime, model: runtime.getModel('fixture', 'model'), version: 'fixture' });
  const execution = new PiExecution(session, manager);
  t.after(() => execution.dispose());
  const events = [];
  await execution.execute({ runId: 'r-tools', clientMessageId: 'client', content: [{ type: 'text', text: 'Read both files' }] }, event => events.push(structuredClone(event)));
  const latest = [...new Map(events.filter(event => event.type === 'tool.update').map(event => [event.tool.toolCallId, event.tool])).values()];
  assert.deepEqual(latest.map(tool => tool.status), ['succeeded', 'failed']);
  assert.match(latest[0].outputText, /unique local evidence 729/);
  assert.match(latest[1].outputText, /ENOENT|no such file/i);
  assert.ok(events.filter(event => event.type === 'tool.update').every(event => event.ordinal === 0));
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].input), /unique local evidence 729/);
  execution.dispose();
  const reopened = sdk.SessionManager.open(manager.getSessionFile());
  const history = readHistory(reopened.getBranch());
  assert.deepEqual(JSON.parse(JSON.stringify(history.find(message => message.tools?.length).tools)), latest);
});

test('real Pi loads the pinned extension model catalog without credentials or ambient extensions', async t => {
  const f = await fixture(t);
  const providers = await f.manager.listProviders();
  const bailian = providers.find(item => item.id === 'bailian-tp');
  assert.ok(bailian); assert.equal(bailian.source, 'extension'); assert.equal(bailian.configured, false);
  assert.equal(bailian.models.length, 8);
  assert.ok(bailian.models.every(model => model.supportsWebTools === true));
  assert.ok(bailian.models.some(model => model.id === 'deepseek-v4-pro'));
  for (const model of bailian.models) {
    assert.deepEqual(Array.from(model.thinkingLevels), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], model.id);
  }
  assert.equal(bailian.endpointLocked, true);
  assert.equal(bailian.api, 'openai-responses');
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

test('Token Plan refuses endpoint overrides and uses Responses defaults when adding models', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.saveProvider({ providerId: 'bailian-tp', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.manager.saveProvider({ providerId: 'bailian-tp', api: 'anthropic-messages' }), e => e.code === 'INVALID_ARGUMENT');
  await f.manager.saveProvider({ providerId: 'bailian-tp', apiKey: 'fixture-plan-key', models: [
    ...custom().models,
    { ...custom().models[0], id: 'unverified-reasoner', reasoning: true },
    { ...custom().models[0], id: 'qwen3.8-max', reasoning: true },
  ] });
  const configured = (await f.manager.listProviders()).find(p => p.id === 'bailian-tp');
  assert.equal(configured.models.length, 10); assert.equal(configured.configured, true);
  const prepared = await f.manager.prepare({ providerId: 'bailian-tp', modelId: 'model' });
  assert.equal(prepared.model.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(prepared.model.api, 'openai-responses');
  assert.equal(prepared.model.compat.supportsDeveloperRole, false);
  assert.equal(prepared.model.compat.thinkingFormat, undefined);
  assert.equal(prepared.model.compat.supportsReasoningEffort, undefined, 'Chat Completions compatibility is not used by Responses');
  assert.equal(prepared.model.thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(prepared.model.thinkingLevelMap.max, 'max');
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.model.samplingParams.tools)), [{ type: 'web_search' }, { type: 'web_extractor' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared.model.samplingParamsByThinkingLevel.off.tools)), [{ type: 'web_search' }]);
  assert.equal(prepared.model.samplingParams.enable_search, undefined);
  assert.equal(prepared.model.samplingParams.search_options, undefined);
  for (const { id: modelId } of configured.models.filter(model => model.reasoning)) {
    for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const binding = await f.manager.prepare({ providerId: 'bailian-tp', modelId, thinkingLevel });
      assert.equal(binding.thinkingLevel, thinkingLevel);
      assert.equal(binding.model.api, 'openai-responses');
    }
  }
  assert.deepEqual(Array.from(configured.models.find(model => model.id === 'unverified-reasoner').thinkingLevels), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  await assert.rejects(f.manager.prepare({ providerId: 'bailian-tp', modelId: 'model', thinkingLevel: 'medium' }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(f.manager.removeProvider('bailian-tp'), e => e.code === 'INVALID_ARGUMENT');
});

test('legacy Token Plan settings upgrade to Responses without rewriting files on read or changing model IDs', async t => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'providers/models.json');
  const contents = JSON.stringify({ providers: { 'bailian-tp': {
    api: 'openai-completions', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    models: [{ ...custom().models[0], id: 'qwen3.8-max-preview', reasoning: true, maxTokens: 2048 }],
  } } });
  writeFileSync(filename, contents);
  writeFileSync(path.join(f.root, 'providers/auth.json'), JSON.stringify({ 'bailian-tp': { type: 'api_key', key: 'fixture-only-key' } }));
  assert.equal((await f.manager.listProviders()).find(p => p.id === 'bailian-tp').api, 'openai-responses');
  const binding = await f.manager.prepare({ providerId: 'bailian-tp', modelId: 'qwen3.8-max-preview', thinkingLevel: 'off' });
  assert.equal(binding.model.id, 'qwen3.8-max-preview');
  assert.equal(binding.model.api, 'openai-responses');
  assert.equal(binding.model.maxTokens, 2048);
  assert.equal(readFileSync(filename, 'utf8'), contents);
  await f.manager.saveProvider({ providerId: 'bailian-tp', api: 'openai-responses' });
  const reopened = new f.PiProviderManager(f.config);
  assert.equal((await reopened.prepare({ providerId: 'bailian-tp', modelId: 'qwen3.8-max-preview' })).model.api, 'openai-responses');
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).providers['bailian-tp'].api, 'openai-responses');
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
  const { PiAdapter } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/pi-adapter.ts'));
  const adapter = new PiAdapter(f.config);
  const reasoningModels = custom().models.map(model => ({ ...model, reasoning: true }));
  await adapter.saveProvider({ ...custom('first', 'first-key'), models: reasoningModels, baseUrl: `${base}/first/v1` });
  await adapter.saveProvider({ ...custom('second', 'second-key'), models: reasoningModels, baseUrl: `${base}/second/v1` });
  const descriptor = await adapter.createSession();
  const prepared = await adapter.prepareModel({ providerId: 'first', modelId: 'model', thinkingLevel: 'high' });
  await adapter.saveProvider({ providerId: 'first', baseUrl: `${base}/changed/v1`, apiKey: 'changed-key' });
  for (const [index, selected] of [prepared, await adapter.prepareModel({ providerId: 'second', modelId: 'model', thinkingLevel: 'off' })].entries()) {
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
  assert.equal(requests[0].body.reasoning_effort, 'high');
  assert.equal(requests[1].body.reasoning_effort, undefined, 'off overrides the previous native session thinking level');
  assert.ok(requests.every(request => request.body.enable_search === undefined), 'other providers receive no Bailian search option');
  assert.ok(JSON.stringify(requests[1].body.messages).includes('hello 0'), 'switching provider retains native conversation history');
  const messageText = message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
  for (const [index, request] of requests.entries()) {
    const messages = request.body.messages;
    const currentUser = messages.findIndex(message => message.role === 'user' && messageText(message) === `hello ${index}`);
    assert.ok(currentUser > 0);
    assert.match(messageText(messages[currentUser - 1]), /本轮用户消息的本地时间：/);
    assert.ok(messageText(messages[currentUser - 1]).includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
    assert.ok(messages.filter(message => message.role === 'system').every(message => !JSON.stringify(message.content).includes('本地时间')));
  }
  const history = await adapter.readHistory(descriptor);
  assert.equal(history.filter(m => m.role === 'assistant').length, 2);
  assert.deepEqual(Array.from(history.filter(m => m.role === 'user'), message => message.parts.map(part => part.text).join('')), ['hello 0', 'hello 1'], 'time context never changes displayed user messages');
  const entries = readFileSync(descriptor.locator, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const times = entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'mozi.prompt-time');
  assert.equal(times.length, 2, 'each prompt carries its own time context after reopening the session');
  assert.ok(times.every(entry => entry.display === false));
});

test('Bailian model defaults coexist with local coding tools and follow provider switches', async t => {
  const f = await fixture(t);
  const sdk = await import('@earendil-works/pi-coding-agent');
  await f.manager.saveProvider({ providerId: 'bailian-tp', apiKey: 'fixture-only-key' });
  const { model: bailianModel } = await f.manager.prepare({ providerId: 'bailian-tp', modelId: 'qwen3.8-max-preview' });
  const { createServer } = require('node:http');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    if (req.url === '/v1/responses') return respondWithResponses(res, requests.length, requests.at(-1).body.reasoning?.effort !== 'none');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => ({ id: 'response', object: 'chat.completion.chunk', created: 1, model: 'model', choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'search fixture answer' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(f.root, 'fixture-auth.json'), modelsPath: path.join(f.root, 'fixture-models.json'),
    modelsStorePath: path.join(f.root, 'fixture-cache.json'), allowModelNetwork: false,
  });
  for (const provider of ['bailian-tp', 'other']) {
    const model = provider === 'bailian-tp' ? bailianModel : {
      name: 'Fixture', input: ['text'], contextWindow: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    runtime.registerProvider(provider, {
      api: provider === 'bailian-tp' ? 'openai-responses' : 'openai-completions', baseUrl,
      models: [{ ...model, id: 'model', baseUrl, reasoning: provider === 'bailian-tp', maxTokens: 1024 }],
    });
    await runtime.setRuntimeApiKey(provider, 'fixture-only-key');
  }
  const { PiSessionFactory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-factory.ts'));
  const manager = sdk.SessionManager.inMemory(f.root);
  const session = await new PiSessionFactory(f.config).create(manager,
    { sessionId: manager.getSessionId(), engine: 'pi', locator: '', cwd: f.root },
    { runtime, model: runtime.getModel('bailian-tp', 'model'), version: 'fixture' });
  t.after(() => session.dispose());
  const localToolNames = ['read', 'bash', 'edit', 'write'];
  assert.deepEqual(session.getActiveToolNames().sort(), [...localToolNames].sort());
  const remoteTools = body => (body.tools ?? []).filter(tool => tool.type !== 'function');
  const assertLocalTools = body => assert.deepEqual(
    body.tools.filter(tool => tool.type === 'function').map(tool => tool.name ?? tool.function.name).sort(),
    [...localToolNames].sort(),
  );
  await session.prompt('Search the web for the current release.');
  await session.setModel(runtime.getModel('other', 'model'));
  await session.prompt('Continue with the other provider.');
  await session.setModel(runtime.getModel('bailian-tp', 'model'));
  session.setThinkingLevel('medium');
  await session.prompt('Search again.');
  assert.equal(requests.length, 3);
  const serverTools = [{ type: 'web_search' }, { type: 'web_extractor' }];
  assert.deepEqual(requests.map(request => request.url), ['/v1/responses', '/v1/chat/completions', '/v1/responses']);
  assert.deepEqual(requests.map(request => remoteTools(request.body)), [serverTools, [], serverTools]);
  requests.forEach(request => assertLocalTools(request.body));
  assert.ok(requests.every(request => request.body.enable_search === undefined && request.body.search_options === undefined));
  assert.ok(JSON.stringify(requests[2].body.input).includes('Continue with the other provider.'), 'Responses keeps previous Chat Completions history');
  assert.equal(requests[0].body.max_output_tokens, 1024);
  assert.equal(requests[0].body.store, false);
  assert.equal(session.getLastAssistantText(), 'search fixture answer');
  assert.equal(session.messages.at(-1).stopReason, 'stop', 'server tools are handled remotely instead of entering the local tool loop');
  assert.equal(session.messages.at(-1).usage.totalTokens, 30);
  session.dispose();
  const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'off', 'high', 'xhigh', 'max', 'off'];
  for (const thinkingLevel of thinkingLevels) {
    const next = await new PiSessionFactory(f.config).create(manager,
      { sessionId: manager.getSessionId(), engine: 'pi', locator: '', cwd: f.root },
      { runtime, model: runtime.getModel('bailian-tp', 'model'), version: 'fixture', thinkingLevel });
    try {
      assert.equal(next.thinkingLevel, thinkingLevel);
      await next.prompt(`Continue with thinking ${thinkingLevel}.`);
      const body = requests.at(-1).body;
      assert.equal(body.reasoning.effort, thinkingLevel === 'off' ? 'none' : thinkingLevel, thinkingLevel);
      assertLocalTools(body);
      assert.deepEqual(remoteTools(body), thinkingLevel === 'off' ? [{ type: 'web_search' }] : serverTools, 'web_extractor requires thinking, while web_search remains available when off');
      assert.equal(body.enable_thinking, thinkingLevel === 'off' ? undefined : true, 'only thinking levels explicitly enable thinking');
      for (const key of ['reasoning_effort', 'enable_search', 'search_options', 'max_tokens']) assert.equal(body[key], undefined, key);
      assert.equal(next.messages.at(-1).content.some(part => part.type === 'thinking'), thinkingLevel !== 'off');
    } finally { next.dispose(); }
  }
  assert.equal(requests.length, 3 + thinkingLevels.length);
  const { withBailianWebTools } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/providers/bailian.ts'));
  const sharedModel = runtime.getModel('bailian-tp', 'model');
  const original = JSON.stringify(sharedModel);
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const webSearch of [false, true]) for (const webExtractor of [false, true]) {
      const model = withBailianWebTools(sharedModel, { providerId: 'bailian-tp', modelId: 'model', thinkingLevel, webSearch, webExtractor });
      const next = await new PiSessionFactory(f.config).create(manager,
        { sessionId: manager.getSessionId(), engine: 'pi', locator: '', cwd: f.root },
        { runtime, model, version: 'fixture', thinkingLevel });
      try {
        await next.prompt('Check selected tools.');
        const body = requests.at(-1).body;
        assertLocalTools(body);
        assert.deepEqual(remoteTools(body), [
          ...(webSearch ? [{ type: 'web_search' }] : []),
          ...(webExtractor && thinkingLevel !== 'off' ? [{ type: 'web_extractor' }] : []),
        ], JSON.stringify({ thinkingLevel, webSearch, webExtractor }));
        assert.equal(body.reasoning.effort, thinkingLevel === 'off' ? 'none' : thinkingLevel);
        assert.equal(body.enable_thinking, thinkingLevel === 'off' ? undefined : true);
      } finally { next.dispose(); }
    }
  }
  assert.equal(JSON.stringify(sharedModel), original, 'session switches never mutate shared models');

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
  const { PiAdapter } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/pi-adapter.ts'));
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

test('real Responses usage survives reopening without counting assistant history or tool events twice', async t => {
  const f = await fixture(t);
  const { createServer } = require('node:http');
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert.equal(text.includes('mozi.model-call-usage'), false, 'metrics never enter model context');
    respondWithResponses(res, body.reasoning.effort, body.reasoning.effort !== 'none');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { PiAdapter } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/pi-adapter.ts'));
  const adapter = new PiAdapter(f.config);
  await adapter.saveProvider({ ...custom('usage'), api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ ...custom().models[0], reasoning: true }] });
  const descriptor = await adapter.createSession();
  const completed = [];
  for (const thinkingLevel of ['medium', 'off']) {
    const prepared = await adapter.prepareModel({ providerId: 'usage', modelId: 'model', thinkingLevel });
    const session = await prepared.openSession(descriptor);
    const events = [];
    try { await session.execute({ runId: thinkingLevel, clientMessageId: thinkingLevel, content: [{ type: 'text', text: 'fixture query' }] }, event => events.push(event)); }
    finally { session.dispose(); }
    const usage = events.filter(event => event.type === 'usage.update');
    assert.equal(usage.length, 2);
    assert.equal(usage[0].call.status, 'running');
    assert.equal(usage[1].call.status, 'completed');
    assert.deepEqual(JSON.parse(JSON.stringify(usage[1].call.usage)), { input: 16, cacheRead: 4, cacheWrite: 0, output: 10, reasoning: thinkingLevel === 'off' ? 0 : 3, totalTokens: 30 });
    assert.equal(usage[1].call.thinkingLevel, thinkingLevel);
    assert.equal(usage[1].call.webSearch, 1);
    assert.equal(usage[1].call.webExtractor, thinkingLevel === 'off' ? 0 : 1);
    assert.equal(usage[1].call.webSearchSource, 'provider');
    assert.equal(usage[1].call.webExtractorSource, 'provider');
    assert.deepEqual(Array.from(usage[1].call.steps, step => step.type), thinkingLevel === 'off'
      ? ['web_search', 'message'] : ['reasoning', 'web_search', 'web_extractor', 'message']);
    assert.ok(usage[1].call.steps.find(step => step.type === 'web_search').queries.length);
    assert.ok(usage[1].call.steps.find(step => step.type === 'web_search').sources.length);
    if (thinkingLevel !== 'off') assert.ok(usage[1].call.steps.find(step => step.type === 'web_extractor').urls.length);
    completed.push(usage[1].call);
  }
  const reopened = new PiAdapter(f.config);
  assert.deepEqual(JSON.parse(JSON.stringify(await reopened.readUsage(descriptor))), JSON.parse(JSON.stringify(completed)));
  assert.equal((await reopened.readHistory(descriptor)).filter(message => message.role === 'assistant').length, 2);
});

test('model call observer does not change Responses payloads or consume streamed answers', async () => {
  const { pathToFileURL } = require('node:url');
  const { streamSimple } = await import(pathToFileURL(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js')));
  const load = createLoader();
  const { observeModelCalls } = load(path.resolve(__dirname, '../../src/agent/runtime/pi/model-call/observer.ts'));
  const model = { id: 'qwen-fixture', provider: 'fixture', api: 'openai-responses', baseUrl: 'https://fixture.invalid/v1',
    name: 'Fixture', reasoning: true, input: ['text'], contextWindow: 262144, maxTokens: 65536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false },
    samplingParams: { tools: [{ type: 'web_search' }, { type: 'web_extractor' }] },
    samplingParamsByThinkingLevel: { medium: { enable_thinking: true } } };
  const context = { systemPrompt: 'fixture system', messages: [{ role: 'user', content: 'fixture query', timestamp: 1 }] };
  const requests = [], outputs = [], records = [];
  for (const monitored of [false, true]) {
    const agent = { streamFunction: streamSimple };
    const observer = monitored ? observeModelCalls(agent, {
      runId: 'r', onCallUpdated: call => records.push(JSON.parse(JSON.stringify(call))),
    }) : undefined;
    const stream = await agent.streamFunction(model, context, { apiKey: 'fixture-only', reasoning: 'medium', maxRetries: 0,
      fetch: async (url, init) => {
        requests.push(JSON.parse(init.body));
        let body = '';
        respondWithResponses({ writeHead() {}, write(chunk) { body += chunk; }, end() {} }, 'same', true);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      } });
    const deltas = [];
    for await (const event of stream) if (event.type === 'text_delta' || event.type === 'thinking_delta') deltas.push([event.type, event.delta]);
    const message = await stream.result();
    outputs.push({ deltas, content: message.content, usage: message.usage, stopReason: message.stopReason });
    if (observer) {
      assert.equal(observer.getResponseModel(message), records.at(-1).responseModelId);
      assert.equal(observer.getResponseModel(message), 'server-responses-model');
    }
    observer?.dispose();
  }
  assert.deepEqual(requests[1], requests[0], 'monitoring must leave all request parameters and model context unchanged');
  assert.deepEqual(outputs[1], outputs[0], 'result observers must not consume the answer stream');
  assert.equal(outputs[1].stopReason, 'stop');
  assert.ok(outputs[1].deltas.some(([type, delta]) => type === 'text_delta' && delta.includes('search fixture answer')));
  assert.equal(records.at(-1).status, 'completed');
  assert.equal(records.at(-1).steps.length, 4);
});


test('session web tool choices reach prepared bindings and leave other sessions at their defaults', async t => {
  const f = await fixture(t);
  await f.manager.saveProvider({ providerId: 'bailian-tp', apiKey: 'fixture-plan-key' });
  const selection = { providerId: 'bailian-tp', modelId: 'qwen3.8-max-preview', thinkingLevel: 'high', webSearch: false, webExtractor: false };
  const disabled = await f.manager.prepare(selection);
  const defaults = await f.manager.prepare({ providerId: selection.providerId, modelId: selection.modelId });
  assert.equal(JSON.stringify(disabled.model.samplingParamsByThinkingLevel.high.tools), '[]');
  assert.equal(JSON.stringify(defaults.model.samplingParamsByThinkingLevel.high.tools), '[{"type":"web_search"},{"type":"web_extractor"}]');
  assert.equal(JSON.stringify(disabled.model.samplingParamsByThinkingLevel.high.tools), '[]');
  assert.equal(disabled.runtime, defaults.runtime);
  assert.notEqual(disabled.model, defaults.model);
  assert.equal(disabled.model.id, selection.modelId);
  const { isModelSelection } = f.load(path.resolve(__dirname, '../../../shared/agent/validation.ts'));
  assert.equal(isModelSelection(selection), true);
  assert.equal(isModelSelection({ ...selection, webSearch: 'false' }), false);
  assert.equal(isModelSelection({ ...selection, webMode: 'browser' }), true);
  assert.equal(isModelSelection({ ...selection, webMode: 'provider' }), true);
  assert.equal(isModelSelection({ ...selection, webMode: 'both' }), false);
});

test('desktop web modes are exclusive in real Responses payloads across switches on the same session', async t => {
  const f = await fixture(t);
  const sdk = await import('@earendil-works/pi-coding-agent');
  const providers = new f.PiProviderManager(f.config, true);
  await providers.saveProvider({ providerId: 'bailian-tp', apiKey: 'fixture-key' });
  const selection = { providerId: 'bailian-tp', modelId: 'qwen3.8-max-preview', thinkingLevel: 'high' };
  const browserBinding = await providers.prepare(selection);
  assert.equal(browserBinding.webMode, 'browser', 'legacy desktop selections default to browser');
  const providerBinding = await providers.prepare({ ...selection, webMode: 'provider' });
  assert.equal(providerBinding.webMode, 'provider');
  assert.equal(JSON.stringify(browserBinding.model.samplingParams.tools), '[]', 'preparing native mode cannot mutate an accepted browser binding');
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const response = { id: `resp_${requests.length}`, model: selection.modelId, status: 'in_progress', output: [] };
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response });
    const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'mode answer', annotations: [] }] };
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'mode answer' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { PiSessionFactory } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/session-factory.ts'));
  const { PiExecution } = f.load(path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/execution.ts'));
  const factory = new PiSessionFactory(f.config, async () => { throw new Error('No browser call expected'); });
  const manager = sdk.SessionManager.create(f.root, path.join(f.root, 'sessions'));
  const descriptor = { sessionId: manager.getSessionId(), engine: 'pi', cwd: f.root, locator: manager.getSessionFile() };
  const disabled = await providers.prepare({ ...selection, webMode: 'provider', webSearch: false, webExtractor: false });
  for (const [index, binding] of [browserBinding, providerBinding, disabled, browserBinding].entries()) {
    const session = await factory.create(manager, descriptor, { ...binding, model: { ...binding.model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } });
    const execution = new PiExecution(session, manager);
    try { await execution.execute({ runId: `mode-${index}`, clientMessageId: `mode-${index}`, content: [{ type: 'text', text: 'Reply briefly' }] }, () => {}); }
    finally { execution.dispose(); }
    const request = requests[index];
    assert.ok(request, 'one real HTTP request per Run');
    const names = request.tools.map(tool => tool.type === 'function' ? tool.name : tool.type);
    assert.ok(names.includes('read'), 'local tools remain available in both modes');
    assert.equal(names.includes('mozi_browser'), binding.webMode === 'browser');
    for (const name of ['mozi_visual_search', 'mozi_visual_read']) assert.equal(names.includes(name), false);
    for (const name of ['web_search', 'web_extractor']) assert.equal(names.includes(name), binding === providerBinding);
  }
  await providers.saveProvider(custom());
  await assert.rejects(providers.prepare({ providerId: 'custom', modelId: 'model', webMode: 'provider' }), e => e.code === 'UNSUPPORTED_CAPABILITY');
  await assert.rejects(f.manager.prepare({ ...selection, webMode: 'browser' }), e => e.code === 'UNSUPPORTED_CAPABILITY');
});

test('Antigravity ignores external Pi credentials and refuses API-key or endpoint bypasses', async t => {
  const f = await fixture(t);
  writeFileSync(path.join(f.config.piDir, 'auth.json'), JSON.stringify({ antigravity: {
    type: 'oauth', access: 'external-only', refresh: 'external-refresh', expires: Date.now() + 3600000,
  } }));
  const provider = (await f.manager.listProviders()).find(p => p.id === 'antigravity');
  assert.equal(provider.configured, false);
  assert.equal(JSON.stringify(provider.authMethods), '["oauth"]');
  await assert.rejects(f.manager.saveProvider({ providerId: 'antigravity', apiKey: 'forbidden' }), e => e.code === 'INVALID_ARGUMENT');
  await f.manager.auth.logout('antigravity');
  assert.equal((await f.manager.listProviders()).find(p => p.id === 'antigravity').configured, false);
  assert.equal(JSON.parse(readFileSync(path.join(f.config.piDir, 'auth.json'), 'utf8')).antigravity.access, 'external-only');
  writeFileSync(path.join(f.config.piDir, 'models.json'), JSON.stringify({ providers: { antigravity: { apiKey: 'bypass' } } }));
  await assert.rejects(new f.PiProviderManager(f.config).listProviders(), e => e.code === 'INVALID_ARGUMENT');
});

test('dynamic Antigravity catalog publishes new Gemini models, preserves cache on failure and restores after restart', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  let requests = 0, fail = false;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/v1internal:fetchAvailableModels'));
    assert.equal(JSON.parse(init.body).project, 'fixture-project');
    requests++;
    if (fail) throw new Error('fixture offline');
    return new Response(JSON.stringify({ models: {
      'gemini-4-fixture': { displayName: 'Gemini 4 Fixture', supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; f.manager.dispose(); });
  writeFileSync(path.join(f.root, 'providers/auth.json'), JSON.stringify({ antigravity: {
    type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, projectId: 'fixture-project',
  } }));
  const notices = [];
  const manager = new f.PiProviderManager(f.config, true, undefined, id => notices.push(id));
  t.after(() => manager.dispose());
  const before = (await manager.listProviders()).find(p => p.id === 'antigravity');
  assert.equal(before.catalogStatus, 'refreshing');
  await manager.refreshProviderModels('antigravity');
  const synced = (await manager.listProviders()).find(p => p.id === 'antigravity');
  assert.ok(requests > 0); assert.equal(synced.catalogStatus, 'ready');
  assert.ok(synced.models.some(m => m.id === 'gemini-4-fixture'));
  assert.ok(notices.length >= 2);
  const count = requests;
  fail = true;
  await manager.refreshProviderModels('antigravity');
  assert.ok(requests > count);
  const offline = (await manager.listProviders()).find(p => p.id === 'antigravity');
  assert.equal(offline.catalogStatus, 'failed');
  assert.ok(offline.models.some(m => m.id === 'gemini-4-fixture'));
  const reopened = new f.PiProviderManager(f.config); t.after(() => reopened.dispose());
  assert.ok((await reopened.listProviders()).find(p => p.id === 'antigravity').models.some(m => m.id === 'gemini-4-fixture'));
  await reopened.refreshProviderModels('antigravity');
});
