import { type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { failure } from "../../../errors";
import type { PiConfig } from "../types";
import type { CredentialStorage, Credentials } from "./credential-repository";
import type { ProviderConfiguration, SavedProvider } from "./provider-plugin";
import type { ProviderRegistry } from "./provider-registry";
import {
  createOwnedRuntime,
  enforceOwnedAuth,
  ownedModelsStore,
} from "./owned-runtime";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ProviderSnapshot = {
  runtime: ModelRuntime;
  version: string;
  config: ProviderConfiguration;
  builtinIds: Set<string>;
  activate(): void;
};
export interface RuntimeBuildContext {
  onInvalidGrant(providerId: string): void;
}
export interface RuntimeFactory {
  clearModelCache(providerId: string): Promise<void>;
  build(
    config: ProviderConfiguration,
    credentials: Credentials,
    context: RuntimeBuildContext,
  ): Promise<ProviderSnapshot>;
}
/** SDK construction is isolated here. Provider-specific behavior arrives through the registry. */
export class PiRuntimeFactory implements RuntimeFactory {
  constructor(
    private readonly options: {
      config: PiConfig;
      registry: ProviderRegistry;
      credentials: CredentialStorage;
    },
  ) {}
  clearModelCache(providerId: string): Promise<void> {
    return ownedModelsStore(
      path.join(this.options.config.dataDir, "models-cache.json"),
    ).delete(providerId);
  }
  async build(
    input: ProviderConfiguration,
    credentials: Credentials,
    context: RuntimeBuildContext,
  ): Promise<ProviderSnapshot> {
    const { config: paths, registry } = this.options;
    const config = structuredClone(input);
    for (const value of Object.values(credentials)) {
      if (!value || (value.type !== "api_key" && value.type !== "oauth"))
        throw failure("INVALID_ARGUMENT", "Pi 凭据文件格式错误。");
    }
    for (const plugin of registry.all()) {
      if (
        credentials[plugin.id] &&
        !plugin.authMethods.includes(credentials[plugin.id].type)
      )
        throw failure(
          "INVALID_ARGUMENT",
          `${plugin.id} 的凭据类型不受支持，请移除旧凭据后重新配置。`,
        );
    }
    const credentialSnapshot = this.options.credentials.snapshot(credentials);
    const runtime = await createOwnedRuntime({
      credentials: credentialSnapshot.store,

      modelsStorePath: path.join(paths.dataDir, "models-cache.json"),
      allowModelNetwork: false,
    });
    if (runtime.getError())
      throw failure(
        "INVALID_ARGUMENT",
        "Pi 模型配置无效，请检查 models.json。",
      );
    const builtinIds = new Set(
      runtime.getProviders().map((provider) => provider.id),
    );
    const definitions = new Map<string, ProviderConfig>();
    for (const plugin of registry.all()) {
      const definition = await plugin.createConfig({
        cwd: paths.cwd,
        agentDir: path.join(paths.dataDir, "providers"),
        onInvalidGrant: () => context.onInvalidGrant(plugin.id),
      });
      definitions.set(plugin.id, definition);
      runtime.registerProvider(plugin.id, definition);
      builtinIds.add(plugin.id);
    }
    for (const [id, original] of Object.entries(config.providers)) {
      const plugin = registry.get(id);
      if (plugin?.settingsEditable === false) continue;
      const saved: SavedProvider =
        plugin?.normalizeSettings?.(original) ?? original;
      config.providers[id] = saved;
      const baseModels = runtime.getModels(id);
      const definition = definitions.get(id);
      const template =
        plugin?.customModelDefaults === "first-model"
          ? definition?.models?.[0]
          : undefined;
      const models = saved.models?.map((item) => {
        const base = baseModels.find((model) => model.id === item.id);
        return {
          ...(base ?? template),
          ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
          ...(saved.api ? { api: saved.api } : {}),
          id: item.id,
          name: item.name,
          reasoning: item.reasoning,
          input: item.vision
            ? ["text" as const, "image" as const]
            : ["text" as const],
          contextWindow: item.contextWindow,
          maxTokens: item.maxTokens,
          cost: base?.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        };
      });
      runtime.registerProvider(id, {
        ...definition,
        ...(saved.name ? { name: saved.name } : {}),
        ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
        ...(saved.api ? { api: saved.api } : {}),
        ...(models?.length
          ? {
              models: [
                ...baseModels
                  .filter(
                    (model) => !models.some((item) => item.id === model.id),
                  )
                  .map((model) => ({
                    ...model,
                    ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
                    ...(saved.api ? { api: saved.api } : {}),
                  })),
                ...models,
              ],
            }
          : {}),
      });
    }
    enforceOwnedAuth(runtime);
    for (const [id, credential] of Object.entries(credentials)) {
      if (
        credential.type === "api_key" &&
        credential.key &&
        runtime.getProvider(id)
      )
        await runtime.setRuntimeApiKey(id, credential.key);
    }
    for (const plugin of registry.all()) plugin.validateRuntime?.(runtime);
    await runtime.refresh({ allowNetwork: false });
    return {
      runtime,
      version: randomUUID(),
      config,
      builtinIds,
      activate: credentialSnapshot.activate,
    };
  }
}
