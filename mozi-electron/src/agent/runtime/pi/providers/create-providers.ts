import path from "node:path";
import type { ProviderAuthState } from "../../../../../../shared/agent";
import type { PiConfig } from "../types";
import type { ProviderPlugin } from "./provider-plugin";
import { deepseekPlugin } from "./deepseek";
import { createBailianPlugin } from "./bailian";
import { antigravityPlugin } from "./antigravity";
import { ProviderRegistry } from "./provider-registry";
import { CredentialRepository } from "./credential-repository";
import { FileProviderConfigurationStore } from "./provider-configuration-store";
import { PiRuntimeFactory } from "./pi-runtime-factory";
import { PiProviderManager } from "./provider-manager";

/** The only place selecting concrete plugins and filesystem/SDK implementations. */
export function createPiProviderManager(
  config: PiConfig,
  visualBrowser = false,
  emitAuth: (state: ProviderAuthState) => void = () => {},
  emitCatalog: (id: string) => void = () => {},
  plugins: readonly ProviderPlugin[] = [
    deepseekPlugin,
    createBailianPlugin(),
    antigravityPlugin,
  ],
): PiProviderManager {
  const registry = new ProviderRegistry(plugins);
  const directory = path.join(config.dataDir, "providers");
  const configuration = new FileProviderConfigurationStore(directory);
  const credentials = new CredentialRepository(
    path.join(directory, "auth.json"),
    (id) => registry.credentialPolicy(id),
  );
  const runtimeFactory = new PiRuntimeFactory({
    config,
    registry,
    credentials,
  });
  return new PiProviderManager({
    registry,
    configuration,
    credentials,
    runtimeFactory,
    visualBrowser,
    emitAuth,
    emitCatalog,
  });
}
