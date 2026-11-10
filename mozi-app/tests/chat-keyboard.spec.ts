import { expect, test } from "@playwright/test";
import type { SessionSnapshot } from "../../shared/agent";

test("chat regions switch focus without losing draft selection or reading position", async ({ page }) => {
  await page.addInitScript(() => {
    const timestamp = "2026-11-04T00:00:00.000Z";
    const snapshot: SessionSnapshot = {
      session: { sessionId: "keyboard", title: "键盘阅读", createdAt: timestamp, updatedAt: timestamp },
      lastSeq: 0, runs: [], tools: [], approvals: [],
      messages: [{ id: "answer", sessionId: "keyboard", role: "assistant", status: "completed",
        content: [
          { id: "reasoning", type: "reasoning", text: "思考步骤" },
          { id: "text", type: "text", text: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段阅读内容。`).join("\n\n") },
        ] }],
    };
    sessionStorage.setItem("mozi.agent.sessionId", "keyboard");
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {},
      onEvent: () => () => {},
      getModelSettings: async () => ({ ok: true, result: { providers: [] } }),
      listSessions: async () => ({ ok: true, result: { items: [snapshot.session] } }),
      subscribeSession: async () => ({ ok: true, result: { sessionId: "keyboard", subscriptionId: "sub" } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async () => ({ ok: true, result: snapshot }),
    } } });
  });
  await page.goto("/mozi_app/chat");
  const viewport = page.getByRole("region", { name: "聊天消息" });
  const input = page.getByRole("textbox", { name: "消息内容" });
  await expect(viewport.getByText("第 80 段阅读内容。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换会话" }).focus();
  await page.keyboard.press("F6");
  await expect(viewport).not.toBeFocused();
  await expect(input).not.toBeFocused();
  await page.getByRole("button", { name: "切换会话" }).focus();
  await page.keyboard.press("Shift+F6");
  await expect(input).toBeFocused();
  await input.fill("保留这段草稿");
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 4));
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await page.keyboard.press("F6");
  await expect(viewport).not.toBeFocused();
  await expect(input).not.toBeFocused();
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press("PageDown");
  const position = await viewport.evaluate(element => element.scrollTop);
  expect(position).toBeGreaterThan(0);
  await page.keyboard.press("Shift+F6");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("保留这段草稿");
  expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 4]);
  await page.keyboard.press("PageDown");
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(position);
  await page.keyboard.press("F6");
  await page.keyboard.press("PageUp");
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
  const reasoningButton = viewport.locator("button").first();
  await reasoningButton.focus();
  await page.keyboard.press("PageDown");
  expect(await viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("PageUp");
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press("F6");
  await expect(input).toBeFocused();
});
