const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { BrowserReadSnapshots, sliceReadText } = load(path.resolve(__dirname, '../../src/main/services/browser-read-snapshots.ts'));
const make = (sessionId, text, time = 100) => ({ sessionId, navigation: 1, url: 'https://example.com', fullContent: text, capturedAt: time,
  result: { kind: 'read', url: 'https://example.com', title: 'Doc', content: 'first', truncated: true, stability: 'stable', warnings: [] } });
test('snapshot continuation is session owned, fixed and navigation bound', () => {
  const cache = new BrowserReadSnapshots(() => 100);
  const entry = make('a', 'Original document');
  cache.put(entry);
  entry.fullContent = 'Mutated document!';
  assert.equal(cache.read('a', 1, entry.url, 9).content, 'document');
  assert.throws(() => cache.read('b', 1, entry.url, 9), /快照/);
  cache.put(make('b', 'Other session text'));
  assert.equal(cache.read('a', 1, entry.url, 9).content, 'document');
  assert.throws(() => cache.read('a', 2, entry.url, 9), /快照/);
  assert.throws(() => cache.read('a', 1, entry.url, 9), /快照/);
});
test('expiration, replacement, clear and bounded capacity never silently rebuild', () => {
  let now = 100;
  const cache = new BrowserReadSnapshots(() => now);
  cache.put(make('a', 'old document'));
  cache.put(make('a', 'new document'));
  assert.equal(cache.read('a', 1, 'https://example.com', 4).content, 'document');
  now += 600000;
  assert.throws(() => cache.read('a', 1, 'https://example.com', 4), /快照/);
  for (let i = 0; i < 5; i++) cache.put(make(String(i), 'document', now));
  assert.throws(() => cache.read('0', 1, 'https://example.com', 1), /快照/);
  assert.equal(cache.put(make('big', 'x'.repeat(2000001), now)), false);
  cache.clear();
  assert.throws(() => cache.read('4', 1, 'https://example.com', 1), /快照/);
});
test('UTF-16 slices align end, reject split starts and reassemble without loss', () => {
  const text = 'abc😀def';
  const first = sliceReadText(text, 0, 4);
  assert.equal(first, 'abc');
  assert.equal(first + sliceReadText(text, first.length), text);
  assert.throws(() => sliceReadText(text, 4), /代理对/);
  assert.throws(() => sliceReadText(text, text.length), /偏移/);
});
