import { createHash } from "node:crypto";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "pi-antigravity/src/auth/oauth.js";
import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog, parseApiKey } from "pi-antigravity/src/client/client.js";
import {
  ANTIGRAVITY_PERSIST_KEY,
  CATALOG_SCHEMA_VERSION,
  getCatalogRefreshIntervalMs,
  hydrateAntigravityCatalog,
} from "pi-antigravity/src/models/discovery.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "pi-antigravity/src/models/grouping.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getCurrentAntigravityCatalog,
  getCurrentAntigravityModels,
  registerDiscoveredModelEnums,
  snapshotDynamicModelEnums,
} from "pi-antigravity/src/models/models.js";
import { streamAntigravity } from "pi-antigravity/src/stream/stream.js";

type RefreshModels = NonNullable<ProviderConfig["refreshModels"]>;
type RefreshContext = Parameters<RefreshModels>[0];
type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

export const ANTIGRAVITY_ALLOWED_MODEL_IDS = [
  "gemini-4-carbon-low",
  "gemini-4-carbon-medium",
  "gemini-4-carbon-high",
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gemini-4-argon-high",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-tiered",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
] as const;

const ALLOWED_MODEL_SORTS = [
  { groups: [{ modelIds: [...ANTIGRAVITY_ALLOWED_MODEL_IDS] }] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiKeyFromCredential(credential: RefreshContext["credential"]): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") {
    return typeof credential.key === "string" && credential.key ? credential.key : undefined;
  }
  if (credential.type === "oauth" && typeof credential.access === "string") {
    return getApiKey(credential);
  }
  return undefined;
}

async function discoverAntigravityModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<AntigravityCatalog> {
  const creds = parseApiKey(apiKey);
  const available = await fetchAvailableModelsCatalog(creds.token, creds.projectId, signal);
  const models = available.data.models;
  if (!models || Object.keys(models).length === 0) {
    throw new Error("Antigravity returned an empty or unrecognized model catalog");
  }
  registerDiscoveredModelEnums(models);
  return buildAntigravityCatalog(
    models,
    { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } },
    ALLOWED_MODEL_SORTS,
  );
}

export const refreshAntigravityModels: RefreshModels = async (
  context,
): Promise<ProviderModelConfig[]> => {
  const checkedAt = hydrateAntigravityCatalog(context.stored);
  const current = getCurrentAntigravityCatalog();
  if (!context.allowNetwork) return current.models;

  const apiKey = apiKeyFromCredential(context.credential);
  if (!apiKey || context.signal.aborted) return current.models;

  const credentialKey = createHash("sha256")
    .update(
      JSON.stringify([
        context.credential?.type === "oauth" ? context.credential.refresh : apiKey,
        parseApiKey(apiKey).projectId,
      ]),
    )
    .digest("hex");
  const stored: unknown = context.stored;
  const persisted = isRecord(stored) ? stored[ANTIGRAVITY_PERSIST_KEY] : undefined;
  const sameSource =
    isRecord(persisted) &&
    persisted.schemaVersion === CATALOG_SCHEMA_VERSION &&
    persisted.credentialKey === credentialKey;
  const now = Date.now();
  if (
    !context.force &&
    sameSource &&
    checkedAt > 0 &&
    now >= checkedAt &&
    now - checkedAt < getCatalogRefreshIntervalMs()
  ) {
    return current.models;
  }

  try {
    const discovered = await discoverAntigravityModels(apiKey, context.signal);
    if (context.signal.aborted) return current.models;
    const next = resolvedCatalog(discovered, current);
    if (next.models.length > 0 && discovered.models.length > 0) {
      applyAntigravityCatalog(next);
      const refreshedAt = Date.now();
      await context.publish({
        persist: {
          models: next.models.map((model) => ({
            ...model,
            api: "antigravity-api",
            provider: "antigravity",
            baseUrl: DEFAULT_ENDPOINT,
          })),
          [ANTIGRAVITY_PERSIST_KEY]: {
            catalog: next,
            checkedAt: refreshedAt,
            modelEnums: snapshotDynamicModelEnums(),
            schemaVersion: CATALOG_SCHEMA_VERSION,
            credentialKey,
          },
        } as unknown as Parameters<RefreshContext["publish"]>[0]["persist"],
      });
      return next.models;
    }
  } catch (error) {
    if (context.force) throw error;
  }

  return getCurrentAntigravityCatalog().models;
};

/** Intentionally bypass the CLI entrypoint and its account-pool persistence. */
export function getAntigravityProviderConfig(onInvalidGrant: () => void = () => {}): ProviderConfig {
  return {
    name: "Antigravity",
    api: "antigravity-api",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    models: getCurrentAntigravityModels(),
    streamSimple: streamAntigravity,
    refreshModels: refreshAntigravityModels,
    oauth: { name: "Google Antigravity", isSubscription: true,
      login: loginAntigravity,
      refreshToken: async (credential, signal) => {
        try { return await refreshAntigravityToken(credential, signal); }
        catch (error) {
          if (error instanceof Error && /invalid_grant/.test(error.message)) onInvalidGrant();
          // Provider error bodies must not escape through SDK errors or diagnostics.
          // eslint-disable-next-line preserve-caught-error
          throw new Error("Antigravity 凭据刷新失败，请检查网络；授权失效时请重新登录。");
        }
      }, getApiKey },
  };
}
