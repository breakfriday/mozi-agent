import type { ProviderPlugin } from "../provider-plugin";
import { failure } from "../../../../errors";
import {
  preserveBailianLocalTools,
  BAILIAN_PROVIDER,
  BAILIAN_API,
  BAILIAN_ENDPOINT,
  loadBailianProvider,
  supportsBailianWebTools,
  withBailianWebTools,
} from "./provider";

/** Cache package resources per plugin instance; runtime configuration is created per build. */
export function createBailianPlugin(): ProviderPlugin {
  const packages = new Map<string, ReturnType<typeof loadBailianProvider>>();
  return {
    id: BAILIAN_PROVIDER,
    name: "百炼 Token Plan",
    source: "extension",
    priority: 100,
    authMethods: ["api_key"],
    endpointLocked: true,
    customModelDefaults: "first-model",
    async createConfig({ cwd, agentDir }) {
      const key = JSON.stringify([cwd, agentDir]);
      let pending = packages.get(key);
      if (!pending) {
        pending = loadBailianProvider(cwd, agentDir);
        packages.set(key, pending);
        void pending.catch(() => {
          if (packages.get(key) === pending) packages.delete(key);
        });
      }
      const definition = { ...(await pending) };
      delete definition.apiKey; // Package "$ENV" is not a literal credential.
      return definition;
    },
    normalizeSettings(settings) {
      if (
        (settings.baseUrl && settings.baseUrl !== BAILIAN_ENDPOINT) ||
        (settings.api &&
          settings.api !== BAILIAN_API &&
          settings.api !== "openai-completions")
      )
        throw failure(
          "INVALID_ARGUMENT",
          "Token Plan provider 必须使用专属套餐入口。",
        );
      return { ...settings, api: BAILIAN_API }; // In-memory migration only.
    },
    validateRuntime(runtime) {
      if (
        runtime
          .getModels(BAILIAN_PROVIDER)
          .some(
            (model) =>
              model.baseUrl !== BAILIAN_ENDPOINT || model.api !== BAILIAN_API,
          )
      )
        throw failure(
          "INVALID_ARGUMENT",
          "Pi 配置覆盖了 Token Plan 专属入口，请移除冲突配置。",
        );
    },
    supportsWebTools: supportsBailianWebTools,
    supportsWebExtractor: supportsBailianWebTools,
    configureAgent: preserveBailianLocalTools,
    prepareModel: withBailianWebTools,
  };
}
