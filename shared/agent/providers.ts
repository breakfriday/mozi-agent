/** Provider identities include the service/channel, not just a model vendor. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const WEB_MODES = ["browser", "provider"] as const;
export type WebMode = (typeof WEB_MODES)[number];
export type ModelSelection = {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  /** Mutually exclusive routes. Omitted: browser when available, otherwise legacy provider behavior. */
  webMode?: WebMode;
  /** Provider-mode preferences; retained but ignored in browser mode. Omitted means enabled. */
  webSearch?: boolean;
  webExtractor?: boolean;
};
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];
export type ProviderModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
};
export type ProviderModelView = ProviderModel & {
  /** Effective choices exposed by the adapter; a single enabled level means on/off only. */
  thinkingLevels?: ThinkingLevel[];
  /** Server search/extraction controls; extraction requires thinking enabled. */
  supportsWebTools?: boolean;
  /** The host provides the visible Mozi browser independently of model vendor. */
  supportsBrowserTools?: boolean;
};
export type ProviderView = {
  id: string;
  name: string;
  source: "builtin" | "extension" | "configured" | "custom";
  configured: boolean;
  baseUrl: string;
  api: string;
  endpointLocked: boolean;
  removable: boolean;
  models: ProviderModelView[];
  /** Only the user's additions/overrides; package model definitions stay in the package. */
  customModels: ProviderModel[];
};
export type ProviderSaveInput = {
  providerId: string;
  name?: string;
  baseUrl?: string;
  api?: ProviderApi;
  models?: ProviderModel[];
  /** Write-only. Omitted means retain the existing credential. */
  apiKey?: string;
};
export type ModelSettings = { providers: ProviderView[]; defaultModel?: ModelSelection };
