import type { ProviderView } from "../../../shared/agent";

// Product display policy only. Keep the full backend catalog and saved selections intact.
export type ProviderDisplayFilter = string | readonly string[];

// Set to "*" / "all" (or ["*"] / ["all"]) to display the entire catalog.
export const PROVIDER_DISPLAY_FILTER: ProviderDisplayFilter = [
  "bailian-tp",
  "google",
  "google-vertex",
  "huggingface",
  "kimi-coding",
] as const;

export function showsAllProviders(filter: ProviderDisplayFilter = PROVIDER_DISPLAY_FILTER): boolean {
  const ids = typeof filter === "string" ? [filter] : filter;
  return ids.includes("*") || ids.includes("all");
}

export function visibleProviders(providers: readonly ProviderView[] = [], filter: ProviderDisplayFilter = PROVIDER_DISPLAY_FILTER): ProviderView[] {
  if (showsAllProviders(filter)) return [...providers];
  const ids = typeof filter === "string" ? [filter] : filter;
  return [...new Set(ids)].flatMap(id => {
    const provider = providers.find(item => item.id === id);
    return provider ? [provider] : [];
  });
}
