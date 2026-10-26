// Real Electron navigation and isolated DOM extraction against deterministic pages.
// Run with: electron tests/browser.smoke.cjs (a display or xvfb is required).
// --background-only tests hidden windows; --visible/--minimized select other states.
// Visible background tests require programmatic blur (use --ozone-platform=x11 on Wayland).
const { app, BrowserWindow, Menu, session, utilityProcess } = require('electron');
const { buildSync } = require('esbuild');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const directory = mkdtempSync(path.join(os.tmpdir(), 'mozi-browser-smoke-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const output = path.resolve(__dirname, '../.vite/browser-smoke/browser.cjs');
mkdirSync(path.dirname(output), { recursive: true });
buildSync({ stdin: { contents: `export { MoziBrowser } from './src/main/services/browser.service';
  export { AgentTransport } from './src/main/agent/transport';
  export { utilityProcessConnection } from './src/main/agent/utility-process-connection';`, resolveDir: path.resolve(__dirname, '..') }, outfile: output,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
const { MoziBrowser, AgentTransport, utilityProcessConnection } = require(output);
let browser;
const read = (url, context) => browser.execute({ action: 'read', url }, context);
const readCurrent = context => browser.execute({ action: 'read', target: 'current' }, context);
const search = (query, context) => browser.execute({ action: 'search', query }, context);
const inspect = (query, context = contexts()) => browser.execute({ action: 'inspect', ...(query ? { query } : {}) }, context);
const click = (elementId, context = contexts()) => browser.execute({ action: 'click', elementId }, context);
const fill = (elementId, text, context = contexts()) => browser.execute({ action: 'fill', elementId, text }, context);
const press = (elementId, key, context = contexts()) => browser.execute({ action: 'press', elementId, key }, context);
let child;
let browserMenu;
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => (browserMenu = buildMenu(template));
let seq = 0;
const pageRequests = [];
const contexts = (progress = []) => ({ requestId: `request-${++seq}`, sessionId: 'test-session', runId: 'test-run', toolCallId: `tool-${seq}`,
  signal: new AbortController().signal, onProgress: value => progress.push(value) });
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for browser state'); await new Promise(r => setTimeout(r, 20)); }
}
const current = () => BrowserWindow.getAllWindows()[0];
async function clickLink(id) {
  // Exercise link navigation independently of OS focus. Trusted pointer events
  // are verified through the actual service in interactionWorkflow below.
  await current().webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`, true);
}

const html = body => new Response(`<!doctype html><html><head><title>Mozi browser test</title></head><body>${body}</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
async function agentWorkflow() {
  let rounds = 0;
  const model = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    rounds++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let operation = rounds === 1 ? { action: 'search', query: 'Mozi evidence' }
      : rounds === 2 ? { action: 'read', url: 'https://example.test/article' }
      : rounds === 4 || rounds === 8 || rounds === 14 ? { action: 'read', target: 'current' }
      : rounds === 6 ? { action: 'inspect', query: '展开详情' }
      : rounds === 10 || rounds === 12 ? { action: 'inspect', filter: 'inputs' } : undefined;
    if (rounds === 7) {
      const evidence = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(evidence.kind, 'inspect');
      operation = { action: 'click', elementId: evidence.elements.find(element => element.name === '展开详情').elementId };
    }
    if (rounds === 11 || rounds === 13) {
      const evidence = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(evidence.kind, 'inspect');
      const elementId = evidence.elements.find(element => element.name === '商品关键词').elementId;
      operation = rounds === 11 ? { action: 'fill', elementId, text: 'agent station search' } : { action: 'press', elementId, key: 'Enter', expect: { elementId, text: 'agent station search' } };
    }
    if (rounds === 12 || rounds === 14) assert.equal(JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content).inputVerified, true);
    if (rounds === 15) assert.match(JSON.stringify(request.messages), /Station search result: agent station search/);
    const delta = operation ? { role: 'assistant', tool_calls: [{ index: 0, id: `browser-${rounds}`, type: 'function', function: {
      name: 'mozi_browser', arguments: JSON.stringify(operation),
    } }] } : { role: 'assistant', content: 'Summary from visible browser evidence.' };
    if (rounds === 3) assert.match(JSON.stringify(request.messages), /Rendered evidence/);
    if (rounds === 5) {
      assert.match(JSON.stringify(request.messages), /User expanded current evidence 918/);
      assert.match(JSON.stringify(request.messages), /https:\/\/example.test\/blank/);
    }
    if (rounds === 9) assert.match(JSON.stringify(request.messages), /Trusted dynamic expanded evidence/);
    assert.equal(request.tools.filter(tool => tool.function.name === 'mozi_browser').length, 1);
    assert.ok(request.tools.every(tool => !tool.function.name.startsWith('mozi_visual_')));
    for (const [content, finish] of [[delta, null], [{}, operation ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: `response-${rounds}`, object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const piDir = path.join(directory, 'agent/providers'); mkdirSync(piDir, { recursive: true });
  writeFileSync(path.join(piDir, 'auth.json'), JSON.stringify({ 'browser-fixture': { type: 'api_key', key: 'fixture-only' } }));
  writeFileSync(path.join(piDir, 'models.json'), JSON.stringify({ providers: { 'browser-fixture': { api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, models: [{ id: 'smoke', name: 'Smoke',
      vision: false, reasoning: false, contextWindow: 32000, maxTokens: 1024 }] } } }));
  const transport = new AgentTransport(undefined, (operation, ctx) => browser.execute(operation, ctx));
  const events = [];
  transport.onEvent(event => events.push(event));
  child = utilityProcess.fork(path.resolve(__dirname, '../.vite/build/agent.mjs'), [], { stdio: 'pipe', env: { ...process.env,
    MOZI_AGENT_DATA_DIR: path.join(directory, 'agent'), MOZI_AGENT_PI_DIR: piDir, MOZI_AGENT_PROVIDER: 'browser-fixture', MOZI_AGENT_MODEL: 'smoke',
  } });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.stdout.on('data', () => {});
  transport.connect(utilityProcessConnection(child));
  const call = async (method, params) => {
    const response = await transport.request({ protocolVersion: 1, kind: 'request', requestId: `rpc-${++seq}`, method, params });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  try {
    await until(() => transport.getState().state === 'ready');
    const { sessionId } = await call('session.create', { clientOperationId: 'browser-smoke' });
    const { runId } = await call('run.start', { sessionId, clientMessageId: 'browser-message', content: [{ type: 'text', text: 'Search and read the source.' }] });
    await until(() => events.some(event => event.type === 'run.finished' && event.runId === runId));
    assert.equal(events.find(event => event.type === 'run.finished').data.status, 'completed', JSON.stringify(events));
    assert.equal(rounds, 3);
    const snapshot = await call('session.snapshot', { sessionId });
    assert.ok(snapshot.tools.some(tool => tool.toolName === 'mozi_browser' && tool.status === 'succeeded' && tool.outputText.includes('Rendered evidence')));
    await current().webContents.loadURL('https://example.test/links');
    await clickLink('blank');
    await until(() => current().webContents.getURL() === 'https://example.test/blank' && !current().webContents.isLoading());
    await until(async () => (await current().webContents.executeJavaScript('document.body.innerText')).includes('Rendered evidence'));
    await current().webContents.executeJavaScript("document.title='User current title'; document.querySelector('article').innerHTML='<p>User expanded current evidence 918</p>'");
    const before = pageRequests.length;
    const second = await call('run.start', { sessionId, clientMessageId: 'current-message', content: [{ type: 'text', text: '分析 MoziBrowser 当前页面，不要重新打开历史网址。' }] });
    await until(() => events.some(event => event.type === 'run.finished' && event.runId === second.runId));
    assert.equal(events.find(event => event.type === 'run.finished' && event.runId === second.runId).data.status, 'completed');
    assert.equal(rounds, 5);
    assert.equal(pageRequests.length, before, 'current reading never issues a navigation request');
    const latest = await call('session.snapshot', { sessionId });
    const currentTool = latest.tools.find(tool => tool.runId === second.runId && tool.toolName === 'mozi_browser');
    assert.equal(currentTool.status, 'succeeded');
    const evidence = JSON.parse(currentTool.outputText);
    assert.equal(evidence.url, 'https://example.test/blank');
    assert.equal(evidence.title, 'User current title');
    assert.match(evidence.content, /User expanded current evidence 918/);
    await current().webContents.loadURL('https://example.test/interactive');
    const third = await call('run.start', { sessionId, clientMessageId: 'click-message', content: [{ type: 'text', text: '点击当前页面的展开详情，再总结展开的内容。' }] });
    await until(() => events.some(event => event.type === 'run.finished' && event.runId === third.runId));
    assert.equal(events.find(event => event.type === 'run.finished' && event.runId === third.runId).data.status, 'completed');
    assert.equal(rounds, 9);
    const afterClick = await call('session.snapshot', { sessionId });
    assert.ok(afterClick.tools.some(tool => tool.runId === third.runId && tool.status === 'succeeded' && JSON.parse(tool.inputText).action === 'click'));
    await current().webContents.loadURL('https://example.test/site-search');
    const fourth = await call('run.start', { sessionId, clientMessageId: 'input-message', content: [{ type: 'text', text: '在当前网站搜索 agent station search，阅读搜索结果。' }] });
    await until(() => events.some(event => event.type === 'run.finished' && event.runId === fourth.runId));
    assert.equal(events.find(event => event.type === 'run.finished' && event.runId === fourth.runId).data.status, 'completed');
    assert.equal(rounds, 15);
    const afterInput = await call('session.snapshot', { sessionId });
    for (const action of ['fill', 'press']) assert.ok(afterInput.tools.some(tool => tool.runId === fourth.runId && tool.status === 'succeeded' && JSON.parse(tool.inputText).action === action));
    assert.equal(await current().webContents.executeJavaScript('window.submits'), 1);
    console.log('PASS: real Pi model uses observed input -> fill -> fresh inspect -> press Enter -> current read; input/press results persisted.');
    console.log('PASS: real utilityProcess + Pi + unified browser tool + search/read/current across Runs; live URL/DOM returned without reload and persisted.');
    console.log('PASS: model inspect -> observed element ID -> trusted click -> current read, through real Pi and reverse IPC.');
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.postMessage({ protocolVersion: 1, kind: 'control', action: 'shutdown' });
    await exited;
    child = undefined;
    transport.dispose();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
}
async function interactionWorkflow() {
  await read('https://example.test/interactive', contexts());
  const initial = await inspect();
  assert.ok(initial.elements.some(e => e.name === '禁用按钮' && e.disabled));
  assert.ok(initial.elements.every(e => e.name !== '隐藏按钮' && e.name !== '菜单详情'));
  const element = async name => {
    const result = await inspect(name);
    assert.equal(result.elements.length, 1, `unique element ${name}`);
    return result.elements[0].elementId;
  };
  const expanded = await element('展开详情');
  await assert.rejects(click(expanded, { ...contexts(), sessionId: 'other-session' }), e => e.code === 'STALE_ELEMENT');
  assert.equal((await click(expanded)).dispatched, true);
  assert.match((await readCurrent(contexts())).content, /Trusted dynamic expanded evidence/);
  await assert.rejects(click(expanded), e => e.code === 'STALE_ELEMENT');
  assert.equal(await current().webContents.executeJavaScript('document.body.dataset.clickCount'), '1');

  await click(await element('更多菜单'));
  await click(await element('菜单详情'));
  assert.match((await readCurrent(contexts())).url, /#details$/);
  assert.match((await readCurrent(contexts())).content, /SPA menu evidence/);
  await assert.rejects(click(await element('禁用按钮')), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  const replaced = await element('可替换按钮');
  await current().webContents.executeJavaScript("const target=document.getElementById('replace'); target.replaceWith(target.cloneNode(true));");
  await assert.rejects(click(replaced), e => e.code === 'STALE_ELEMENT');
  assert.equal(await current().webContents.executeJavaScript('document.body.dataset.replacedClicked'), undefined);
  const renamed = await element('可替换按钮');
  await current().webContents.executeJavaScript("document.getElementById('replace').textContent='另一个操作'");
  await assert.rejects(click(renamed), e => e.code === 'STALE_ELEMENT');
  const covered = await element('遮挡按钮');
  await current().webContents.executeJavaScript("const overlay=document.createElement('div'); overlay.id='overlay'; overlay.style='position:fixed;inset:0;z-index:99999;background:white'; document.body.append(overlay);");
  await assert.rejects(click(covered), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  assert.equal(await current().webContents.executeJavaScript('document.body.dataset.coveredClicked'), undefined);
  await current().webContents.executeJavaScript("document.getElementById('overlay').remove()");
  const abortedElement = await element('展开详情');
  const controller = new AbortController();
  await assert.rejects(click(abortedElement, { ...contexts(), signal: controller.signal, onProgress: progress => {
    if (progress.stage === 'interacting') controller.abort();
  } }), e => e.code === 'CANCELLED');
  assert.equal(await current().webContents.executeJavaScript('document.body.dataset.clickCount'), '1');
  await click(await element('底部按钮'));
  assert.match((await readCurrent(contexts())).content, /Offscreen click evidence/);

  const previousInspection = await element('动态跳转');
  await inspect('新窗口跳转');
  await assert.rejects(click(previousInspection), e => e.code === 'STALE_ELEMENT');
  const dynamic = await click(await element('动态跳转'));
  assert.equal(dynamic.url, 'https://example.test/dynamic-destination');
  await read('https://example.test/interactive', contexts());
  const popup = await click(await element('新窗口跳转'));
  assert.equal(popup.url, 'https://example.test/popup-destination');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await read('https://example.test/interactive', contexts());
  const beforeNavigation = await element('动态跳转');
  await current().webContents.executeJavaScript("history.pushState({}, '', '#new-page')");
  await assert.rejects(click(beforeNavigation), e => e.code === 'STALE_ELEMENT');
  await read('https://example.test/many-elements', contexts());
  const many = await inspect();
  assert.equal(many.elements.length, 100); assert.equal(many.truncated, true);
  assert.equal((await inspect('Control 104')).elements.length, 1);
  console.log('PASS: trusted dynamic/SPA/popup clicks, menus, scrolling, stale IDs, session scope, disabled/covered elements, cancellation and bounded inspection.');
}

async function inputWorkflow() {
  await read('https://example.test/site-search', contexts());
  const js = code => current().webContents.executeJavaScript(code);
  const element = async name => {
    const result = await inspect(name);
    assert.equal(result.elements.length, 1, `unique input ${name}`);
    return result.elements[0];
  };
  const snapshot = await inspect();
  assert.ok(!JSON.stringify(snapshot).includes('private-existing'));
  assert.ok(snapshot.elements.every(e => e.name !== 'Hidden input'));
  const searchbox = await element('商品关键词');
  assert.equal(searchbox.role, 'searchbox'); assert.equal(searchbox.editable, true);
  assert.equal(searchbox.placeholder, '查找商品');
  assert.equal((await element('查找商品')).name, '商品关键词');
  const query = '耳机 " & <script> ` ${literal}';
  const first = await element('商品关键词');
  assert.equal((await fill(first.elementId, query)).kind, 'fill');
  assert.equal(await js('document.getElementById("query").value'), query);
  assert.equal(await js('window.inputState'), query);
  assert.deepEqual(await js('window.inputEvents'), ['beforeinput:true', 'input:true']);
  assert.equal(await js('window.submits'), 0);
  await assert.rejects(press(first.elementId, 'Enter'), e => e.code === 'STALE_ELEMENT');
  await press((await element('商品关键词')).elementId, 'ArrowDown');
  assert.equal(await js('document.getElementById("query").dataset.suggestion'), 'selected');
  await press((await element('商品关键词')).elementId, 'Escape');
  assert.equal(await js('document.getElementById("query").dataset.suggestion'), 'closed');
  await fill((await element('商品关键词')).elementId, 'replacement');
  assert.equal(await js('window.inputState'), 'replacement');
  await fill((await element('商品关键词')).elementId, '');
  assert.equal(await js('window.inputState'), '');
  await fill((await element('商品关键词')).elementId, query);
  await press((await element('商品关键词')).elementId, 'Enter');
  assert.equal(await js('window.submits'), 1, 'Enter submits exactly once');
  assert.match((await readCurrent(contexts())).content, /Station search result/);
  assert.equal(await js('window.submittedQuery'), query);
  assert.ok((await js('window.inputEvents')).includes('change:true'));

  await fill((await element('商品关键词')).elementId, 'button search');
  await click((await element('站内搜索按钮')).elementId);
  assert.equal(await js('window.submits'), 2);
  assert.equal(await js('window.submittedQuery'), 'button search');
  for (const [name, id, value] of [['多行备注', 'notes', '第一行\n第二行'], ['富文本备注', 'rich', '富文本\n第二行'], ['邮箱地址', 'email', 'mozi@example.test']]) {
    await fill((await element(name)).elementId, value);
    assert.equal(await js(`document.getElementById(${JSON.stringify(id)}).${id === 'rich' ? 'innerText' : 'value'}`), value);
  }
  for (const name of ['只读输入', '禁用输入', '上传文件', '数字输入']) {
    assert.equal((await element(name)).editable, false);
    await assert.rejects(fill((await element(name)).elementId, 'bad'), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  }
  await assert.rejects(fill((await element('商品关键词')).elementId, 'line1\nline2'), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  await assert.rejects(fill((await element('长度限制')).elementId, 'too long'), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  const old = await element('可替换输入');
  await js('document.getElementById("replaceInput").replaceWith(document.getElementById("replaceInput").cloneNode(true))');
  await assert.rejects(fill(old.elementId, 'bad'), e => e.code === 'STALE_ELEMENT');
  await assert.rejects(fill((await element('焦点替换输入')).elementId, 'bad'), e => e.code === 'STALE_ELEMENT');
  await assert.rejects(fill((await element('延迟替换输入')).elementId, 'bad'), e => e.code === 'STALE_ELEMENT');
  await assert.rejects(fill((await element('丢弃输入')).elementId, 'bad'), e => e.code === 'ELEMENT_NOT_INTERACTABLE');
  const aborted = await element('商品关键词');
  const controller = new AbortController();
  await assert.rejects(fill(aborted.elementId, 'cancelled', { ...contexts(), signal: controller.signal,
    onProgress: p => { if (p.stage === 'interacting') controller.abort(); } }), e => e.code === 'CANCELLED');
  assert.equal(await js('document.getElementById("query").value'), 'button search');
  await press((await element('商品关键词')).elementId, 'Tab');
  assert.equal(await js('document.activeElement.tagName'), 'BUTTON');
  await fill((await element('导航搜索')).elementId, '真实导航');
  const result = await press((await element('导航搜索')).elementId, 'Enter');
  assert.equal(new URL(result.url).searchParams.get('q'), '真实导航');
  assert.equal(new URL(result.url).pathname, '/site-results');
  assert.equal(pageRequests.filter(url => url.includes('/site-results?')).length, 1);
  console.log('PASS: trusted replacement/clear input, labels/placeholders, native Enter and button submission, suggestions, Tab, Unicode/multiline, stale/readonly/disabled/cancel guards and navigation.');
}

async function backgroundWorkflow(mode = "hidden") {
  const win = current();
  win.hide();
  if (mode === "visible") { win.showInactive(); await new Promise(resolve => setTimeout(resolve, 500)); win.blur(); }
  if (mode === "minimized") { win.showInactive(); await new Promise(resolve => setTimeout(resolve, 500)); win.minimize(); await until(() => win.isMinimized()); }
  await until(async () => !win.isFocused() && !await win.webContents.executeJavaScript('document.hasFocus()'));
  const assertBackground = async () => {
    if (mode === 'hidden') assert.equal(win.isVisible(), false, 'automation must not show a hidden window');
    if (mode === 'minimized') assert.equal(win.isMinimized(), true, 'automation must not restore the window');
    assert.equal(win.webContents.debugger.isAttached(), false, 'debugger must be released after each operation');
    assert.equal(win.isFocused(), false, 'automation must not activate the browser');
    assert.equal(win.webContents.isFocused(), false, 'automation must not focus the native web contents');
    // CDP input can focus the renderer without activating the OS window.
    // backgroundThrottling=false also keeps page visibility active by design.
  };
  await assertBackground();
  const restore = [];
  const emulation = [];
  const sendCommand = win.webContents.debugger.sendCommand;
  win.webContents.debugger.sendCommand = async function (method, params, ...args) {
    const result = await sendCommand.call(this, method, params, ...args);
    if (method === 'Emulation.setFocusEmulationEnabled') emulation.push(params.enabled);
    return result;
  };
  restore.push(() => { win.webContents.debugger.sendCommand = sendCommand; });
  for (const [owner, method] of [[win, 'show'], [win, 'showInactive'], [win, 'focus'], [win.webContents, 'focus']]) {
    const original = owner[method];
    owner[method] = () => { assert.fail(`background automation called ${method}`); };
    restore.push(() => { owner[method] = original; });
  }
  try {
    await read('https://example.test/interactive', contexts());
    const expanded = (await inspect('展开详情')).elements[0].elementId;
    await click(expanded);
    assert.match((await readCurrent(contexts())).content, /Trusted dynamic expanded evidence/);
    assert.deepEqual(emulation.splice(0), [true, false], 'successful interaction explicitly disables emulation');
    await assert.rejects(click(expanded), e => e.code === 'STALE_ELEMENT');
    assert.deepEqual(emulation.splice(0), [true, false], 'failed interaction explicitly disables emulation');
    await assertBackground();
    await read('https://example.test/site-search', contexts());
    for (let round = 0; round < 3; round++) {
      const text = `后台采集 ${round}`;
      const input = (await inspect('商品关键词')).elements[0].elementId;
      assert.equal((await fill(input, text)).inputVerified, true);
      await assertBackground();
      let fresh = (await inspect('商品关键词')).elements[0].elementId;
      await assert.rejects(browser.execute({ action: 'press', elementId: fresh, key: 'Enter',
        expect: { elementId: fresh, text: 'wrong value' } }, contexts()), e => e.code === 'INPUT_MISMATCH');
      fresh = (await inspect('商品关键词')).elements[0].elementId;
      await browser.execute({ action: 'press', elementId: fresh, key: 'Enter',
        expect: { elementId: fresh, text } }, contexts());
      assert.ok((await readCurrent(contexts())).content.includes(`Station search result: ${text}`));
      await assertBackground();
    }
    // An existing debugger belongs to its owner and must not be stolen.
    let guarded = (await inspect('商品关键词')).elements[0].elementId;
    win.webContents.debugger.attach('1.3');
    try {
      await assert.rejects(fill(guarded, 'occupied'), e => e.code === 'UNAVAILABLE');
      assert.equal(win.webContents.debugger.isAttached(), true);
    } finally { win.webContents.debugger.detach(); }
    await assertBackground();
    emulation.length = 0;
    const controller = new AbortController();
    guarded = (await inspect('商品关键词')).elements[0].elementId;
    await assert.rejects(fill(guarded, 'cancelled', { ...contexts(), signal: controller.signal,
      onProgress: p => { if (p.stage === 'interacting') controller.abort(); } }), e => e.code === 'CANCELLED');
    assert.deepEqual(emulation.splice(0), [true, false], 'cancellation explicitly disables emulation');
    await assertBackground();
    guarded = (await inspect('商品关键词')).elements[0].elementId;
    await assert.rejects(fill(guarded, 'detached', { ...contexts(), onProgress: p => {
      if (p.stage === 'interacting') win.webContents.debugger.detach();
    } }), e => e.code === 'UNAVAILABLE');
    await assertBackground();
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("query").value'), '后台采集 2');
    // A fresh operation must recover after each of those failures.
    const input = (await inspect('商品关键词')).elements[0].elementId;
    await fill(input, '');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("query").value'), '');
    assert.equal((await search('empty', contexts())).results.length, 0);
    await assertBackground();
    win.hide();
    await readCurrent(contexts());
    assert.equal(win.isVisible(), false, 'reading must not reshow a hidden browser');
    console.log(`PASS: ${mode} CDP click/fill/press and repeated search submissions without activation; debugger and focus emulation cleaned up.`);
  } finally {
    for (const reset of restore) reset();
  }
}

async function guardedSearchWorkflow() {
  await read('https://example.test/hot-search', contexts());
  const js = code => current().webContents.executeJavaScript(code);
  const execute = operation => browser.execute(operation, contexts());
  const observed = async () => {
    const snapshot = await inspect();
    return { input: snapshot.elements.find(e => e.inputType === 'text'), button: snapshot.elements.find(e => e.role === 'button') };
  };
  const buttonOnly = await inspect('搜索');
  assert.equal(buttonOnly.elements.length, 1, 'name filtering misses the hot-word placeholder input');
  assert.equal(buttonOnly.elements[0].role, 'button');
  const inputs = await execute({ action: 'inspect', filter: 'inputs' });
  assert.equal(inputs.elements.length, 1);
  assert.equal(inputs.elements[0].placeholder, '日本误报9.9级地震');
  assert.equal(inputs.elements[0].hasValue, false);
  const query = '龙餐馆';
  let ids = await observed();
  await assert.rejects(execute({ action: 'press', elementId: ids.input.elementId, key: 'Enter', expect: { elementId: ids.input.elementId, text: query } }), e => e.code === 'INPUT_MISMATCH');
  ids = await observed();
  await assert.rejects(execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: ids.input.elementId, text: query } }), e => e.code === 'INPUT_MISMATCH');
  assert.equal(await js('window.submits'), 0);
  assert.equal(current().webContents.getURL(), 'https://example.test/hot-search');
  ids = await observed();
  const filled = await fill(ids.input.elementId, query);
  assert.equal(filled.inputVerified, true);
  const staleInput = ids.input.elementId;
  ids = await observed();
  assert.equal(ids.input.hasValue, true);
  await assert.rejects(execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: staleInput, text: query } }), e => e.code === 'STALE_ELEMENT');
  ids = await observed();
  await js('document.querySelector("input").value=""');
  await assert.rejects(execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: ids.input.elementId, text: query } }), e => e.code === 'INPUT_MISMATCH');
  ids = await observed();
  await fill(ids.input.elementId, query);
  await js('document.querySelector("input").addEventListener("focus", e => { e.target.value=""; }, {once:true}); document.querySelector("input").blur()');
  ids = await observed();
  await assert.rejects(execute({ action: 'press', elementId: ids.input.elementId, key: 'Enter', expect: { elementId: ids.input.elementId, text: query } }), e => e.code === 'INPUT_MISMATCH');
  assert.equal(await js('window.submits'), 0, 'focus resetting input cannot submit');
  ids = await observed();
  await fill(ids.input.elementId, query);
  await js('document.querySelector("button").addEventListener("mouseenter", () => { document.querySelector("input").value=""; }, {once:true})');
  ids = await observed();
  await assert.rejects(execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: ids.input.elementId, text: query } }), e => e.code === 'INPUT_MISMATCH');
  assert.equal(await js('window.submits'), 0, 'hover resetting input cannot submit');
  ids = await observed();
  await fill(ids.input.elementId, query);
  ids = await observed();
  const controller = new AbortController();
  await assert.rejects(browser.execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: ids.input.elementId, text: query } }, {
    ...contexts(), signal: controller.signal, onProgress: p => { if (p.stage === 'interacting') controller.abort(); },
  }), e => e.code === 'CANCELLED');
  assert.equal(await js('window.submits'), 0);
  ids = await observed();
  const submitted = await execute({ action: 'click', elementId: ids.button.elementId, expect: { elementId: ids.input.elementId, text: query } });
  assert.equal(submitted.inputVerified, true);
  assert.equal(new URL(submitted.url).hostname, 'search.example.test');
  assert.equal(new URL(submitted.url).searchParams.get('keyword'), query);
  assert.match((await readCurrent(contexts())).content, /龙餐馆/);
  assert.equal(pageRequests.filter(url => url.includes('/hot-results?')).length, 1, 'only the correctly filled search navigates');
  console.log('PASS: hot-word placeholder is not input; typed-input discovery, empty/reset/stale/cancel guards, focus/hover rechecks and correctly guarded cross-host search submission.');
}

