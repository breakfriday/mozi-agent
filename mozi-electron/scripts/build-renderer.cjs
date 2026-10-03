const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const config = require("../dual-electron.config.cjs");

function buildRenderer() {
  const packagePath = path.join(config.rendererDir, "package.json");
  const rendererRequire = createRequire(packagePath);
  const viteCli = path.join(path.dirname(rendererRequire.resolve("vite/package.json")), "bin", "vite.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteCli, "build", "--mode", "filelocal"], { cwd: config.rendererDir, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`DualVite build failed (${signal || code}).`)));
  });
}

module.exports = { buildRenderer };
if (require.main === module) buildRenderer().catch((error) => { console.error(error); process.exitCode = 1; });
