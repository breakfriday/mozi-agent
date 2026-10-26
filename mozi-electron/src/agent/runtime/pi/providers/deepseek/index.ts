import type { ProviderPlugin } from "../provider-plugin";
import {
  preserveDeepSeekLocalTools,
  DEEPSEEK_PROVIDER,
  getDeepSeekProviderConfig,
  supportsDeepSeekWebTools,
  withDeepSeekWebTools,
} from "./provider";

export const deepseekPlugin: ProviderPlugin = {
  id: DEEPSEEK_PROVIDER,
  source: "builtin",
  authMethods: ["api_key"],
  createConfig: getDeepSeekProviderConfig,
  supportsWebTools: supportsDeepSeekWebTools,
  configureAgent: preserveDeepSeekLocalTools,
  prepareModel: withDeepSeekWebTools,
};
