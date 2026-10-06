const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { responseModelFromEvent, observeResponseModels } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/response-model.ts'));

test('extracts only provider response model fields for supported protocols', () => {
  assert.equal(responseModelFromEvent('openai-completions', { model: 'bailian-reported' }), 'bailian-reported');
  assert.equal(responseModelFromEvent('openai-responses', { response: { model: 'server-snapshot' } }), 'server-snapshot');
  assert.equal(responseModelFromEvent('anthropic-messages', { type: 'message_start', message: { model: 'kimi-reported' } }), 'kimi-reported');
  for (const api of ['google-generative-ai', 'google-vertex']) {
    assert.equal(responseModelFromEvent(api, { modelVersion: 'gemini-response-version' }), 'gemini-response-version');
    assert.equal(responseModelFromEvent(api, { model: 'request-name' }), undefined);
  }
  for (const value of [undefined, null, '', ' ', 12, {}, 'a'.repeat(257)]) assert.equal(responseModelFromEvent('openai-completions', { model: value }), undefined);
  assert.equal(responseModelFromEvent('unknown', { model: 'do-not-guess' }), undefined);
  assert.equal(responseModelFromEvent('openai-completions', { choices: [{ delta: { content: 'I am model X' } }] }), undefined);
});

test('each retry has its own evidence and normalized SDK model fields are never a fallback', async () => {
  let attempt = 0, callbacks = 0;
  const agent = { streamFunction: async (model, context, options) => {
    const current = attempt++;
    if (current === 0) await options.onProviderStreamEvent({ model: 'failed-attempt-model' }, model);
    const message = { model: 'configured-model', responseModel: 'normalized-field-must-not-be-trusted' };
    return { result: async () => message };
  } };
  const original = agent.streamFunction;
  const observer = observeResponseModels(agent);
  for (const expected of ['failed-attempt-model', undefined]) {
    const stream = await agent.streamFunction({ api: 'openai-completions', id: 'configured-model' }, {}, { onProviderStreamEvent: async () => { callbacks++; } });
    const message = await stream.result();
    assert.equal(observer.get(message), expected);
  }
  assert.equal(callbacks, 1);
  observer.dispose(); assert.equal(agent.streamFunction, original);
});
