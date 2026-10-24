import { expect, test, type Page } from "@playwright/test";

type ModelFixture = { release(): void; ready(): void; calls: number; writes: number };

async function installBridge(page: Page, mode: "delayed" | "failed" | "unavailable" | "catalog" | "hidden-default" | "session") {
  await page.addInitScript((mode) => {
    const settings = {
      providers: [
        ["zai", "Z.AI"], ["google", "Google"], ["bailian-tp", "百炼 Token Plan"],
        ["google-vertex", "Google Vertex AI"], ["huggingface", "Hugging Face"],
        ["kimi-coding", "Kimi For Coding"], ["custom", "Custom Provider"],
      ].map(([id, name]) => ({ id, name, source: "builtin", configured: true,
        baseUrl: "http://127.0.0.1/v1", api: "openai-completions", endpointLocked: false, removable: false,
        customModels: [], models: [{ id: "model", name: "Fixture Model", contextWindow: 32768,
          maxTokens: 4096, reasoning: false, vision: false },
          { id: "second", name: "Second Model", contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false }] })),
      defaultModel: { providerId: mode === "hidden-default" ? "zai" : "google", modelId: "model" },
    };
    const session = { sessionId: "shortcut-session", title: "快捷键测试", model: settings.defaultModel,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (mode === "session") sessionStorage.setItem("mozi.agent.sessionId", session.sessionId);
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
      listSessions: async () => ({ ok: true, result: { items: mode === "session" ? [session] : [] } }),
      subscribeSession: async () => ({ ok: true, result: { sessionId: session.sessionId, subscriptionId: "sub" } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async () => ({ ok: true, result: { session, messages: [], runs: [], tools: [], approvals: [], lastSeq: 0 } }),
      setSessionModel: async ({ model }: { model: { providerId: string; modelId: string } }) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        session.model = model;
        return { ok: true, result: { session } };
      },
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


test("provider and model shortcuts open searchable choices without changing defaults", async ({ page }) => {
  const errors = observeRenderErrors(page);
  await installBridge(page, "catalog");
  await page.goto("/mozi_app/chat");
  const provider = chat(page).getByRole("combobox", { name: "服务提供商", exact: true });
  const model = chat(page).getByRole("combobox", { name: "模型", exact: true });
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await chat(page).getByRole("textbox", { name: "消息内容" }).focus();
  await page.keyboard.press("Alt+p");
  await expect(provider).toBeFocused();
  await expect(provider).toHaveAttribute("aria-expanded", "true");
  await provider.fill("Kimi");
  await provider.press("ArrowDown");
  await provider.press("Enter");
  await expect(chat(page).locator(".ant-select-content").filter({ hasText: "Kimi For Coding" })).toBeVisible();
  await expect(provider).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Alt+m");
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute("aria-expanded", "true");
  await model.fill("Second");
  await model.press("ArrowDown");
  await model.press("Enter");
  await expect(chat(page).locator(".ant-select-content").filter({ hasText: "Second Model" })).toBeVisible();
  await page.keyboard.press("Alt+p");
  await expect(provider).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Alt+m");
  await expect(model).toBeFocused();
  await expect(provider).toHaveAttribute("aria-expanded", "false");
  await model.press("Escape");
  await expect(model).toHaveAttribute("aria-expanded", "false");
  await expect(chat(page).locator(".ant-select-content").filter({ hasText: "Second Model" })).toBeVisible();
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await expect(settings.locator(".ant-select-content").filter({ hasText: /^Google$/ })).toBeVisible();
  await expect(settings.locator(".ant-select-content").filter({ hasText: /^Fixture Model$/ })).toBeVisible();
  for (const shortcut of ["Alt+p", "Alt+m"]) {
    await page.keyboard.press(shortcut);
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  }
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings).not.toBeVisible();
  await chat(page).getByRole("textbox", { name: "消息内容" }).focus();
  await page.keyboard.press("Control+k");
  const sessions = page.getByRole("dialog", { name: "切换会话", exact: true });
  await expect(sessions.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Alt+p");
  await page.keyboard.press("Alt+m");
  await expect(sessions.getByRole("combobox")).toBeFocused();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { modelFixture: ModelFixture }).modelFixture.writes)).toBe(0);
  expect(errors).toEqual([]);
});

test("model shortcuts wait for the catalog to load", async ({ page }) => {
  await installBridge(page, "delayed");
  await page.goto("/mozi_app/chat");
  const composer = chat(page).getByRole("textbox", { name: "消息内容" });
  await composer.focus();
  await page.keyboard.press("Alt+p");
  await page.keyboard.press("Alt+m");
  await expect(composer).toBeFocused();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await releaseSettings(page);
  await expect(chat(page).getByText("Fixture Model", { exact: true })).toBeVisible();
  await page.keyboard.press("Alt+m");
  await expect(chat(page).getByRole("combobox", { name: "模型", exact: true })).toHaveAttribute("aria-expanded", "true");
});


test("existing session selections stay closed after async model updates", async ({ page }) => {
  await installBridge(page, "session");
  await page.goto("/mozi_app/chat");
  await expect(chat(page).getByRole("heading", { name: "快捷键测试" })).toBeVisible();
  const provider = chat(page).getByRole("combobox", { name: "服务提供商", exact: true });
  const model = chat(page).getByRole("combobox", { name: "模型", exact: true });
  for (const keyboard of [false, true]) {
    if (keyboard) await page.keyboard.press("Alt+p");
    else await provider.click();
    const providerName = keyboard ? "Google" : "Kimi For Coding";
    if (keyboard) {
      await provider.fill(providerName);
      await provider.press("Enter");
    } else await page.locator(".ant-select-dropdown:visible").getByTitle(providerName, { exact: true }).click();
    await expect(provider).toBeEnabled();
    await expect(chat(page).locator(".ant-select-content").filter({ hasText: new RegExp(`^${providerName}$`) })).toBeVisible();
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    if (keyboard) await page.keyboard.press("Alt+m");
    else await model.click();
    if (keyboard) {
      await model.fill("Second");
      await model.press("Enter");
    } else await page.locator(".ant-select-dropdown:visible").getByTitle("Second Model", { exact: true }).click();
    await expect(model).toBeEnabled();
    await expect(chat(page).locator(".ant-select-content").filter({ hasText: /^Second Model$/ })).toBeVisible();
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
    // Selecting the current value must close too, even without onChange.
    await model.click();
    await page.locator(".ant-select-dropdown:visible").getByTitle("Second Model", { exact: true }).click();
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  }
});


test("repeated provider shortcuts confirm with a single Enter", async ({ page }) => {
  await installBridge(page, "session");
  await page.goto("/mozi_app/chat");
  await expect(chat(page).getByRole("heading", { name: "快捷键测试" })).toBeVisible();
  const provider = chat(page).getByRole("combobox", { name: "服务提供商", exact: true });
  for (const name of ["Google Vertex AI", "Hugging Face", "Kimi For Coding"]) {
    await page.keyboard.press("Alt+p");
    await expect(provider).toBeFocused();
    await expect(provider).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.down("Enter");
    await expect(chat(page).locator(".ant-select-content").filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible();
    await expect(provider).toBeEnabled();
    await page.keyboard.up("Enter");
    await expect(provider).toHaveAttribute("aria-expanded", "false");
  }
  const model = chat(page).getByRole("combobox", { name: "模型", exact: true });
  for (const name of ["Second Model", "Fixture Model", "Second Model"]) {
    await page.keyboard.press("Alt+m");
    await expect(model).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.down("Enter");
    await expect(chat(page).locator(".ant-select-content").filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible();
    await expect(model).toBeEnabled();
    await page.keyboard.up("Enter");
    await expect(model).toHaveAttribute("aria-expanded", "false");
  }
});
