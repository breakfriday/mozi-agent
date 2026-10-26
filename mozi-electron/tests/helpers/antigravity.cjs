const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
let loaded;
module.exports = function loadAntigravity() {
  return loaded ??= (async () => {
    const root = path.resolve(__dirname, '../..');
    const outfile = path.join(root, '.vite', `antigravity-test-${process.pid}.mjs`);
    await require('esbuild').build({
      entryPoints: [path.join(root, 'src/agent/runtime/pi/providers/antigravity/provider.ts')],
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      outfile, bundle: true, platform: 'node', format: 'esm', external: ['@earendil-works/*'],
      plugins: [{ name: 'single-account', setup(build) {
        const { adaptOAuthSource, singleAccountPath } = require('../../build/antigravity-adapter.cjs');
        build.onResolve({ filter: /(?:^|\/)accounts\.js$/ }, args => {
          const target = singleAccountPath(args.path, args.importer); if (target) return { path: target };
        });
        build.onLoad({ filter: /pi-antigravity[\/]src[\/]auth[\/]oauth\.ts$/ }, args => ({
          contents: adaptOAuthSource(fs.readFileSync(args.path, 'utf8')), loader: 'ts',
        }));
      } }],
    });
    const source = fs.readFileSync(outfile, 'utf8');
    require('node:assert/strict').ok(!source.includes('antigravity-accounts.json'), 'CLI account pool must not enter the runtime bundle');
    try { return await import(pathToFileURL(outfile).href); }
    finally { fs.unlinkSync(outfile); }
  })();
};
