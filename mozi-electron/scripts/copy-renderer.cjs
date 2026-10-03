const { existsSync } = require("node:fs");
const { cp, rm } = require("node:fs/promises");
const path = require("node:path");
const config = require("../dual-electron.config.cjs");

const electronDir = path.resolve(__dirname, "..");
const rendererResources = path.join(electronDir, "resources", "renderer");
const rendererOutput = path.join(config.rendererDir, "dist-filelocal");

function assertRendererOutput() {
  if (!existsSync(path.join(rendererOutput, "index.html"))) {
    throw new Error(`DualVite output is missing: ${rendererOutput}/index.html. Run pnpm build:filelocal in ${config.rendererDir}.`);
  }
}

function assertRendererResources() {
  if (!existsSync(path.join(rendererResources, "index.html"))) {
    throw new Error("Renderer resources are missing. Run pnpm build:renderer, then pnpm copy:renderer.");
  }
}

async function copyRenderer() {
  assertRendererOutput();
  await rm(rendererResources, { recursive: true, force: true });
  await cp(rendererOutput, rendererResources, { recursive: true });
  console.log(`DualVite renderer synced to ${rendererResources}`);
}

module.exports = { assertRendererResources, copyRenderer, rendererResources };
if (require.main === module) copyRenderer().catch((error) => { console.error(error); process.exitCode = 1; });
