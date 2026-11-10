import { test, expect } from "./fixtures";
import type { ElectronApi } from "../../../shared/electron-api";

test("real preload connects to main and the Agent utility process", async ({ desktop }) => {
  const { app, page } = desktop;
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toContain("mozi-e2e-");
  const state = await page.evaluate(() => (window as unknown as { electronAPI: ElectronApi }).electronAPI.window.getState());
  expect(state).toEqual({ isFullScreen: false });
  const settings = await page.evaluate(() => window.mozi!.agent.getModelSettings());
  expect(settings.ok).toBe(true);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
});

test("UI creates and renames a real session which survives an Electron restart", async ({ desktop }) => {
  let page = desktop.page;
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const result = await window.mozi!.agent.listSessions();
    return result.ok ? result.result.items.length : 0;
  })).toBe(1);
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await page.getByRole("button", { name: "更多操作：新会话", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "会话名称" }).fill("Electron 持久化验收");
  await page.getByRole("dialog", { name: "重命名会话" }).getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByRole("button", { name: "更多操作：Electron 持久化验收", exact: true })).toBeVisible();
  await desktop.restart();
  page = desktop.page;
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await expect(page.getByRole("button", { name: "更多操作：Electron 持久化验收", exact: true })).toBeVisible();
  const sessions = await page.evaluate(() => window.mozi!.agent.listSessions());
  expect(sessions.ok && sessions.result.items.map(item => item.title)).toEqual(["Electron 持久化验收"]);
});

test("preload opens a native monitor window with its own working bridge", async ({ desktop }) => {
  const { page, app } = desktop;
  const created = await page.evaluate(() => window.mozi!.agent.createSession({ clientOperationId: "monitor-e2e", title: "窗口验收" }));
  if (!created.ok) throw new Error(created.error.message);
  const opened = app.waitForEvent("window");
  expect(await page.evaluate(sessionId => (window as unknown as { electronAPI: ElectronApi }).electronAPI.window.openTokenMonitor({ sessionId }), created.result.sessionId)).toBe(true);
  const monitor = await opened;
  await expect(monitor).toHaveURL(/angetTokenMonitor\?sessionId=/);
  await expect(monitor.getByText("窗口验收", { exact: true })).toBeVisible();
  expect(await monitor.evaluate(() => (window as unknown as { electronAPI: ElectronApi }).electronAPI.window.getState())).toEqual({ isFullScreen: false });
  await monitor.evaluate(() => (window as unknown as { electronAPI: ElectronApi }).electronAPI.window.close());
  await expect.poll(() => app.windows().length).toBe(1);
  await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
});
