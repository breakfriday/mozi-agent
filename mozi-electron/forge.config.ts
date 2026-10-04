import type { ForgeConfig } from "@electron-forge/shared-types";
import path from "node:path";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { assertRendererResources, copyRenderer, rendererResources } from "./scripts/copy-renderer.cjs";
import { buildRenderer } from "./scripts/build-renderer.cjs";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [rendererResources, path.resolve(__dirname, "assets/icons")],
  },
  hooks: {
    preStart: async () => {
      const mode = process.env.ELECTRON_RENDERER_MODE?.trim() || "dev";
      if (mode !== "dev" && mode !== "filelocal") throw new Error("ELECTRON_RENDERER_MODE must be dev or filelocal.");
      if (mode === "filelocal") assertRendererResources();
    },
    prePackage: async () => {
      await buildRenderer();
      await copyRenderer();
    },
  },
  makers: [new MakerSquirrel({}), new MakerZIP({}, ["darwin"]), new MakerRpm({}), new MakerDeb({})],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
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
