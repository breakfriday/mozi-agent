declare module "pi-antigravity/src/auth/oauth.js" {
  type OAuth = NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["oauth"]>;
  export const loginAntigravity: OAuth["login"];
  export const refreshAntigravityToken: OAuth["refreshToken"];
  export const getApiKey: OAuth["getApiKey"];
}
declare module "pi-antigravity/src/client/client.js" {
  export const DEFAULT_ENDPOINT: string;
  export function parseApiKey(apiKeyRaw: string | undefined): { token: string; projectId: string };
  export function fetchAvailableModelsCatalog(
    token: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{
    endpoint: string;
    status: number;
    data: { models?: Record<string, Record<string, unknown>>; agentModelSorts?: unknown };
  }>;
}
declare module "pi-antigravity/src/models/grouping.js" {
  type ProviderModelConfig = NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["models"]>[number];
  export type AntigravityCatalog = {
    models: ProviderModelConfig[];
    routing: Record<string, Record<string, unknown>>;
  };
  export function buildAntigravityCatalog(
    rawModels: Record<string, Record<string, unknown>>,
    fallback: AntigravityCatalog,
    agentModelSorts?: unknown,
  ): AntigravityCatalog;
  export function resolvedCatalog(
    discovered: AntigravityCatalog | undefined,
    current: AntigravityCatalog,
  ): AntigravityCatalog;
}
declare module "pi-antigravity/src/models/models.js" {
  import type { AntigravityCatalog } from "pi-antigravity/src/models/grouping.js";
  type Models = NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["models"]>;
  export const ANTIGRAVITY_MODELS: Models;
  export const ANTIGRAVITY_ROUTING: Record<string, Record<string, unknown>>;
  export function getCurrentAntigravityModels(): Models;
  export function getCurrentAntigravityCatalog(): AntigravityCatalog;
  export function applyAntigravityCatalog(catalog: AntigravityCatalog): void;
  export function registerDiscoveredModelEnums(models: Record<string, { model?: unknown }> | undefined): void;
  export function snapshotDynamicModelEnums(): Record<string, string>;
}
declare module "pi-antigravity/src/models/discovery.js" {
  export const ANTIGRAVITY_PERSIST_KEY: string;
  export const CATALOG_SCHEMA_VERSION: number;
  export function getCatalogRefreshIntervalMs(): number;
  export function hydrateAntigravityCatalog(stored: unknown): number;
}
declare module "pi-antigravity/src/stream/stream.js" {
  export const streamAntigravity: NonNullable<import("@earendil-works/pi-coding-agent").ProviderConfig["streamSimple"]>;
}
