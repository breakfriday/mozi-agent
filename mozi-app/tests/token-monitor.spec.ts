import { expect, test } from "@playwright/test";
import type { ModelCallView, SessionSnapshot, UsageMonitorView, UsageTotals } from "../../shared/agent";

// Independent fixture totals: the UI must use the backend's numbers, not sum them again.
function buildUsageMonitor(calls: ModelCallView[]): UsageMonitorView {
  const empty: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    calls: 0, reportedCalls: 0, pendingCalls: 0, unknownCalls: 0, reasoningCalls: 0 };
  if (!calls.length) return { calls, total: empty, runs: [] };
  const known = { ...empty, input: 600, output: 300, cacheRead: 400, totalTokens: 1300, reasoning: 200,
    calls: 1, reportedCalls: 1, reasoningCalls: 1, webSearch: 2, webExtractor: 1 };
  const other = { ...empty, calls: 1, pendingCalls: calls[1]?.status === "running" ? 1 : 0,
    unknownCalls: calls[1]?.status === "cancelled" ? 1 : 0 };
  return { calls, total: { ...known, calls: calls.length, pendingCalls: calls.length > 1 ? other.pendingCalls : 0,
    unknownCalls: calls.length > 1 ? other.unknownCalls : 0 }, runs: [{ runId: "r", total: known }, ...(calls.length > 1 ? [{ runId: "r2", total: other }] : [])] };
}

const timestamp = "2026-10-11T00:00:00.000Z";
const selected = { providerId: "bailian-tp", modelId: "qwen-fixture", thinkingLevel: "medium" as const };
const call: ModelCallView = { id: "call-1", runId: "r", provider: "fixture", model: "qwen-fixture", responseModelId: "server-fixture",
  thinkingLevel: "medium", startedAt: timestamp, durationMs: 2400, status: "completed", webSearch: 2, webExtractor: 1,
  webSearchSource: "provider", webExtractorSource: "events",
  steps: [
    { id: "thought", type: "reasoning", status: "completed", observed: "stream" },
    { id: "search", type: "web_search", status: "completed", observed: "stream", queries: ["合肥 2026年9月 历史天气", "合肥逐日气温"], sources: ["https://example.com/weather", "https://example.com/history"] },
    { id: "extract", type: "web_extractor", status: "completed", observed: "stream", urls: ["https://example.com/history"] },
    { id: "answer", type: "message", status: "completed", observed: "final" },
  ],
  usage: { input: 600, cacheRead: 400, cacheWrite: 0, output: 300, reasoning: 200, totalTokens: 1300 } };
const first: SessionSnapshot = { session: { sessionId: "s", title: "天气分析", model: selected, createdAt: timestamp, updatedAt: timestamp }, lastSeq: 0,
  tools: [], approvals: [], usage: buildUsageMonitor([call]),
  runs: [{ id: "r", sessionId: "s", userMessageId: "u", model: selected, status: "completed", createdAt: timestamp, updatedAt: "2026-10-11T00:00:03.000Z" }],
  messages: [
    { id: "u", sessionId: "s", runId: "r", role: "user", status: "completed", content: [{ id: "u0", type: "text", text: "查询上个月合肥天气" }] },
    { id: "a", sessionId: "s", runId: "r", role: "assistant", status: "completed", responseModelId: "server-fixture", content: [{ id: "a0", type: "text", text: "已找到历史天气来源，可以继续核对逐日数据。" }] },
  ] };
const second: SessionSnapshot = { session: { sessionId: "s2", title: "另一段会话", model: selected, createdAt: timestamp, updatedAt: timestamp }, lastSeq: 0,
  tools: [], approvals: [], runs: [], messages: [], usage: buildUsageMonitor([]) };
const pending: ModelCallView = { ...call, id: "call-2", runId: "r2", status: "running", usage: undefined, durationMs: undefined,
  webSearch: undefined, webExtractor: undefined, webSearchSource: undefined, webExtractorSource: undefined, steps: undefined };
