import { expect, test } from "@playwright/test";
import type { AgentEvent, SessionSnapshot } from "../../shared/agent";

test("first-message title updates the sidebar and manual rename survives reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const at = "2026-10-10T00:00:00.000Z";
    const snapshot: SessionSnapshot = JSON.parse(localStorage.getItem("title-fixture") || "null") ?? {
      session: { sessionId: "s", title: "新会话", createdAt: at, updatedAt: at },
      messages: [], runs: [], tools: [], approvals: [], lastSeq: 0,
    };
    sessionStorage.setItem("mozi.agent.sessionId", "s");
    const listeners = new Set<(event: AgentEvent) => void>();
    const save = () => localStorage.setItem("title-fixture", JSON.stringify(snapshot));
    window.addEventListener("fixture-user-persisted", () => {
      snapshot.session.title = "检查播放器连接";
      const event: AgentEvent = { protocolVersion: 1, kind: "event", type: "session.updated",
        sessionId: "s", runId: "r", seq: ++snapshot.lastSeq, data: { session: snapshot.session } };
      save();
      for (const listener of listeners) listener(structuredClone(event));
    });
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {},
      onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getModelSettings: async () => ({ ok: true, result: { providers: [] } }),
      listSessions: async () => ({ ok: true, result: { items: [structuredClone(snapshot.session)] } }),
      subscribeSession: async () => ({ ok: true, result: { sessionId: "s", subscriptionId: "sub" } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async () => ({ ok: true, result: structuredClone(snapshot) }),
      renameSession: async ({ title }: { title: string }) => {
        snapshot.session.title = title; save();
        return { ok: true, result: { session: structuredClone(snapshot.session) } };
      },
    } } });
  });
  await page.goto("/chat");
  const list = page.getByRole("complementary", { name: "会话列表" });
  await expect(list.getByRole("button", { name: "重命名会话：新会话", exact: true })).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-user-persisted")));
  await expect(list.getByRole("button", { name: "重命名会话：检查播放器连接", exact: true })).toBeVisible();
  await list.getByRole("button", { name: "重命名会话：检查播放器连接", exact: true }).click();
  await page.getByRole("textbox", { name: "会话名称" }).fill("播放器排查记录");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(list.getByRole("button", { name: "重命名会话：播放器排查记录", exact: true })).toBeVisible();
  await page.reload();
  await expect(list.getByRole("button", { name: "重命名会话：播放器排查记录", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
