// Set isolation before the real main entry requests its single-instance lock.
const { app } = require('electron');
const path = require('node:path');
const { mkdirSync, appendFileSync } = require('node:fs');
const dataDir = process.env.MOZI_E2E_USER_DATA;
if (!dataDir) throw new Error('MOZI_E2E_USER_DATA is required');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setPath('sessionData', dataDir);
const root = path.resolve(__dirname, '../../../mozi-electron');
app.setAppPath(root);
app.on('web-contents-created', (_event, contents) => {
  const log = value => appendFileSync(path.join(dataDir, 'startup.log'), `${value}\n`);
  contents.on('preload-error', (_event, preloadPath, error) => log(`preload failed: ${preloadPath} ${error}`));
  contents.on('console-message', (_event, level, message) => {
    if (level >= 2) log(`renderer: ${message}`);
  });
});
require(path.join(root, '.vite/e2e/main.js'));
