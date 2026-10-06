/** Provider identities include the service/channel, not just a model vendor. */
export type ModelSelection = { providerId: string; modelId: string };
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
export type ProviderView = {
  id: string;
  name: string;
  source: "builtin" | "extension" | "configured" | "custom";
  configured: boolean;
  baseUrl: string;
  api: string;
  endpointLocked: boolean;
  removable: boolean;
  models: ProviderModel[];
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
