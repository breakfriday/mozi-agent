const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { responseModelFromEvent, ResponseModelCollector } = load(path.resolve(__dirname, '../../src/agent/infrastructure/pi/model-call/response-model-collector.ts'));

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

test('model evidence stays unknown after a conflict even when the first name appears again', () => {
  const collector = new ResponseModelCollector();
  collector.collect('openai-responses', { response: { model: 'first' } });
  assert.equal(collector.result(), 'first');
  collector.collect('openai-responses', { response: { model: 'second' } });
  collector.collect('openai-responses', { response: { model: 'first' } });
  assert.equal(collector.result(), undefined);
});
