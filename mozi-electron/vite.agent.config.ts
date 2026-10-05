import { defineConfig } from "vite";
import { builtinModules } from "node:module";

// Pi is ESM and reads resources relative to its package. Keep its installed
// runtime dependencies external; Forge packages production node_modules.
export default defineConfig({
  build: {
    target: "node22",
    // The standalone Agent tests share this directory with Main and preload.
    emptyOutDir: false,
    lib: { entry: "src/agent/entry.ts", formats: ["es"], fileName: () => "agent.mjs" },
    rollupOptions: { external: ["@earendil-works/pi-coding-agent", /^node:/, ...builtinModules] },
  },
});
