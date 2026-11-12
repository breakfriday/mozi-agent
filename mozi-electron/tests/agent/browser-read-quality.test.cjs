const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { hasStableReadBody, isReadPlaceholder } = load(path.resolve(__dirname, '../../src/main/services/browser-read-quality.ts'));
test('equal lengths do not establish stable body content', () => {
  assert.equal(hasStableReadBody('a'.repeat(2000), 'b'.repeat(2000)), false);
  assert.equal(hasStableReadBody('a'.repeat(2000) + '01', 'a'.repeat(2000) + '02'), true);
});
test('recognizes simple loading placeholders without rejecting real articles', () => {
  assert.equal(isReadPlaceholder('正在加载…'), true);
  assert.equal(isReadPlaceholder('Loading...'), true);
  assert.equal(isReadPlaceholder('Loading is an asynchronous operation in this tutorial.'), false);
});
test('read result validates optional quality metadata and bounds warning payloads', () => {
  const { isBrowserResult } = load(path.resolve(__dirname, '../../../shared/browser.ts'));
  const result = { kind: 'read', title: 'Doc', url: 'https://example.com', content: 'Evidence', truncated: false };
  assert.equal(isBrowserResult(result), true);
  assert.equal(isBrowserResult({ ...result, stability: 'best_effort', warnings: ['dynamic_content_snapshot'] }), true);
  assert.equal(isBrowserResult({ ...result, capturedAt: 123 }), true);
  assert.equal(isBrowserResult({ ...result, capturedAt: -1 }), false);
  assert.equal(isBrowserResult({ ...result, stability: 'certain' }), false);
  assert.equal(isBrowserResult({ ...result, warnings: ['x'.repeat(201)] }), false);
  assert.equal(isBrowserResult({ ...result, warnings: Array(21).fill('x') }), false);
});
