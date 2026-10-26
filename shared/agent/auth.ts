/** OAuth UI state only. Credentials never cross the process boundary. */
export type ProviderAuthState = {
  providerId: string;
  loginId: string;
  phase: "idle" | "starting" | "waiting" | "completing" | "succeeded" | "failed" | "cancelled" | "expired";
  revision: number;
  authUrl?: string;
  openRequest?: number;
  prompt?: { id: string; message: string; placeholder?: string };
  message?: string;
};
export type ProviderCatalogEvent = { protocolVersion: 1; kind: "provider.catalog"; providerId: string };
export type ProviderAuthEvent = { protocolVersion: 1; kind: "provider.auth"; state: ProviderAuthState };
