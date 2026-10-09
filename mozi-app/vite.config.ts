import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

function normalizeBase(base: string) {
  const segment = base.trim().split("/").filter(Boolean).join("/");
  return segment ? `/${segment}/` : "/";
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isFileLocalBuild = mode === "filelocal";
  return {
    base: isFileLocalBuild ? "./" : normalizeBase(env.VITE_APP_BASE || "/"),
    // Vite 8 uses Rolldown for dependency optimization and production bundling.
    // Oxc handles TS/JSX transforms; plugin-react 6 uses Oxc for React Refresh.
    build: {
      outDir: isFileLocalBuild ? "dist-filelocal" : "dist",
      minify: "oxc",
    },
    plugins: [tanstackRouter(), react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  };
});
