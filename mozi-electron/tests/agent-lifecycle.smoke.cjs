const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    // A dead child can remain a zombie until the host's init reaps it.
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z')) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
async function check(mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-exit-'));
  const env = { ...process.env, MOZI_LIFECYCLE_ROOT: root, MOZI_LIFECYCLE_MODE: mode, MOZI_AGENT_PI_DIR: root, MOZI_AGENT_CWD: root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MOZI_AGENT_PROVIDER; delete env.MOZI_AGENT_MODEL;
  const main = spawn(electron, [path.join(__dirname, 'fixtures/agent-lifecycle-main.cjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let agentPid, output = '', errors = '';
  main.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise(resolve => main.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ready timeout: ' + errors)), 20000);
      main.once('error', error => { clearTimeout(timer); reject(error); });
      main.once('exit', () => { clearTimeout(timer); reject(Error('early exit: ' + errors)); });
      main.stdout.on('data', chunk => {
        output += chunk;
        for (const line of output.split('\n')) {
          if (!line.startsWith('{"ready":true')) continue;
          agentPid = JSON.parse(line).pid; clearTimeout(timer); resolve();
        }
      });
    });
    assert.ok(alive(agentPid));
    if (['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'].includes(mode)) main.kill(mode);
    else main.stdin.end('quit\n');
    let timer;
    const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('main exit timeout')), 10000); })]).finally(() => clearTimeout(timer));
    if (mode !== 'SIGKILL') assert.equal(result.code, 0, errors);
    const deadline = Date.now() + 5000;
    while (alive(agentPid) && Date.now() < deadline) await pause(25);
    assert.equal(alive(agentPid), false, `${mode} left Agent ${agentPid} alive`);
    console.log(`PASS ${mode}: main exited, Agent is no longer running`);
  } finally {
    if (main.exitCode === null && main.signalCode === null) { main.kill('SIGKILL'); await exit; }
    if (agentPid && alive(agentPid)) process.kill(agentPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  for (const mode of ['quit', 'SIGTERM', 'SIGINT', 'SIGHUP', 'app-exit', 'process-exit', 'hung', 'SIGKILL']) await check(mode);
})().catch(error => { console.error(error); process.exitCode = 1; });
