import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { loginAntigravity, refreshAntigravityToken, getApiKey } from "pi-antigravity/src/auth/oauth.js";
import { getCurrentAntigravityModels } from "pi-antigravity/src/models/models.js";
import { refreshAntigravityModels } from "pi-antigravity/src/models/discovery.js";
import { streamAntigravity } from "pi-antigravity/src/stream/stream.js";

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
