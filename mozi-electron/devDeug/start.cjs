const path = require('node:path');
const { main, agent } = require('./config.json');
const cli = require.resolve('@electron-forge/cli/dist/electron-forge.js');

process.env.MOZI_AGENT_DEBUG = process.argv.includes('--agent-brk') || agent.breakOnStart
  ? 'inspect-brk' : 'inspect';
process.chdir(path.resolve(__dirname, '..'));

// Hand over to the Forge CLI, which owns process startup and shutdown.
process.argv = [process.execPath, cli, 'start', '--',
  `--${main.breakOnStart ? 'inspect-brk' : 'inspect'}=127.0.0.1:${main.port}`];
require(cli);