const finished: ModelCallView = { ...pending, status: "cancelled", durationMs: 1000 };

test.beforeEach(async ({ context }) => {
  await context.addInitScript(({ first, second, pending, finished, pendingMonitor, finishedMonitor }) => {
    if (!location.origin.startsWith("http")) return;
    const snapshots: Record<string, SessionSnapshot> = JSON.parse(localStorage.getItem("usage-fixtures") || "null") ?? { s: first, s2: second };
    if (!sessionStorage.getItem("mozi.agent.sessionId")) sessionStorage.setItem("mozi.agent.sessionId", "s");
    const listeners = new Set<(event: unknown) => void>();
    const channel = new BroadcastChannel("usage-fixture-events");
    channel.onmessage = ({ data }) => {
      Object.assign(snapshots, JSON.parse(localStorage.getItem("usage-fixtures") || "{}"));
      for (const listener of listeners) listener(data);
    };
    const save = () => localStorage.setItem("usage-fixtures", JSON.stringify(snapshots));
    const emit = (type: string, data: unknown) => {
      const snapshot = snapshots.s;
      const event = { protocolVersion: 1, kind: "event", sessionId: "s", runId: "r2", seq: ++snapshot.lastSeq, type, data };
      for (const listener of listeners) listener(event);
      channel.postMessage(event);
    };
    const complete = () => {
      const snapshot = snapshots.s;
      snapshot.usage = finishedMonitor;
      const run = snapshot.runs.find(item => item.id === "r2")!;
      run.status = "cancelled"; run.updatedAt = new Date().toISOString();
      emit("usage.updated", { call: finished, total: finishedMonitor.total, runTotal: finishedMonitor.runs.find(item => item.runId === "r2")!.total });
      emit("run.updated", { run }); emit("run.finished", { status: "cancelled" }); save();
    };
    Object.assign(window, { completeUsageFixture: complete, mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {},
      onEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getModelSettings: async () => ({ ok: true, result: { defaultModel: first.session.model, providers: [{
        id: "bailian-tp", name: "Fixture", source: "custom", configured: true, baseUrl: "https://example.com/v1", api: "openai-responses",
        endpointLocked: false, removable: true, customModels: [], models: [{ id: "qwen-fixture", name: "Qwen", contextWindow: 32000, maxTokens: 4096,
          reasoning: true, vision: false, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }],
      }] } }),
      listSessions: async () => ({ ok: true, result: { items: Object.values(snapshots).map(item => item.session) } }),
      subscribeSession: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: { sessionId, subscriptionId: `sub-${sessionId}` } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: structuredClone(snapshots[sessionId]) }),
      startRun: async (input: { clientMessageId: string; content: { type: "text"; text: string }[] }) => {
        const snapshot = snapshots.s;
        const run = { id: "r2", sessionId: "s", userMessageId: "u2", model: first.session.model, status: "running" as const,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const user = { id: "u2", sessionId: "s", runId: "r2", clientMessageId: input.clientMessageId, role: "user" as const, status: "completed" as const,
          content: input.content.map((part, index) => ({ ...part, id: `u2-${index}` })) };
        snapshot.runs.push(run); snapshot.messages.push(user); snapshot.usage = pendingMonitor;
        emit("run.updated", { run }); emit("message.accepted", { message: user });
        emit("usage.updated", { call: pending, total: pendingMonitor.total, runTotal: pendingMonitor.runs.find(item => item.runId === "r2")!.total }); save();
        return { ok: true, result: { sessionId: "s", runId: "r2", messageId: "u2", clientMessageId: input.clientMessageId, disposition: "accepted" } };
      },
    } } });
  }, { first, second, pending, finished, pendingMonitor: buildUsageMonitor([call, pending]), finishedMonitor: buildUsageMonitor([call, finished]) });
});

