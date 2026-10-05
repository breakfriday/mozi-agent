const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const createLoader = require('../helpers/load-ts.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t) {
  const children = [];
  const load = createLoader({ 'node:process': { kill: (pid, signal) => {
    assert.equal(signal, 'SIGKILL');
    const child = children.find(child => child.pid === pid);
    child.killed++;
    if (!child.delayExit) child.emit('exit', 1);
  } }, electron: { utilityProcess: { fork: () => {
    const child = new EventEmitter(); child.sent = []; child.killed = 0; child.pid = children.length + 100;
    child.postMessage = packet => { child.sent.push(packet); if (packet.action === 'shutdown') child.emit('exit', 0); };
    child.kill = () => { child.killed++; child.emit('exit', 1); return true; };
    children.push(child); return child;
  } } } });
  const { AgentTransport } = load(path.resolve(__dirname, '../../src/main/agent/transport.ts'));
  const { AgentProcessManager } = load(path.resolve(__dirname, '../../src/main/agent/process-manager.ts'));
  const transport = new AgentTransport();
  const manager = new AgentProcessManager(transport, { entry: 'agent.mjs', dataDir: '/tmp/test', startupMs: 10, shutdownMs: 10, restartMs: 1 });
  t.after(() => manager.stop());
  return { children, transport, manager };
}
test('process manager waits for ready, starts once, and graceful stop does not restart', async t => {
  const { children, transport, manager } = setup(t);
  manager.start(); manager.start(); assert.equal(children.length, 1);
  assert.equal(transport.getState().state, 'unavailable');
  children[0].emit('message', { protocolVersion: 1, kind: 'runtime', state: 'ready' });
  assert.equal(transport.getState().state, 'ready');
  await manager.stop(); await pause(15);
  assert.equal(children.length, 1); assert.equal(children[0].killed, 0);
  assert.equal(children[0].sent[0].action, 'shutdown');
  assert.equal(transport.getState().state, 'unavailable');
});
test('startup timeout kills the child and retries are bounded', async t => {
  const { children, manager } = setup(t); manager.start();
  await pause(120);
  assert.equal(children.length, 4); assert.ok(children.every(child => child.killed === 1));
});
test('shutdown timeout sends SIGKILL but waits for exit before resolving', async t => {
  const { children, manager } = setup(t); manager.start();
  const child = children[0]; child.postMessage = () => {}; child.delayExit = true;
  let stopped = false;
  const stop = manager.stop().then(() => { stopped = true; });
  await pause(20);
  assert.equal(child.killed, 1); assert.equal(stopped, false);
  child.emit('exit', 1); await stop;
  assert.equal(stopped, true); assert.equal(children.length, 1);
});
test('failed shutdown delivery forces termination without a restart', async t => {
  const { children, manager } = setup(t); manager.start();
  children[0].postMessage = () => { throw Error('port closed'); };
  await manager.stop(); await pause(15);
  assert.equal(children[0].killed, 1); assert.equal(children.length, 1);
});
test('synchronous exit fallback kills the owned child and disables restart', async t => {
  const { children, manager } = setup(t); manager.start();
  manager.forceStop(); await pause(15); manager.start();
  assert.equal(children[0].killed, 1); assert.equal(children.length, 1);
});
test('shutdown racing spawn kills the child once a PID is available', async t => {
  const { children, manager } = setup(t); manager.start();
  const child = children[0]; child.pid = undefined; child.postMessage = () => {};
  const stopped = manager.stop(); await pause(20);
  assert.equal(child.killed, 0);
  child.pid = 100; child.emit('spawn'); await stopped;
  assert.equal(child.killed, 1);
});
