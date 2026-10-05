// Isolated Electron main process, launched only by agent-lifecycle.smoke.cjs.
const { app } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};
const root = process.env.MOZI_LIFECYCLE_ROOT;
app.setPath('userData', root);
const { configureAgentLogging } = require('../../../shared/agent/logging.ts');
configureAgentLogging({ enabled: false });
const { AgentProcessManager } = require('../../src/main/agent/process-manager.ts');
const { AgentTransport } = require('../../src/main/agent/transport.ts');
const { registerAgentShutdown } = require('../../src/main/agent/app-lifecycle.ts');
const mode = process.env.MOZI_LIFECYCLE_MODE;
app.whenReady().then(() => {
  let entry = path.resolve(__dirname, '../../.vite/build/agent.mjs');
  if (mode === 'hung') {
    entry = path.join(root, 'hung.cjs');
    writeFileSync(entry, `process.on('SIGTERM', () => {}); process.parentPort.on('message', () => {}); process.parentPort.postMessage({protocolVersion:1,kind:'runtime',state:'ready'}); setInterval(() => {}, 1000);`);
  }
  const transport = new AgentTransport();
  const manager = new AgentProcessManager(transport, { entry, dataDir: root, shutdownMs: 100 });
  registerAgentShutdown(manager, () => {});
  transport.onState(notice => {
    if (notice.state !== 'ready') return;
    const child = app.getAppMetrics().find(metric => metric.name === 'Mozi Agent');
    if (!child) throw Error('Agent missing from app metrics');
    process.stdout.write(JSON.stringify({ ready: true, pid: child.pid }) + '\n');
  });
  process.stdin.on('data', () => {
    if (mode === 'process-exit') process.exit(0);
    else if (mode === 'app-exit') app.exit(0);
    else app.quit();
  });
  manager.start();
}).catch(error => { console.error(error); app.exit(1); });
