import type { ProviderPlugin } from "../provider-plugin";
import { failure } from "../../../../errors";
import { configureOpenAIRuntime, OPENAI_PROVIDER } from "./provider";

export const openaiPlugin: ProviderPlugin = {
  id: OPENAI_PROVIDER,
  source: "builtin",
  authMethods: ["oauth", "api_key"],
  dynamicModels: true,
  createConfig: () => ({}),
  validateRuntime: (runtime, context) =>
    configureOpenAIRuntime(runtime, context),
  oauth: {
    prompt: {
      message: "自动回调未完成时，可粘贴本次登录的完整回调 URL。",
      placeholder:
        "http://127.0.0.1:1455/auth/callback?code=…&state=…&client_id=…",
    },
    normalizeInput(value) {
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        throw failure("INVALID_ARGUMENT", "请输入完整回调 URL。");
      }
      if (url.origin === "http://localhost:1455") {
        url.hostname = "127.0.0.1";
      }
      if (
        url.origin !== "http://127.0.0.1:1455" ||
        url.pathname !== "/auth/callback" ||
        url.username ||
        url.password ||
        !url.searchParams.get("code") ||
        !url.searchParams.get("state") ||
        !url.searchParams.get("client_id")
      ) {
        throw failure(
          "INVALID_ARGUMENT",
          "请输入本次登录的 127.0.0.1:1455/auth/callback 回调 URL，不支持直接导入 token。",
        );
      }
      return url.href;
    },
    successMessage: "ChatGPT 授权已保存。",
    failureMessage: (error) =>
      error instanceof Error &&
      /EADDRINUSE|Port 1455 is in use/.test(error.message)
        ? "登录端口 1455 已被占用，请结束其他 OpenAI / Codex 登录后重试。"
        : "ChatGPT 登录未完成，请检查网络或授权状态后重试。",
  },
};