app.whenReady().then(async () => {
  const browserSession = session.fromPartition('persist:mozi-browser');
  await browserSession.protocol.handle('https', request => {
    pageRequests.push(request.url);
    const url = new URL(request.url);
    if (url.pathname === '/slow') return new Promise(() => {});
    if (url.pathname === '/fail') return Response.error();
    if (url.pathname === '/forbidden') return new Response('<h1>Forbidden</h1>', { status: 403, headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === '/challenge') return html('<h1>Verify you are human</h1>');
    if (url.pathname === '/hot-search') return html(`<article>Station search with a default hot word.</article>
      <form><input type="text" placeholder="日本误报9.9级地震"><button>搜索</button></form>
      <script>window.submits=0;document.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();window.submits++;
        const field=document.querySelector('input');
        location.href='https://search.example.test/hot-results?keyword='+encodeURIComponent(field.value||field.placeholder);
      });</script>`);
    if (url.pathname === '/hot-results') return html('<article>站内搜索结果：龙餐馆</article>');
    if (url.pathname === '/site-search') return html(`<article id="evidence">Station search test page.</article>
      <form id="station"><label for="query">商品关键词</label><input id="query" name="q" type="search" placeholder="查找商品" value="private-existing-query"><button>站内搜索按钮</button></form>
      <label for="notes">多行备注</label><textarea id="notes">private-existing-notes</textarea>
      <div id="rich" role="textbox" aria-label="富文本备注" contenteditable="true">private-existing-rich</div>
      <input type="email" id="email" aria-label="邮箱地址" value="previous@example.test">
      <input aria-label="只读输入" readonly value="private-existing-readonly">
      <input aria-label="禁用输入" disabled><input aria-label="上传文件" type="file"><input aria-label="数字输入" type="number">
      <input aria-label="长度限制" maxlength="3"><input type="hidden" aria-label="Hidden input">
      <input id="replaceInput" aria-label="可替换输入">
      <input aria-label="焦点替换输入" onfocus="this.replaceWith(this.cloneNode(true))">
      <input aria-label="延迟替换输入" onfocus="setTimeout(() => this.replaceWith(this.cloneNode(true)), 0)">
      <input aria-label="丢弃输入" oninput="this.value=''">
      <form action="/site-results"><input aria-label="导航搜索" name="q"><button>导航提交</button></form>
      <script>
        window.inputEvents=[]; window.inputState=''; window.submits=0;
        const query=document.getElementById('query');
        for(const type of ['beforeinput','input','change']) query.addEventListener(type,event=>{
          window.inputEvents.push(type+':'+event.isTrusted);
          if(type==='input') { window.inputState=event.target.value; event.target.value=window.inputState; }
        });
        query.addEventListener('focus',()=>query.setAttribute('aria-expanded','true'));
        query.addEventListener('keydown',event=>{
          if(event.key==='ArrowDown') query.dataset.suggestion=event.isTrusted?'selected':'untrusted';
          if(event.key==='Escape') query.dataset.suggestion='closed';
        });
        document.getElementById('station').addEventListener('submit',event=>{
          event.preventDefault(); window.submits++; window.submittedQuery=window.inputState;
          document.getElementById('evidence').textContent='Station search result: '+window.inputState;
          history.pushState({},'', '#results');
        });
      </script>`);
    if (url.pathname === '/interactive') return html(`<article id="evidence">Initial interactive page evidence.</article>
      <button id="expand">展开详情</button>
      <button id="menu" onclick="document.getElementById('menuItems').hidden=false">更多菜单</button>
      <div id="menuItems" hidden><button id="spa" onclick="history.pushState({}, '', '#details'); document.getElementById('evidence').textContent='SPA menu evidence'">菜单详情</button></div>
      <button id="dynamic" onclick="location.href='/dynamic-destination'">动态跳转</button>
      <button id="popup" onclick="window.open('/popup-destination')">新窗口跳转</button>
      <button id="disabled" disabled>禁用按钮</button>
      <button hidden>隐藏按钮</button>
      <button id="replace" onclick="document.body.dataset.replacedClicked='yes'">可替换按钮</button>
      <button id="covered" onclick="document.body.dataset.coveredClicked='yes'">遮挡按钮</button>
      <div style="height:2000px"></div><button id="offscreen" onclick="document.getElementById('evidence').textContent='Offscreen click evidence'">底部按钮</button>
      <script>document.getElementById('expand').addEventListener('click', event => {
        document.body.dataset.clickCount=String(Number(document.body.dataset.clickCount || 0)+1);
        setTimeout(() => document.getElementById('evidence').textContent=event.isTrusted ? 'Trusted dynamic expanded evidence' : 'Untrusted click', 100);
      });</script>`);
    if (url.pathname === '/many-elements') return html(`<h1>Many controls</h1>${Array.from({ length: 105 }, (_, i) => `<button>Control ${i}</button>`).join('')}`);
    if (url.pathname === '/links') return html(`<main><h1>Link navigation</h1>
      <a id="same" href="https://example.test/same">Same window</a>
      <a id="blank" href="https://example.test/blank" target="_blank">New window</a>
      <a id="named" href="https://example.test/named" target="source">Named window</a>
      <button id="script" onclick="window.open('https://example.test/script')">Script window</button>
      <a id="blocked" href="file:///etc/passwd" target="_blank">Unsupported URL</a>
      </main>`);
    if (url.pathname === '/search') {
      if (url.searchParams.get('q') === 'empty') return html('<ol id="b_results"><li class="b_no">There are no results for this query.</li></ol>');
      const target = 'https://example.test/article';
      const encoded = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(target).toString('base64url');
      return html(`<ol id="b_results"><li class="b_algo"><h2><a href="${encoded}">Source article</a></h2><div class="b_caption"><p>Source summary</p></div></li>
        <li class="b_algo" hidden><h2><a href="https://hidden.test/">Hidden result</a></h2></li>
        <li class="b_algo"><h2><a href="${target}">Duplicate</a></h2></li></ol>`);
    }
    if (url.pathname === '/long') return html(`<article>${'<p>Long evidence paragraph. </p>'.repeat(2500)}</article>`);
    return html(`<nav>Navigation clutter</nav><article><h1>Article</h1><p>Loading evidence…</p><p hidden>Hidden secret</p></article>
      <script>setTimeout(() => document.querySelector('article p').textContent = 'Rendered evidence: visual reading works after JavaScript rendering.', 450);</script>`);
  });
  browser = new MoziBrowser();
  if (process.argv.includes('--background-only')) {
    await read('https://example.test/article', contexts());
    await backgroundWorkflow(process.argv.includes("--minimized") ? "minimized" : process.argv.includes("--visible") ? "visible" : "hidden"); browser.dispose(); app.exit(0); return;
  }
  if (process.argv.includes('--guard-only') || process.argv.includes('--input-only')) {
    await read('https://example.test/site-search', contexts());
    current().show(); current().focus(); current().webContents.focus();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (process.argv.includes('--guard-only')) { await guardedSearchWorkflow(); browser.dispose(); app.exit(0); return; }
  if (process.argv.includes('--input-only')) {
    await inputWorkflow(); await guardedSearchWorkflow(); browser.dispose(); app.exit(0); return;
  }
  await assert.rejects(readCurrent(contexts()), e => e.code === 'UNAVAILABLE');
  await assert.rejects(inspect(), e => e.code === 'UNAVAILABLE');
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'current read never creates a window');
  await assert.rejects(read('javascript:alert(1)', contexts()), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'validation happens before creating a window');
  const found = await search('Mozi test', contexts());
  assert.equal(found.results.length, 1, 'hidden and duplicate results are excluded');
  assert.equal(found.results[0].url, 'https://example.test/article', 'Bing wrappers decode into source URLs');
  const originalWindow = current();
  const preferences = originalWindow.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.ok(!preferences.preload, 'remote page receives no application bridge');
  const article = await read(found.results[0].url, contexts());
  assert.equal(current(), originalWindow, 'search and read reuse one window');
  assert.match(article.content, /Rendered evidence/);
  assert.doesNotMatch(article.content, /Hidden secret|Navigation clutter|setTimeout/);
  for (const link of ['same', 'blank', 'named', 'script']) {
    await read('https://example.test/links', contexts());
    await clickLink(link);
    await until(() => originalWindow.webContents.getURL() === `https://example.test/${link}` && !originalWindow.webContents.isLoading());
    assert.equal(BrowserWindow.getAllWindows().length, 1, `${link} stays in the Mozi window`);
    originalWindow.webContents.navigationHistory.goBack();
    await until(() => originalWindow.webContents.getURL() === 'https://example.test/links' && !originalWindow.webContents.isLoading());
  }
  await clickLink('blocked');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(originalWindow.webContents.getURL(), 'https://example.test/links');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  const interrupted = read('https://example.test/links', { ...contexts(), onProgress: value => {
    if (value.stage === 'extracting') setTimeout(() => {
      void clickLink('blank').catch(() => {});
    }, 100);
  } });
  await assert.rejects(interrupted, e => e.code === 'NAVIGATION_CHANGED');
  await until(() => originalWindow.webContents.getURL() === 'https://example.test/blank' && !originalWindow.webContents.isLoading());
  console.log('PASS: normal, target=_blank, named and window.open links reuse the window; back works and active extraction stops.');
  await agentWorkflow();
  // Foreground-only focus-handler fixtures deliberately require actual page focus.
  current().show(); current().focus(); current().webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 100));
  await interactionWorkflow();
  await inputWorkflow();
  await guardedSearchWorkflow();
  await backgroundWorkflow();
  const queuedOpen = read('https://example.test/article', contexts());
  const queuedCurrent = readCurrent(contexts());
  const [openedPage, currentPage] = await Promise.all([queuedOpen, queuedCurrent]);
  assert.equal(currentPage.url, openedPage.url, 'queued current read resolves the page at execution time');
  assert.equal(currentPage.content, openedPage.content);
  const changedCurrent = readCurrent({ ...contexts(), onProgress: value => {
    if (value.stage === 'extracting') setTimeout(() => {
      void current().webContents.executeJavaScript("history.pushState({}, '', '#changed-during-read')").catch(() => {});
    }, 100);
  } });
  await assert.rejects(changedCurrent, e => e.code === 'NAVIGATION_CHANGED');
  assert.match((await readCurrent(contexts())).url, /#changed-during-read$/);
  assert.equal((await search('empty', contexts())).results.length, 0);
  const long = await read('https://example.test/long', contexts());
  assert.equal(long.truncated, true);
  assert.equal(long.content.length, 24000);
  await assert.rejects(read('https://example.test/fail', contexts()), e => e.code === 'LOAD_FAILED');
  await assert.rejects(read('https://example.test/forbidden', contexts()), e => e.code === 'LOAD_FAILED' && e.message.includes('403'));
  const external = new AbortController();
  const externallyCancelled = read('https://example.test/slow', { ...contexts(), signal: external.signal });
  const externallyRejected = assert.rejects(externallyCancelled, e => e.code === 'CANCELLED');
  external.abort();
  await externallyRejected;

  const navigating = read('https://example.test/article', { ...contexts(), onProgress: value => {
    if (value.stage === 'extracting') setTimeout(() => {
      void current().webContents.executeJavaScript("location.href='https://example.test/other'").catch(() => {});
    }, 100);
  } });
  await assert.rejects(navigating, e => e.code === 'NAVIGATION_CHANGED');

  const progress = [];
  const blocked = read('https://example.test/challenge', contexts(progress));
  await until(() => progress.some(p => p.stage === 'waiting_user'));
  await current().webContents.executeJavaScript("document.body.innerHTML='<article>Verified article evidence.</article>'");
  browserMenu.items[0].submenu.items.find(item => item.label.startsWith('继续读取')).click();
  assert.match((await blocked).content, /Verified article/);

  const slowContext = contexts();
  const slow = read('https://example.test/slow', slowContext);
  const rejected = assert.rejects(slow, e => e.code === 'CANCELLED');
  const queuedContext = contexts();
  const queued = read('https://example.test/article', queuedContext);
  const queuedRejected = assert.rejects(queued, e => e.code === 'CANCELLED');
  browser.cancel(queuedContext.requestId);
  browser.cancel(slowContext.requestId);
  await Promise.all([rejected, queuedRejected]);
  assert.match((await read('https://example.test/article', contexts())).content, /Rendered evidence/);

  const closing = read('https://example.test/slow', contexts());
  const closed = assert.rejects(closing, e => e.code === 'WINDOW_CLOSED');
  const waiting = read('https://example.test/article', contexts());
  const waitingClosed = assert.rejects(waiting, e => e.code === 'WINDOW_CLOSED');
  current().close();
  await Promise.all([closed, waitingClosed]);
  await until(() => BrowserWindow.getAllWindows().length === 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'closing cancels the queue without reopening');
  await assert.rejects(readCurrent(contexts()), e => e.code === 'UNAVAILABLE');
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'closed current page never reopens from history');
  await read('https://example.test/article', contexts());
  assert.notEqual(current(), originalWindow);
  await current().webContents.capturePage().then(image => require('node:fs').writeFileSync('/tmp/mozi-browser-smoke.png', image.toPNG()));
  if (process.argv.includes('--live')) {
    browserSession.protocol.unhandle('https');
    const live = await search('site:electronjs.org BrowserWindow', contexts());
    assert.ok(live.results.length, 'live Bing search returns readable results');
    console.log('LIVE SEARCH:', live.url, JSON.stringify(live.results.map(r => ({ title: r.title, url: r.url }))));
    await current().webContents.capturePage().then(image => require('node:fs').writeFileSync('/tmp/mozi-browser-live-search.png', image.toPNG()));
    const evidence = await read('https://www.electronjs.org/docs/latest/api/browser-window', contexts());
    assert.ok(evidence.content.length > 100);
    console.log('LIVE READ:', evidence.title, evidence.content.length, 'characters');
    await current().webContents.capturePage().then(image => require('node:fs').writeFileSync('/tmp/mozi-browser-live.png', image.toPNG()));
  }
  browser.dispose(); browser.dispose();
  await assert.rejects(read('https://example.test/article', contexts()), e => e.code === 'UNAVAILABLE');
  browser = new MoziBrowser(100);
  await assert.rejects(read('https://example.test/slow', contexts()), e => e.code === 'TIMEOUT');
  browser.dispose();
  console.log('PASS: real BrowserWindow, Bing result decoding, rendered DOM extraction, truncation, challenge/resume, cancellation, queue ownership, close/reopen and isolation.');
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (current() && !current().webContents.isDestroyed()) {
    console.error('Last browser URL:', current().webContents.getURL());
    if (current().isVisible()) await current().webContents.capturePage().then(image => require('node:fs').writeFileSync('/tmp/mozi-browser-failure.png', image.toPNG())).catch(() => {});
  }
  child?.kill(); browser?.dispose(); app.exit(1);
});
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
