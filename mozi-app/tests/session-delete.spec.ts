import { expect, test } from "@playwright/test";
import type { SessionSnapshot } from "../../shared/agent";

test("permanent delete confirms consequences, retains failed deletions and switches away after success", async ({ page }) => {
  await page.addInitScript(() => {
    const at = "2026-10-11T00:00:00.000Z";
    const snapshots: Record<string, SessionSnapshot> = JSON.parse(localStorage.getItem("delete-sessions") || "null") ??
      Object.fromEntries(["s", "other"].map(id => [id, {
        session: { sessionId: id, title: id === "s" ? "待删除会话" : "保留会话", createdAt: at, updatedAt: at },
        messages: Array.from({ length: 30 }, (_, i) => ({
          id: `${id}-message-${i}`, sessionId: id, role: i % 2 ? "assistant" : "user", status: "completed",
          content: [{ id: `${id}-part-${i}`, type: "text", text: `历史消息 ${i}\n\n` + "用于检查长会话的滚动范围。\n\n".repeat(10) }],
        })), runs: [], tools: [], approvals: [], lastSeq: 0,
      }]));
    if (snapshots.s) sessionStorage.setItem("mozi.agent.sessionId", "s");
    let attempts = 0;
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {}, onEvent: () => () => {},
      getModelSettings: async () => ({ ok: true, result: { providers: [] } }),
      listSessions: async () => ({ ok: true, result: { items: Object.values(snapshots).map(s => s.session) } }),
      subscribeSession: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: { sessionId, subscriptionId: `sub-${sessionId}` } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: structuredClone(snapshots[sessionId]) }),
      deleteSession: async ({ sessionId }: { sessionId: string }) => {
        localStorage.setItem("delete-attempts", String(++attempts));
        if (attempts === 1) return { ok: false, error: { code: "INTERNAL_ERROR", message: "无法删除 Pi 会话文件，会话记录已保留" } };
        delete snapshots[sessionId];
        localStorage.setItem("delete-sessions", JSON.stringify(snapshots));
        return { ok: true, result: { sessionId } };
      },
    } } });
  });
  await page.goto("/mozi_app/chat");
  const remove = page.getByRole("button", { name: "永久删除会话：待删除会话", exact: true });
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "永久删除会话", exact: true });
  await expect(dialog.getByText(/Pi 会话文件和 Token 用量记录，无法恢复/)).toBeVisible();
  await dialog.getByRole("button", { name: "永久删除", exact: true }).hover();
  await page.screenshot({ path: "/tmp/mozi-permanent-delete-confirm.png" });
  await dialog.getByRole("button", { name: /取\s*消/ }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("delete-attempts"))).toBeNull();
  await remove.click();
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("无法删除 Pi 会话文件，会话记录已保留");
  await expect(remove).toBeVisible();
  await dialog.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(page.getByRole("region", { name: "智能对话" }).getByRole("heading", { name: "保留会话" })).toBeVisible();
  await expect(page.getByText("历史消息 29", { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const assertScrollBoundary = async () => {
    const viewport = page.getByRole("region", { name: "聊天消息", exact: true });
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await viewport.evaluate(el => { el.scrollTop = 0; });
    await viewport.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => ({
      rootOverflow: document.documentElement.scrollHeight - innerHeight,
      rootScroll: window.scrollY,
    }))).toEqual({ rootOverflow: 0, rootScroll: 0 });
    const composer = page.getByRole("textbox", { name: "消息内容" });
    const bounds = await composer.boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)));
  };
  await assertScrollBoundary();
  await page.reload();
  await expect(remove).toHaveCount(0);
  await expect(page.getByRole("button", { name: "永久删除会话：保留会话", exact: true })).toBeVisible();
  await expect(page.getByText("历史消息 29", { exact: true })).toBeVisible();
  await assertScrollBoundary();
  await page.setViewportSize({ width: 900, height: 600 });
  await assertScrollBoundary();
});
