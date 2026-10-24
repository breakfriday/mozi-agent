import { expect, test } from "@playwright/test";

test("delete shortcut targets the selection and requires yes/no confirmation", async ({ page }) => {
  test.setTimeout(60000);
  await page.clock.setFixedTime(new Date("2026-10-23T12:00:00"));
  await page.addInitScript(() => {
    const sessions = [
      { sessionId: "today", title: "播放器 Player PLAYER", updatedAt: "2026-10-23T10:00:00" },
      { sessionId: "yesterday", title: "播放器日志", updatedAt: "2026-10-22T10:00:00" },
      { sessionId: "week", title: "本周排查", updatedAt: "2026-10-20T10:00:00" },
      { sessionId: "old", title: "更早的记录", updatedAt: "2026-10-10T10:00:00" },
    ].map(s => ({ ...s, updatedAt: new Date(s.updatedAt).toISOString(), createdAt: new Date(s.updatedAt).toISOString() }));
    sessionStorage.setItem("mozi.agent.sessionId", "today");
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {}, onEvent: () => () => {},
      getModelSettings: async () => ({ ok: true, result: { providers: [] } }),
      createSession: async () => {
        if (sessionStorage.getItem("fail-create")) return { ok: false, error: { code: "INTERNAL_ERROR", message: "新建失败，请重试" } };
        const sessionId = `new-session-${sessions.length}`;
        const at = new Date().toISOString();
        sessions.push({ sessionId, title: "新会话", createdAt: at, updatedAt: at });
        return { ok: true, result: { sessionId } };
      },
      renameSession: async ({ sessionId, title }: { sessionId: string; title: string }) => {
        const session = sessions.find(s => s.sessionId === sessionId)!;
        session.title = title;
        return { ok: true, result: { session } };
      },
      deleteSession: async ({ sessionId }: { sessionId: string }) => {
        if (sessionStorage.getItem("fail-delete")) return { ok: false, error: { code: "INTERNAL_ERROR", message: "删除失败" } };
        sessions.splice(sessions.findIndex(s => s.sessionId === sessionId), 1);
        return { ok: true, result: { sessionId } };
      },
      listSessions: async () => ({ ok: true, result: { items: sessions } }),
      subscribeSession: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: { sessionId, subscriptionId: `sub-${sessionId}` } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: {
        session: sessions.find(s => s.sessionId === sessionId), messages: [], runs: [], tools: [], approvals: [], lastSeq: 0,
      } }),
    } } });
  });
  await page.goto("/mozi_app/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "播放器 Player PLAYER", exact: true })).toBeVisible({ timeout: 15000 });
  const panel = page.getByRole("dialog", { name: "切换会话", exact: true });
  const confirm = page.getByRole("dialog", { name: "永久删除会话", exact: true });
  const answer = confirm.getByRole("textbox", { name: "删除确认" });
  await page.getByRole("textbox", { name: "消息内容" }).press("Control+d");
  await expect(confirm).not.toBeVisible();
  await page.keyboard.press("Control+k");
  const input = panel.getByRole("combobox");
  await expect(input).toBeFocused();
  for (const query of [">new", "不存在"]) {
    await input.fill(query);
    await input.press("Control+d");
    await expect(confirm).not.toBeVisible();
  }
  await input.fill("播放器");
  await input.press("ArrowDown");
  await expect(panel.getByRole("option", { selected: true })).toContainText("播放器日志");
  await input.press("Control+d");
  await expect(answer).toBeFocused();
  await expect(confirm).toContainText("播放器日志");
  await answer.fill("y");
  await answer.press("Enter");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "永久删除", exact: true })).toBeDisabled();
  await answer.fill("no");
  await answer.press("Enter");
  await expect(confirm).not.toBeVisible();
  await expect(input).toBeFocused();
  await expect(panel.getByRole("option")).toHaveCount(2);
  await input.press("Meta+d");
  await expect(answer).toHaveValue("");
  await answer.press("Escape");
  await expect(confirm).not.toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Control+d");
  await page.evaluate(() => sessionStorage.setItem("fail-delete", "1"));
  await answer.fill("yes");
  await answer.press("Enter");
  await expect(confirm.getByRole("alert")).toHaveText("删除失败");
  await page.evaluate(() => sessionStorage.removeItem("fail-delete"));
  await answer.press("Enter");
  await expect(confirm).not.toBeVisible();
  await expect(input).toBeFocused();
  await expect(panel.getByRole("option")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("播放器 Player PLAYER");
  await expect(panel.getByRole("option", { selected: true })).toContainText("播放器 Player PLAYER");
  // Delete the active session too, then ensure an empty result has no target.
  await input.press("Control+d");
  await expect(answer).toHaveValue("");
  await answer.fill("yes");
  await answer.press("Enter");
  await expect(confirm).not.toBeVisible();
  await expect(input).toBeFocused();
  await expect(panel.getByRole("option")).toHaveCount(0);
  await input.press("Control+d");
  await expect(confirm).not.toBeVisible();
});
