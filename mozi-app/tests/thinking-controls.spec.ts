import { expect, test, type Page } from "@playwright/test";
import type { ModelSelection, ModelSettings, SessionSnapshot, StartRunInput } from "../../shared/agent";

async function installBridge(page: Page) {
  await page.addInitScript(() => {
    const timestamp = "2026-10-10T00:00:00.000Z";
    const initialModel: ModelSelection = { providerId: "google", modelId: "reasoner", thinkingLevel: "medium" };
    const snapshot: SessionSnapshot = JSON.parse(localStorage.getItem("thinking-session") || "null") ?? {
      session: { sessionId: "thinking-session", title: "思考设置", model: initialModel, createdAt: timestamp, updatedAt: timestamp },
      messages: [], runs: [], tools: [], approvals: [], lastSeq: 0,
    };
    const base = { contextWindow: 32000, maxTokens: 4096, vision: false, supportsBrowserTools: true };
    const settings: ModelSettings = {
      defaultModel: JSON.parse(localStorage.getItem("thinking-default") || "null") ?? initialModel,
      providers: [
        { id: "google", name: "Google", source: "builtin", configured: true, baseUrl: "https://example.com/v1",
          api: "openai-completions", endpointLocked: false, removable: false, customModels: [], models: [
            { ...base, id: "reasoner", name: "可调推理模型", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            { ...base, id: "plain", name: "普通模型", reasoning: false, thinkingLevels: ["off"] },
            { ...base, id: "always", name: "始终推理模型", reasoning: true, thinkingLevels: ["low", "high"] },
            { ...base, id: "toggle-only", name: "仅支持思考开关", reasoning: true, thinkingLevels: ["off", "medium"] },
          ] },
        { id: "bailian-tp", name: "百炼 Token Plan", source: "extension", configured: true,
          baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-responses",
          endpointLocked: true, removable: false, customModels: [], models: [
            { ...base, id: "qwen3.8-max-preview", name: "qwen3.8-max-preview", reasoning: true, supportsWebTools: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            { ...base, id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: true, supportsWebTools: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
          ] },
      ],
    };
    sessionStorage.setItem("mozi.agent.sessionId", snapshot.session.sessionId);
    const listeners = new Set<(event: unknown) => void>();
    const save = () => localStorage.setItem("thinking-session", JSON.stringify(snapshot));
    const fixture = { changes: [] as ModelSelection[], submitted: [] as ModelSelection[], rejectNext: false, finish: () => {} };
    Object.assign(window, { thinkingFixture: fixture, mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {},
      onEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getModelSettings: async () => ({ ok: true, result: settings }),
      listSessions: async () => ({ ok: true, result: { items: [snapshot.session] } }),
      subscribeSession: async () => ({ ok: true, result: { sessionId: snapshot.session.sessionId, subscriptionId: "sub" } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async () => ({ ok: true, result: structuredClone(snapshot) }),
      setSessionModel: async ({ model }: { model: ModelSelection }) => {
        if (fixture.rejectNext) { fixture.rejectNext = false; return { ok: false, error: { code: "INVALID_ARGUMENT", message: "思考设置保存失败" } }; }
        fixture.changes.push(model); snapshot.session.model = model; save();
        return { ok: true, result: { session: structuredClone(snapshot.session) } };
      },
      setDefaultModel: async ({ model }: { model: ModelSelection }) => {
        settings.defaultModel = model; localStorage.setItem("thinking-default", JSON.stringify(model));
        return { ok: true, result: settings };
      },
      startRun: async (input: StartRunInput) => {
        const runId = `run-${fixture.submitted.length}`;
        const model = structuredClone(snapshot.session.model!);
        fixture.submitted.push(model);
        const user = { id: `user-${runId}`, sessionId: input.sessionId, runId, clientMessageId: input.clientMessageId,
          role: "user" as const, status: "completed" as const, content: input.content.map((part, index) => ({ ...part, id: `part-${index}` })) };
        const run = { id: runId, sessionId: input.sessionId, userMessageId: user.id, status: "running" as const, model, createdAt: timestamp, updatedAt: timestamp };
        snapshot.messages.push(user); snapshot.runs.push(run);
        const emit = (type: string, data: unknown) => {
          snapshot.lastSeq++;
          for (const listener of listeners) listener({ protocolVersion: 1, kind: "event", sessionId: input.sessionId, runId, seq: snapshot.lastSeq, type, data });
        };
        emit("message.accepted", { message: user }); emit("run.updated", { run }); emit("run.started", {});
        fixture.finish = () => {
          const finished = { ...run, status: "completed" as const };
          snapshot.runs[snapshot.runs.length - 1] = finished;
          emit("run.updated", { run: finished }); emit("run.finished", { status: "completed" }); save();
        };
        save();
        return { ok: true, result: { sessionId: input.sessionId, runId, messageId: user.id, clientMessageId: input.clientMessageId, disposition: "accepted" } };
      },
    } } });
  });
}

const chat = (page: Page) => page.getByRole("region", { name: "智能对话" });
async function latestLevel(page: Page) {
  return page.evaluate(() => (window as unknown as { thinkingFixture: { changes: ModelSelection[] } }).thinkingFixture.changes.at(-1)?.thinkingLevel);
}

test("thinking toggle and levels persist per session, reach submission and remain locked during a run", async ({ page }) => {
  await installBridge(page);
  await page.goto("/mozi_app/chat");
  const toggle = chat(page).getByRole("switch", { name: "深度思考" });
  const level = chat(page).getByRole("combobox", { name: "思考等级" });
  await expect(toggle).toBeChecked(); await expect(level).toBeEnabled();
  await level.click(); await page.getByText("高 · high", { exact: true }).click();
  await expect.poll(() => latestLevel(page)).toBe("high");
  await toggle.click(); await expect(toggle).not.toBeChecked(); await expect(level).toBeDisabled();
  await expect.poll(() => latestLevel(page)).toBe("off");
  await toggle.click(); await expect.poll(() => latestLevel(page)).toBe("high");
  await page.evaluate(() => { (window as unknown as { thinkingFixture: { rejectNext: boolean } }).thinkingFixture.rejectNext = true; });
  await toggle.click(); await expect(page.getByText("思考设置保存失败").first()).toBeVisible();
  await expect(toggle).toBeChecked();
  await toggle.click(); await expect.poll(() => latestLevel(page)).toBe("off");
  await chat(page).getByRole("textbox", { name: "消息内容" }).fill("直接回答 1+1");
  await chat(page).getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(toggle).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { thinkingFixture: { submitted: ModelSelection[] } }).thinkingFixture.submitted.at(-1)?.thinkingLevel)).toBe("off");
  await page.evaluate(() => (window as unknown as { thinkingFixture: { finish(): void } }).thinkingFixture.finish());
  await expect(toggle).toBeEnabled();
  await page.reload(); await expect(toggle).not.toBeChecked();
  await toggle.click(); await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.screenshot({ path: "/tmp/mozi-thinking-controls.png" });
  await page.setViewportSize({ width: 430, height: 850 });
  await expect(toggle).toBeVisible(); await expect(level).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/mozi-thinking-controls-mobile.png" });
});

