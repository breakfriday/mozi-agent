import { defineConfig } from "vite";
import { adaptOAuthSource, singleAccountPath } from "./build/antigravity-adapter.cjs";
import { builtinModules } from "node:module";

// Pi is ESM and reads resources relative to its package. Keep its installed
// runtime dependencies external; Forge packages production node_modules.
export default defineConfig({
  plugins: [{ name: "mozi-antigravity-single-account", enforce: "pre",
    resolveId: (source, importer) => singleAccountPath(source, importer),
    transform(source, id) {
      if (id.replaceAll("\\", "/").endsWith("/pi-antigravity/src/auth/oauth.ts")) return { code: adaptOAuthSource(source), map: { mappings: "" } };
    },
  }],
  build: {
    target: "node22",
    sourcemap: true,
    minify: false,
    // The standalone Agent tests share this directory with Main and preload.
    emptyOutDir: false,
    lib: { entry: "src/agent/entry.ts", formats: ["es"], fileName: () => "agent.mjs" },
    rollupOptions: { external: ["@earendil-works/pi-coding-agent", /^@earendil-works\/pi-ai(?:\/|$)/, /^node:/, ...builtinModules] },
  },
});
