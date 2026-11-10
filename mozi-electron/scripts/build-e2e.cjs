// Build the production entry points without packaging or changing Forge's dev output.
const path = require('node:path');
const { builtinModules } = require('node:module');

async function main() {
  const { build } = await import('vite');
  const root = path.resolve(__dirname, '..');
  process.chdir(root);
  const outDir = path.join(root, '.vite/e2e');
  for (const entry of ['main', 'preload']) {
    await build({
      root,
      configFile: path.join(root, `vite.${entry}.config.ts`),
      build: {
        outDir, emptyOutDir: false, minify: false, target: 'node22',
        lib: { entry: `src/${entry}.ts`, formats: ['cjs'], fileName: () => `${entry}.js` },
        rollupOptions: { external: ['electron', /^node:/, ...builtinModules, /^@hfrancisla\//] },
      },
    });
  }
  await build({ root, configFile: path.join(root, 'vite.agent.config.ts'), build: { outDir } });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
