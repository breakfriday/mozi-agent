const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const createLoader = require('../helpers/load-ts.cjs');
const promptRoot = path.resolve(__dirname, '../../src/agent/runtime/pi/sessions/prompt');
const { collectToolGuidelines } = createLoader()(path.join(promptRoot, 'tool-guidelines.ts'));

test('custom-tool rules deduplicate exact text without splitting ordered flows', () => {
  const flow = '搜索流程：\n1. inspect\n2. fill\n3. inspect\n4. press';
  const result = collectToolGuidelines([
    { promptGuidelines: ['  共享规则  ', flow, ' ', ''] },
    {},
    { promptGuidelines: ['共享规则', '第二个工具的规则'] },
  ]);
  assert.deepEqual(Array.from(result), ['共享规则', flow, '第二个工具的规则']);
  assert.deepEqual(Array.from(collectToolGuidelines([])), []);
});

test('session factory appends only enabled tool rules to the actual Pi prompt', async t => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { buildSystemPrompt } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-prompt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const captures = [];
  const load = createLoader({
    '@earendil-works/pi-coding-agent': {
      ...sdk,
      createAgentSession: async options => {
        captures.push(options);
        return { session: { agent: {} } };
      },
    },
    '../providers/bailian': { preserveBailianLocalTools() {} },
    '../providers/deepSeek': { preserveDeepSeekLocalTools() {} },
  });
  const { PiSessionFactory } = load(path.resolve(promptRoot, '../session-factory.ts'));
  const factory = new PiSessionFactory(
    { cwd: root, piDir: root, dataDir: root },
    async () => { throw new Error('No browser execution expected'); },
  );
  for (const webMode of ['browser', 'provider']) {
    await factory.create({ getEntries: () => [] }, { cwd: root, sessionId: 'session' },
      { runtime: {}, model: {}, webMode });
    const options = captures.at(-1);
    const loader = options.resourceLoader;
    const prompt = buildSystemPrompt({
      cwd: root,
      customPrompt: loader.getSystemPrompt(),
      appendSystemPrompt: loader.getAppendSystemPrompt().join('\n\n'),
    });
    assert.match(prompt, /你是 Mozi/);
    assert.match(prompt, /外部资料/);
    assert.doesNotMatch(loader.getSystemPrompt(), /站内搜索流程/);
    if (webMode === 'browser') {
      assert.equal(options.customTools.length, 1);
      assert.ok(options.tools.includes(options.customTools[0].name));
      for (const rule of options.customTools[0].promptGuidelines) {
        assert.ok(prompt.includes(rule.trim()));
      }
      assert.equal(prompt.split('站内搜索流程：').length - 1, 1);
      assert.match(prompt, /<addendum>/);
      assert.match(prompt, /INPUT_MISMATCH/);
      assert.doesNotMatch(prompt, /当前使用服务商原生联网模式/);
    } else {
      assert.equal(options.customTools.length, 0);
      assert.ok(!options.tools.includes('mozi_browser'));
      assert.match(prompt, /当前使用服务商原生联网模式/);
      assert.doesNotMatch(prompt, /站内搜索流程|inputVerified|filter=inputs/);
    }
  }
});