test("model capabilities govern the switch and selectable levels; defaults stay independent", async ({ page }) => {
  await installBridge(page);
  await page.goto("/mozi_app/chat");
  const toggle = chat(page).getByRole("switch", { name: "深度思考" });
  const level = chat(page).getByRole("combobox", { name: "思考等级" });
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await dialog.getByRole("switch", { name: "深度思考" }).click();
  await expect(dialog.getByRole("switch", { name: "深度思考" })).not.toBeChecked();
  await dialog.locator("button.ant-modal-close").click();
  await expect(toggle).toBeChecked();
  await chat(page).getByRole("combobox", { name: "模型", exact: true }).click();
  await page.getByText("普通模型", { exact: true }).click();
  await expect(toggle).toBeDisabled(); await expect(toggle).not.toBeChecked();
  await expect.poll(() => latestLevel(page)).toBe("off");
  await chat(page).getByRole("combobox", { name: "模型", exact: true }).click();
  await page.getByText("始终推理模型", { exact: true }).click();
  await expect(toggle).toBeDisabled(); await expect(toggle).toBeChecked(); await expect(level).toBeEnabled();
  await expect.poll(() => latestLevel(page)).toBe("low");
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("百炼 Token Plan", { exact: true }).click();
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked(); await expect(level).toBeEnabled();
  await expect.poll(() => latestLevel(page)).toBe("low");
  await level.click();
  const dropdown = page.locator(".ant-select-dropdown:visible");
  for (const label of ["最少 · minimal", "低 · low", "中 · medium", "高 · high", "更高 · xhigh", "最高 · max"]) {
    await expect(dropdown.getByText(label, { exact: true })).toBeVisible();
  }
  await dropdown.getByText("高 · high", { exact: true }).click();
  await expect.poll(() => latestLevel(page)).toBe("high");
  await toggle.click(); await expect(level).toBeDisabled();
  await expect.poll(() => latestLevel(page)).toBe("off");
  await toggle.click(); await expect(level).toBeEnabled();
  await expect.poll(() => latestLevel(page)).toBe("high");
  await level.click(); await dropdown.getByText("更高 · xhigh", { exact: true }).click();
  await expect.poll(() => latestLevel(page)).toBe("xhigh");
  await level.click(); await dropdown.getByText("最高 · max", { exact: true }).click();
  await expect.poll(() => latestLevel(page)).toBe("max");
  await chat(page).getByRole("combobox", { name: "模型", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: /^deepseek-v4-pro$/ }).click();
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked(); await expect(level).toBeEnabled();
  await expect.poll(() => latestLevel(page)).toBe("max");
  await level.click(); await dropdown.getByText("高 · high", { exact: true }).click();
  await expect.poll(() => latestLevel(page)).toBe("high");
  await toggle.click(); await expect(level).toBeDisabled();
  await expect.poll(() => latestLevel(page)).toBe("off");
  await toggle.click(); await expect.poll(() => latestLevel(page)).toBe("high");
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("Google", { exact: true }).click();
  await chat(page).getByRole("combobox", { name: "模型", exact: true }).click();
  await page.getByText("仅支持思考开关", { exact: true }).click();
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked(); await expect(level).toBeDisabled();
  await expect(chat(page).getByText("自动", { exact: true })).toBeVisible();
  await expect.poll(() => latestLevel(page)).toBe("medium");
  await toggle.click(); await expect.poll(() => latestLevel(page)).toBe("off");
});


