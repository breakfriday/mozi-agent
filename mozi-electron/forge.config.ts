import type { ForgeConfig } from "@electron-forge/shared-types";
import { existsSync } from "node:fs";
import path from "node:path";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { assertRendererResources, copyRenderer, rendererResources } from "./scripts/copy-renderer.cjs";
import { buildRenderer } from "./scripts/build-renderer.cjs";

const particleBinName = process.platform === "win32" ? "mozi-particles.exe" : "mozi-particles";

function resolveParticleBinary(): string {
  const candidates = [
    process.env.MOZI_PARTICLES_BIN?.trim(),
    path.resolve(__dirname, "../mozi-particles-rs/target/release", particleBinName),
    path.resolve(__dirname, "../mozi-particles-rs/target/debug", particleBinName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [rendererResources, path.resolve(__dirname, "assets/icons"), resolveParticleBinary()],
    ignore: (file: string) => {
      if (!file) return false;
      if (file.startsWith("/.vite") || file === "/package.json") return false;
      if (file === "/node_modules" || (file.startsWith("/node_modules/") && !file.startsWith("/node_modules/."))) return false;
      return true;
    },
  },
  hooks: {
    preStart: async () => {
      const mode = process.env.ELECTRON_RENDERER_MODE?.trim() || "dev";
      if (mode !== "dev" && mode !== "filelocal") throw new Error("ELECTRON_RENDERER_MODE must be dev or filelocal.");
      if (mode === "filelocal") assertRendererResources();
    },
    prePackage: async () => {
      const particleBin = resolveParticleBinary();
      if (!existsSync(particleBin)) {
        throw new Error(`Rust particle binary is missing: ${particleBin}. Build mozi-particles-rs or set MOZI_PARTICLES_BIN.`);
      }
      await buildRenderer();
      await copyRenderer();
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    ...[new MakerRpm({}), new MakerDeb({})].filter((maker) => maker.externalBinariesExist()),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
        { entry: "src/agent/entry.ts", config: "vite.agent.config.ts", target: "main" },
      ],
      renderer: [],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