test("independent monitor keeps live session usage when chat switches sessions and survives reload", async ({ page, context }) => {
  const errors: string[] = [];
  context.on("page", p => p.on("pageerror", error => errors.push(error.message)));
  await page.goto("/mozi_app/chat");
  await expect(page.getByRole("button", { name: "查看本次指令用量" })).toContainText("1.3k");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "查看会话用量" }).click();
  const monitor = await opened;
  await expect(monitor).toHaveURL(/angetTokenMonitor\?sessionId=s$/);
  const panel = monitor.getByRole("region", { name: "Agent Token Monitor", exact: true });
  await expect(panel).toContainText("1,300");
  await expect(monitor.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel.locator("summary").click();
  await expect(panel).toContainText("server-fixture");
  await expect(panel).toContainText("合肥 2026年9月 历史天气");
  await expect(panel.getByRole("link", { name: "https://example.com/history", exact: true })).toHaveCount(2);
  await monitor.screenshot({ path: "/tmp/mozi-token-monitor-window.png", fullPage: true });
  await monitor.getByRole("button", { name: "切换主题", exact: true }).click();
  await monitor.getByRole("menuitem", { name: "默认浅色", exact: true }).click();
  await expect(monitor.locator("html")).toHaveAttribute("data-theme", "light");
  await monitor.screenshot({ path: "/tmp/mozi-token-monitor-window-light.png", fullPage: true });
  await monitor.getByRole("button", { name: "切换主题", exact: true }).click();
  await monitor.getByRole("menuitem", { name: "默认深色", exact: true }).click();
  await page.getByRole("textbox", { name: "消息内容" }).fill("测试取消时的用量");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(panel).toContainText("1 次调用进行中");
  await page.evaluate(() => (window as unknown as { completeUsageFixture: () => void }).completeUsageFixture());
  await expect(panel).toContainText("用量不完整：1 次调用未返回统计");
  await page.getByRole("button", { name: "切换会话" }).click();
  await page.getByRole("option").filter({ hasText: "另一段会话" }).click();
  await expect(panel).toContainText("1,300");
  await expect(panel.getByText("天气分析", { exact: true })).toBeVisible();
  await monitor.reload();
  await expect(panel).toContainText("2 次应用侧模型请求 · 1 次已返回用量");
  await panel.getByRole("combobox", { name: "用量统计范围" }).selectOption("r2");
  await expect(monitor).toHaveURL(/runId=r2/);
  await expect(panel).not.toContainText("1,300");
  await panel.locator("summary").click();
  await expect(panel).toContainText("该请求未保存服务端步骤明细。");
  await monitor.close();
  await expect(page.getByRole("heading", { name: "另一段会话", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("instruction entry opens the requested run and monitor fits narrow windows", async ({ page, context }) => {
  await page.goto("/mozi_app/chat");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "查看本次指令用量" }).click();
  const monitor = await opened;
  await monitor.setViewportSize({ width: 390, height: 844 });
  await expect(monitor.getByRole("combobox", { name: "用量统计范围" })).toHaveValue("r");
  await monitor.locator("summary").click();
  await expect(monitor.getByText("合肥逐日气温", { exact: true })).toBeVisible();
  expect(await monitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await monitor.screenshot({ path: "/tmp/mozi-token-monitor-window-mobile.png", fullPage: true });
  await monitor.getByText("服务端步骤", { exact: true }).scrollIntoViewIfNeeded();
  await monitor.screenshot({ path: "/tmp/mozi-token-monitor-window-mobile-steps.png" });
});

test("desktop entry requests a native window through the preload bridge", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { openedMonitor: null, electronAPI: { window: {
      openTokenMonitor: async (target: unknown) => { Object.assign(window, { openedMonitor: target }); return true; },
      getState: async () => ({ isFullScreen: false }), onStateChanged: () => () => {},
    } } });
  });
  await page.goto("/mozi_app/chat");
  await page.getByRole("button", { name: "查看本次指令用量" }).click();
  expect(await page.evaluate(() => (window as unknown as { openedMonitor: unknown }).openedMonitor)).toEqual({ sessionId: "s", runId: "r" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat$/);
});
