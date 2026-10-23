import { expect, test } from "@playwright/test";

test("session switcher groups, highlights, navigates and switches sessions", async ({ page }) => {
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
  // The removed drawer shortcut must not open any session UI.
  await expect(page.getByRole("button", { name: "打开会话列表" })).toHaveCount(0);
  for (const shortcut of ["Control+Shift+k", "Meta+Shift+k"]) {
    await page.keyboard.press(shortcut);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "切换会话" });
  const input = dialog.getByRole("combobox");
  await expect(input).toBeFocused();
  // Repeated shortcuts must work while the input owns focus, including
  // reopening during the close animation and after Escape / close-button use.
  for (const shortcut of ["Control+k", "Meta+k"]) {
    await page.keyboard.press(shortcut);
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await input.press("Escape");
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
  }
  for (const group of ["今天", "昨天", "本周", "更早"]) await expect(dialog.getByRole("group", { name: group, exact: true })).toBeVisible();
  // Keyboard scrolling must reveal the group heading as well as its first row.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 900, height: 500 });
  await input.press("ArrowUp");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("更早的记录");
  await input.press("ArrowDown");
  await expect(dialog.getByText("今天", { exact: true })).toBeInViewport({ ratio: 1 });
  for (const group of ["昨天", "本周", "更早"]) {
    await input.press("ArrowDown");
    await expect(dialog.getByText(group, { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("option", { selected: true })).toBeInViewport({ ratio: 1 });
  }
  for (const group of ["本周", "昨天", "今天"]) {
    await input.press("ArrowUp");
    await expect(dialog.getByText(group, { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("option", { selected: true })).toBeInViewport({ ratio: 1 });
  }
  await page.setViewportSize(viewport);
  await input.fill("player");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.locator("mark")).toHaveText(["Player", "PLAYER"]);
  await input.fill("不存在");
  await expect(dialog.getByText("没有匹配的会话")).toBeVisible();
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await input.fill("播放器");
  await input.press("ArrowDown");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("播放器日志");
  await input.press("ArrowUp");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Player");
  await input.press("ArrowUp");
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "播放器日志", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await dialog.getByRole("option").filter({ hasText: "更早的记录" }).click();
  await expect(page.getByRole("heading", { name: "更早的记录", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  await dialog.getByRole("option").filter({ hasText: "更早的记录" }).hover();
  await dialog.getByRole("button", { name: "更多操作：更早的记录", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await expect(rename.getByRole("textbox", { name: "会话名称" })).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(rename).toBeVisible();
  await rename.getByRole("textbox", { name: "会话名称" }).fill("更新后的记录");
  await rename.getByRole("button", { name: /保\s*存/ }).click();
  await expect(rename).not.toBeVisible();
  await expect(dialog.getByRole("option").filter({ hasText: "更新后的记录" })).toBeVisible();
  await expect(input).toBeFocused();
  // Managing another session must not activate it. Cancel must not delete it.
  await dialog.getByRole("option").filter({ hasText: "本周排查" }).hover();
  await dialog.getByRole("button", { name: "更多操作：本周排查", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "永久删除会话", exact: true });
  await remove.getByRole("button", { name: /取\s*消/ }).click();
  await expect(remove).not.toBeVisible();
  await expect(dialog.getByRole("option").filter({ hasText: "本周排查" })).toBeVisible();
  await dialog.getByRole("option").filter({ hasText: "本周排查" }).hover();
  await dialog.getByRole("button", { name: "更多操作：本周排查", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await remove.getByRole("button", { name: /永久删除$/ }).click();
  await expect(remove).not.toBeVisible();
  await expect(dialog.getByRole("option").filter({ hasText: "本周排查" })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("更新后的记录");
  await expect(input).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  const panelBounds = await dialog.boundingBox();
  expect(panelBounds!.width).toBeLessThan(390);
  await dialog.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();

  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  await page.setViewportSize(viewport);
  await page.keyboard.press("Control+k");
  await input.fill(">new");
  await page.evaluate(() => sessionStorage.setItem("fail-create", "1"));
  await input.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("新建失败，请重试");
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await page.evaluate(() => sessionStorage.removeItem("fail-create"));
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  for (const command of [">", ">new", ">新建"]) {
    await page.keyboard.press("Control+k");
    await input.fill(">unknown");
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await input.press("Enter");
    await expect(dialog).toBeVisible();
    await input.fill(command);
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option", { selected: true })).toContainText("新建会话");
    await input.press("Enter");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  }
  for (const shortcut of ["Control+n", "Meta+n"]) {
    const previous = await page.evaluate(() => sessionStorage.getItem("mozi.agent.sessionId"));
    await page.keyboard.press(shortcut);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("mozi.agent.sessionId"))).not.toBe(previous);
    await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();
  }
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused();
  await page.screenshot({ path: "/tmp/mozi-session-palette.png" });
  await dialog.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeFocused();

});
