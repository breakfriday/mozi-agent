const { app, utilityProcess } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = mkdtempSync(path.join(os.tmpdir(), 'mozi-pi-smoke-'));
const piDir = path.join(directory, 'config'); mkdirSync(piDir);
const entry = process.env.MOZI_SMOKE_AGENT_ENTRY || path.resolve(__dirname, '../.vite/build/agent.mjs');
let modelRequests = 0;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); modelRequests++;
  assert.equal(req.url, '/v1/chat/completions');
  assert.ok(!request.tools?.length);
  if (modelRequests > 1) {
    assert.ok(request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('hello')), 'Pi restores the original user context: ' + JSON.stringify(request.messages));
    assert.ok(request.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('真实 SDK')), 'Pi restores assistant context');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  send({ role: 'assistant', reasoning_content: '先分析问题' });
  send({ reasoning_content: '，再回答。' });
  send({ content: '真实 SDK ' });
  const lastUser = request.messages.filter(m => m.role === 'user').at(-1);
  if (['cancel me', 'crash me'].includes(lastUser?.content)) return;
  setTimeout(() => { send({ content: '流式回复' }); send({}, 'stop'); res.end('data: [DONE]\n\n'); }, 50);
});
let child;
let seq = 0;
async function spawn() {
  child = utilityProcess.fork(entry, [], { stdio: 'pipe', env: { ...process.env, MOZI_AGENT_DATA_DIR: directory, MOZI_AGENT_PI_DIR: piDir, MOZI_AGENT_PROVIDER: 'local-test', MOZI_AGENT_MODEL: 'smoke' } });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.stdout.on('data', () => {});
  const events = [], pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('ready timeout')), 20000);
    child.once('exit', code => { clearTimeout(timeout); reject(Error('early exit ' + code)); });
    child.on('message', packet => {
      if (packet.kind === 'runtime' && packet.state === 'ready') { clearTimeout(timeout); resolve(); }
      if (packet.kind === 'response') { pending.get(packet.requestId)?.(packet); pending.delete(packet.requestId); }
      if (packet.kind === 'event') events.push(packet);
    });
  });
  await ready;
  const call = async (method, params) => {
    const requestId = 'test-' + ++seq;
    const response = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('request timeout '+method)), 20000); pending.set(requestId, packet => { clearTimeout(timeout); resolve(packet); }); });
    child.postMessage({ protocolVersion: 1, kind: 'request', requestId, method, params });
    const packet = await response;
    if (!packet.ok) throw Error(JSON.stringify(packet.error));
    return packet.result;
  };
  return { call, events };
}
async function until(check) {
  const started = Date.now(); while (!check()) { if(Date.now() - started > 20000) throw Error('event timeout'); await new Promise(r => setTimeout(r, 10)); }
}
async function stop() { const exited = new Promise(resolve => child.once('exit', resolve)); child.postMessage({protocolVersion:1,kind:'control',action:'shutdown'}); await exited; }
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(path.join(piDir, 'models.json'), JSON.stringify({ providers: { 'local-test': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-only', models: [{ id: 'smoke', name: 'Smoke', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(path.join(piDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false } }));
  let { call, events } = await spawn();
  const { sessionId } = await call('session.create', { clientOperationId: 'op' });
  assert.equal((await call('session.list', {})).items[0].title, '新会话');
  const input = { sessionId, clientMessageId: 'client', content: [{ type: 'text', text: 'hello' }] };
  const accepted = await call('run.start', input);
  await until(() => events.some(e => e.type === 'run.finished'));
  assert.equal(events.find(e => e.type === 'run.finished').data.status, 'completed', JSON.stringify(events));
  assert.ok(events.some(e => e.type === 'message.text.delta'));
  assert.ok(events.some(e => e.type === 'message.reasoning.delta'), 'Pi thinking events cross utilityProcess IPC');
  assert.equal(events.find(e => e.type === 'session.updated')?.data.session.title, 'hello');
  assert.ok(events.findIndex(e => e.type === 'session.updated') < events.findIndex(e => e.type === 'message.text.delta'), 'title arrives before model text');
  const snapshot = await call('session.snapshot', { sessionId });
  assert.equal(snapshot.session.title, 'hello');
  assert.equal(snapshot.messages.at(-1).content.filter(x => x.type === 'text').map(x => x.text).join(''), '真实 SDK 流式回复');
  assert.equal(snapshot.messages.at(-1).content.find(x => x.type === 'reasoning').text, '先分析问题，再回答。');
  assert.equal(snapshot.messages[0].clientMessageId, 'client');
  assert.equal(snapshot.messages.at(-1).responseModelId, 'smoke', 'response model crosses utilityProcess IPC');
  assert.equal(modelRequests, 1);
  await stop();
  ({ call, events } = await spawn());
  assert.equal((await call('session.create', {clientOperationId:'op'})).sessionId, sessionId);
  const duplicate = await call('run.start', input); assert.equal(duplicate.runId, accepted.runId); assert.equal(duplicate.disposition, 'duplicate');
  assert.equal(modelRequests, 1);
  const reopenedSnapshot = await call('session.snapshot', { sessionId });
  assert.equal(reopenedSnapshot.session.title, 'hello');
  assert.equal(reopenedSnapshot.messages.at(-1).id, snapshot.messages.at(-1).id);
  assert.deepEqual(reopenedSnapshot.messages.at(-1).content, snapshot.messages.at(-1).content, 'reasoning and text keep types, order and IDs after restart');
  assert.equal(reopenedSnapshot.messages.at(-1).responseModelId, 'smoke', 'response evidence survives process restart');
  const cancel = await call('run.start', { ...input, clientMessageId: 'cancel', content: [{type:'text',text:'cancel me'}] });
  await until(() => events.some(e => e.type === 'message.text.delta' && e.runId === cancel.runId));
  await call('session.rename', { sessionId, title: '手动命名 Smoke' });
  await call('run.cancel', { sessionId, runId: cancel.runId });
  await until(() => events.some(e => e.type === 'run.finished' && e.runId === cancel.runId));
  assert.equal((await call('run.get', { sessionId, runId: cancel.runId })).status, 'cancelled');
  assert.equal((await call('session.snapshot', { sessionId })).messages.find(m => m.role === 'assistant' && m.runId === cancel.runId).responseModelId, 'smoke');
  const crashInput = { ...input, clientMessageId: 'crash', content: [{ type: 'text', text: 'crash me' }] };
  const crash = await call('run.start', crashInput);
  await until(() => events.some(e => e.type === 'message.text.delta' && e.runId === crash.runId));
  const beforeCrash = await call('session.snapshot', { sessionId });
  const killed = new Promise(resolve => child.once('exit', resolve));
  process.kill(child.pid, 'SIGKILL'); await killed;
  ({ call, events } = await spawn());
  const restored = await call('session.snapshot', { sessionId });
  assert.equal(restored.session.title, '手动命名 Smoke');
  assert.equal(restored.runs.find(run => run.id === crash.runId).status, 'interrupted');
  assert.equal(restored.messages.at(-1).id, beforeCrash.messages.at(-1).id);
  assert.equal(restored.lastSeq, 0);
  assert.equal((await call('run.start', crashInput)).disposition, 'duplicate');
  assert.equal(modelRequests, 3);
  await stop();
  // The isolated test metadata can be discarded: native histories must still be discoverable.
  for (const suffix of ['', '-wal', '-shm']) rmSync(path.join(directory, 'mozi.sqlite' + suffix), { force: true });
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const native = SessionManager.create(directory, path.join(directory, 'pi-sessions'));
  native.appendMessage({ role: 'user', content: 'native without Mozi marker', timestamp: Date.now() });
  ({ call, events } = await spawn());
  const listed = await call('session.list', {});
  assert.ok(listed.items.some(item => item.sessionId === sessionId));
  assert.ok(listed.items.some(item => item.sessionId === native.getSessionId()));
  const nativeSnapshot = await call('session.snapshot', { sessionId: native.getSessionId() });
  assert.equal(nativeSnapshot.messages[0].content[0].text, 'native without Mozi marker');
  assert.equal(nativeSnapshot.messages[0].runId, undefined);
  assert.equal(nativeSnapshot.runs.length, 0);
  const rebuilt = await call('session.snapshot', { sessionId });
  assert.equal(rebuilt.session.title, '手动命名 Smoke', 'name survives loss of the SQLite cache');
  assert.ok(rebuilt.messages.some(message => message.content.some(part => part.text === '真实 SDK 流式回复')));
  assert.equal(rebuilt.runs.length, 0, 'resetting metadata does not invent recovered Mozi Runs');
  assert.equal(modelRequests, 3, 'native discovery never calls the model');
  await stop();
  ({ call } = await spawn());
  const rebuiltAgain = await call('session.snapshot', { sessionId });
  assert.deepEqual(rebuiltAgain.messages.map(message => message.id), rebuilt.messages.map(message => message.id));
  await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
  console.log('PASS: real utilityProcess + Pi 1.0.3; streaming, native context/history recovery, stable IDs, dedupe, cancellation, crash without replay, empty-SQLite discovery and unmarked native history.');
  app.exit(0);
}).catch(error => { console.error(error); child?.kill(); server.closeAllConnections(); server.close(); app.exit(1); });