test("web tools are independent of effort, persist and lock during runs", async ({ page }) => {
  await installBridge(page);
  await page.goto("/mozi_app/chat");
  const search = chat(page).getByRole("switch", { name: "联网搜索" });
  const extractor = chat(page).getByRole("switch", { name: "网页提取" });
  const thinking = chat(page).getByRole("switch", { name: "深度思考" });
  await expect(search).toHaveCount(0);
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("百炼 Token Plan", { exact: true }).click();
  await expect(search).toHaveCount(0);
  await chat(page).getByRole("combobox", { name: "联网方式" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("服务商原生", { exact: true }).click();
  await expect(search).toBeChecked(); await expect(extractor).toBeChecked();
  await search.click(); await expect(search).not.toBeChecked(); await expect(extractor).toBeChecked();
  await thinking.click(); await expect(extractor).toBeDisabled(); await expect(extractor).not.toBeChecked();
  await expect(search).toBeEnabled(); await expect(search).not.toBeChecked();
  await thinking.click(); await expect(extractor).toBeChecked();
  await extractor.click(); await expect(extractor).not.toBeChecked();
  await page.reload(); await expect(search).not.toBeChecked(); await expect(extractor).not.toBeChecked();
  await chat(page).getByRole("combobox", { name: "思考等级" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("高 · high", { exact: true }).click();
  await expect(search).not.toBeChecked(); await expect(extractor).not.toBeChecked();
  await chat(page).getByRole("combobox", { name: "模型", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: /^deepseek-v4-pro$/ }).click();
  await expect(search).not.toBeChecked(); await expect(extractor).not.toBeChecked();
  await chat(page).getByRole("textbox", { name: "消息内容" }).fill("不联网回答");
  await chat(page).getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(search).toBeDisabled(); await expect(extractor).toBeDisabled();
  await expect(chat(page).getByRole("combobox", { name: "联网方式" })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { thinkingFixture: { submitted: ModelSelection[] } }).thinkingFixture.submitted.at(-1)))
    .toMatchObject({ thinkingLevel: "high", webMode: "provider", webSearch: false, webExtractor: false });
  await page.evaluate(() => (window as unknown as { thinkingFixture: { finish(): void } }).thinkingFixture.finish());
  await expect(search).toBeEnabled();
  await page.getByRole("button", { name: "模型服务设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模型服务设置", exact: true });
  await dialog.getByRole("combobox", { name: "服务提供商" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("百炼 Token Plan", { exact: true }).click();
  await dialog.getByRole("combobox", { name: "联网方式" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("服务商原生", { exact: true }).click();
  await dialog.getByRole("switch", { name: "网页提取" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("thinking-default")!).webExtractor)).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("thinking-default")!).webMode)).toBe("provider");
  await dialog.locator("button.ant-modal-close").click();
  await expect(dialog).not.toBeVisible();
  await expect(search).not.toBeChecked();
  await page.screenshot({ path: "/tmp/mozi-web-tool-controls.png" });
  await page.setViewportSize({ width: 430, height: 850 });
  await expect(search).toBeVisible(); await expect(extractor).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/mozi-web-tool-controls-mobile.png" });
});

test("web mode switches persist, restore provider preferences and disable unsupported native routing", async ({ page }) => {
  await installBridge(page);
  await page.goto("/mozi_app/chat");
  const mode = chat(page).getByRole("combobox", { name: "联网方式" });
  const dropdown = page.locator(".ant-select-dropdown:visible");
  await expect(chat(page).getByText("Mozi 浏览器", { exact: true })).toBeVisible();
  await mode.click();
  await expect(dropdown.locator(".ant-select-item-option-disabled").getByText("服务商原生", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await dropdown.getByText("百炼 Token Plan", { exact: true }).click();
  await mode.click(); await dropdown.getByText("服务商原生", { exact: true }).click();
  const search = chat(page).getByRole("switch", { name: "联网搜索" });
  await search.click(); await expect(search).not.toBeChecked();
  await mode.click(); await dropdown.getByText("Mozi 浏览器", { exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("thinking-session")!).session.model.webMode)).toBe("browser");
  await page.reload();
  await expect(chat(page).getByText("Mozi 浏览器", { exact: true })).toBeVisible();
  await mode.click(); await dropdown.getByText("服务商原生", { exact: true }).click();
  await expect(search).not.toBeChecked();
  await page.evaluate(() => { (window as unknown as { thinkingFixture: { rejectNext: boolean } }).thinkingFixture.rejectNext = true; });
  await mode.click(); await dropdown.getByText("Mozi 浏览器", { exact: true }).click();
  await expect(page.getByText("思考设置保存失败").first()).toBeVisible();
  await expect(search).not.toBeChecked();
  await chat(page).getByRole("combobox", { name: "服务提供商" }).click();
  await dropdown.getByText("Google", { exact: true }).click();
  await expect(chat(page).getByText("Mozi 浏览器", { exact: true })).toBeVisible();
  await expect(search).toHaveCount(0);
  await expect(dropdown).toHaveCount(0);
  await page.screenshot({ path: "/tmp/mozi-browser-mode-controls.png" });
});
