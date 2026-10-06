import { expect, test, type Page } from "@playwright/test";

type ModelFixture = { release(): void; ready(): void; calls: number; writes: number };

async function installBridge(page: Page, mode: "delayed" | "failed" | "unavailable" | "catalog" | "hidden-default") {
  await page.addInitScript((mode) => {
    const settings = {
      providers: [
        ["zai", "Z.AI"], ["google", "Google"], ["bailian-tp", "百炼 Token Plan"],
        ["google-vertex", "Google Vertex AI"], ["huggingface", "Hugging Face"],
        ["kimi-coding", "Kimi For Coding"], ["custom", "Custom Provider"],
      ].map(([id, name]) => ({ id, name, source: "builtin", configured: true,
        baseUrl: "http://127.0.0.1/v1", api: "openai-completions", endpointLocked: false, removable: false,
        customModels: [], models: [{ id: "model", name: "Fixture Model", contextWindow: 32768,
          maxTokens: 4096, reasoning: false, vision: false }] })),
      defaultModel: { providerId: mode === "hidden-default" ? "zai" : "google", modelId: "model" },
    };
    const listeners = new Set<(value: { state: string }) => void>();
    let released = false;
    let resolveSettings: () => void;
    const pending = new Promise<void>(resolve => { resolveSettings = resolve; });
    const fixture: ModelFixture = {
      calls: 0, writes: 0,
      release() { released = true; resolveSettings(); },
      ready() { for (const listener of listeners) listener({ state: "ready" }); },
    };
    Object.assign(window, { modelFixture: fixture, mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: mode === "unavailable" ? "unavailable" : "ready" } }),
      onRuntimeState: (listener: (value: { state: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      onEvent: () => () => {},
      listSessions: async () => ({ ok: true, result: { items: [] } }),
      setDefaultModel: async ({ model }: { model: { providerId: string; modelId: string } }) => {
        fixture.writes++; settings.defaultModel = model; return { ok: true, result: settings };
      },
      getModelSettings: async () => {
        fixture.calls++;
        if (mode === "delayed") await pending;
        if (mode === "failed" && !released) return { ok: false, error: { code: "RUNTIME_UNAVAILABLE", message: "Fixture settings unavailable" } };
        return { ok: true, result: settings };
      },
    } } });
  }, mode);
}

function observeRenderErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Router error boundaries can catch React errors without emitting pageerror.
  page.on("console", message => {
    if (/Maximum update depth|getSnapshot should be cached/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function releaseSettings(page: Page) {
  await page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.release());
}

const chat = (page: Page) => page.getByRole("region", { name: "智能对话" });

test("missing desktop bridge keeps empty model controls usable without a render loop", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await page.goto("/mozi_app/chat");
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await expect(dialog.getByRole("combobox", { name: "服务提供商" })).toBeDisabled();
  await dialog.locator("button.ant-modal-close").click();
  await expect(chat(page).getByRole("textbox", { name: "消息内容" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("delayed settings render safely and update model choices when the response arrives", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "delayed");
  await page.goto("/mozi_app/chat");
  await expect.poll(() => page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.calls)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await expect(dialog.getByRole("combobox", { name: "服务提供商" })).toBeDisabled();
  await releaseSettings(page);
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "服务提供商" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("failed settings load stays mounted and can be retried", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "failed");
  await page.goto("/mozi_app/chat");
  await expect(chat(page).getByRole("alert")).toContainText("Fixture settings unavailable");
  await releaseSettings(page);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await expect(chat(page).getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unavailable Agent can become ready after the chat has mounted", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "unavailable");
  await page.goto("/mozi_app/chat");
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  await expect(chat(page).getByRole("combobox", { name: "服务提供商" })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.ready());
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await expect(chat(page).getByRole("combobox", { name: "服务提供商" })).toBeEnabled();
  expect(errors).toEqual([]);
});


const displayedNames = ["百炼 Token Plan", "Google", "Google Vertex AI", "Hugging Face", "Kimi For Coding"];

test("only the five selected providers appear in chat choices and service settings", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "catalog");
  await page.goto("/mozi_app/chat");
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option-content")).toHaveText(displayedNames);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await expect(dialog.locator("strong")).toHaveText(displayedNames);
  await expect(dialog.getByRole("button", { name: "配置服务" })).toHaveCount(5);
  await expect(dialog.getByRole("button", { name: "添加 provider" })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "服务提供商" }).click();
  await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option-content")).toHaveText(displayedNames);
  expect(errors).toEqual([]);
});

test("a hidden default is not silently changed and the user can choose a visible provider", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "hidden-default");
  await page.goto("/mozi_app/chat");
  await expect(chat(page).getByRole("status")).toContainText("原有模型绑定仍保留");
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await expect(dialog.getByRole("status")).toContainText("原有模型绑定仍保留");
  expect(await page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.writes)).toBe(0);
  await dialog.getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible").getByTitle("Google", { exact: true }).click();
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await expect(chat(page).getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.writes)).toBe(1);
  expect(errors).toEqual([]);
});
