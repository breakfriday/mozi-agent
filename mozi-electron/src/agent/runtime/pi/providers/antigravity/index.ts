import type { ProviderPlugin } from "../provider-plugin";
import { failure } from "../../../../errors";
import { getAntigravityProviderConfig } from "./provider";

export const antigravityPlugin: ProviderPlugin = {
  id: "antigravity",
  source: "extension",
  authMethods: ["oauth"],
  settingsEditable: false,
  endpointLocked: true,
  dynamicModels: true,
  createConfig: ({ onInvalidGrant }) =>
    getAntigravityProviderConfig(onInvalidGrant),
  oauth: {
    prompt: {
      message: "自动回调未完成时，可粘贴本次登录的完整回调 URL。",
      placeholder: "http://localhost:51121/oauth-callback?code=…&state=…",
    },
    normalizeInput(value) {
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        throw failure("INVALID_ARGUMENT", "请输入完整回调 URL。");
      }
      if (
        url.origin !== "http://localhost:51121" ||
        url.pathname !== "/oauth-callback" ||
        !url.searchParams.get("code") ||
        !url.searchParams.get("state")
      )
        throw failure(
          "INVALID_ARGUMENT",
          "请输入本次登录的 localhost:51121/oauth-callback URL，不支持直接导入 token。",
        );
      return url.href;
    },
    successMessage: "Google 授权已保存。",
    failureMessage: (error) =>
      error instanceof Error &&
      /EADDRINUSE|Port 51121 is already in use/.test(error.message)
        ? "登录端口 51121 已被占用，请结束其他 Antigravity 登录后重试。"
        : "Google 登录未完成，请检查网络或授权状态后重试。",
  },
};
