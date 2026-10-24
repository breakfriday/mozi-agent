const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const load = require('../helpers/load-ts.cjs')();
const { checkPageAccess } = load(path.resolve(__dirname, '../../src/main/services/browser-page-access.ts'));

// Exercise the actual serialized function with no module bindings, as in Electron's isolated world.
function check({ text = '', password = [], challenge = [], body = true } = {}) {
  const result = vm.runInNewContext(`(${checkPageAccess.toString()})()`, {
    document: {
      body: body ? { innerText: text } : null,
      querySelectorAll: selector => selector === 'input[type="password"]' ? password : challenge,
    },
    getComputedStyle: element => ({ visibility: element.hidden ? 'hidden' : 'visible' }),
  });
  return JSON.parse(JSON.stringify(result));
}
const visible = { getClientRects: () => [{}] };
const absent = { getClientRects: () => [] };
const hidden = { ...visible, hidden: true };

test('ordinary or empty documents do not suggest a login barrier', () => {
  assert.deepEqual(check({ text: 'An ordinary article' }), { suspectedBlock: null, evidence: [] });
  assert.deepEqual(check({ body: false }), { suspectedBlock: null, evidence: [] });
});

test('login heuristic requires a short document and a visible password field', () => {
  assert.deepEqual(check({ password: [visible] }), { suspectedBlock: 'login', evidence: ['short_page_with_password'] });
  assert.equal(check({ password: [hidden, absent] }).suspectedBlock, null);
  assert.equal(check({ text: 'x'.repeat(2000), password: [visible] }).suspectedBlock, null);
});

test('verification reports evidence without inspecting frame contents or performing actions', () => {
  assert.deepEqual(check({ challenge: [visible] }), { suspectedBlock: 'verification', evidence: ['visible_challenge'] });
  assert.equal(check({ challenge: [hidden, absent] }).suspectedBlock, null);
  assert.deepEqual(check({ text: '请完成验证' }), { suspectedBlock: 'verification', evidence: ['verification_text'] });
  assert.equal(check({ text: 'x'.repeat(6000) + 'verify you are human' }).suspectedBlock, null);
  assert.deepEqual(check({ password: [visible], text: 'Verify that you are human' }), {
    suspectedBlock: 'verification', evidence: ['short_page_with_password', 'verification_text'],
  });
});
