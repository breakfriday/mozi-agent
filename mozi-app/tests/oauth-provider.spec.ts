import { expect, test } from "@playwright/test";
import type { ProviderAuthState } from "../../shared/agent";

test("OAuth settings recover pending login, complete manual callback and logout without API-key fields", async ({ page }) => {
  await page.addInitScript(() => {
    const provider = { id: "antigravity", name: "Antigravity", source: "extension", configured: false,
      authMethods: ["oauth"], authStatus: "disconnected", api: "antigravity-api", baseUrl: "https://example.com",
      endpointLocked: true, removable: false, customModels: [], models: [{ id: "gemini", name: "Gemini",
        contextWindow: 100000, maxTokens: 8000, reasoning: true, vision: true }] };
    const settings = { providers: [provider], defaultModel: { providerId: "antigravity", modelId: "gemini" } };
    const catalogListeners = new Set<(id: string) => void>();
    let state = { providerId: "antigravity", loginId: "", phase: "idle", revision: 0 } as ProviderAuthState;
    const listeners = new Set<(s: ProviderAuthState) => void>();
    const publish = (patch: Partial<ProviderAuthState>) => {
      state = { ...state, ...patch, revision: state.revision + 1 };
      for (const listener of listeners) listener(state);
      return { ok: true, result: state };
    };
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {}, onEvent: () => () => {},
      onProviderModelsChanged: (listener: (id: string) => void) => { catalogListeners.add(listener); return () => catalogListeners.delete(listener); },
      onProviderAuth: (listener: (s: ProviderAuthState) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      listSessions: async () => ({ ok: true, result: { items: [] } }),
      getModelSettings: async () => ({ ok: true, result: settings }),
      setDefaultModel: async ({ model }: { model: { providerId: string; modelId: string } }) => { settings.defaultModel = model; return { ok: true, result: settings }; },
      refreshProviderModels: async () => {
        provider.models = [{ ...provider.models[0], id: "gemini-4", name: "Gemini 4 Fixture" }];
        for (const listener of catalogListeners) listener("antigravity");
        return { ok: true, result: settings };
      },
      statusProviderAuth: async () => ({ ok: true, result: state }),
      startProviderAuth: async () => publish({ loginId: "login", phase: "waiting", authUrl: "https://accounts.google.com/o/oauth2/v2/auth", prompt: { id: "prompt", message: "粘贴本次登录的完整回调 URL。" } }),
      submitProviderAuth: async () => {
        provider.configured = true; provider.authStatus = "connected";
        return publish({ phase: "succeeded", prompt: undefined, authUrl: undefined });
      },
      cancelProviderAuth: async () => publish({ phase: "cancelled", prompt: undefined, authUrl: undefined }),
      openProviderAuth: async () => ({ ok: true, result: state }),
      logoutProviderAuth: async () => {
        provider.configured = false; provider.authStatus = "disconnected";
        publish({ phase: "idle", prompt: undefined, authUrl: undefined }); return { ok: true, result: settings };
      },
    } } });
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/mozi_app/chat");
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  await page.getByRole("button", { name: "配置服务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接 Antigravity" });
  await expect(dialog.getByText("API Key", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "使用 Google 登录" }).click();
  await expect(dialog.getByText("等待 Google 授权…")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "配置服务", exact: true }).click();
  await expect(dialog.getByText("等待 Google 授权…")).toBeVisible();
  await dialog.getByRole("textbox", { name: "OAuth 回调 URL" }).fill("http://localhost:51121/oauth-callback?code=fixture&state=fixture");
  await dialog.getByRole("button", { name: "提交回调 URL" }).click();
  await expect(dialog.getByText("已连接 Google 账号")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "OAuth 回调 URL" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "刷新模型" }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  const settings = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await settings.getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: "Antigravity" }).click();
  await settings.getByRole("combobox", { name: "模型", exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible").getByText("Gemini 4 Fixture")).toBeVisible();
  await page.keyboard.press("Escape");
  await settings.getByRole("button", { name: "配置服务" }).click();
  await dialog.getByRole("button", { name: "退出登录" }).click();
  await expect(dialog.getByRole("button", { name: "使用 Google 登录" })).toBeVisible();
  expect(errors).toEqual([]);
});
