import { expect, test } from "@playwright/test";
import type { AgentEvent, SessionSnapshot, ToolOutcome } from "../../shared/agent";

for (const outcome of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
  test(`tool cards show real output and ${outcome} after reload`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const at = "2026-10-17T00:00:00.000Z";
      const model = { providerId: "fixture", modelId: "model" };
      const initial: SessionSnapshot = {
        session: { sessionId: "s", title: "工具执行", model, createdAt: at, updatedAt: at },
        lastSeq: 0, approvals: [], tools: [],
        runs: [{ id: "r", sessionId: "s", userMessageId: "u", status: "running", createdAt: at, updatedAt: at }],
        messages: [
          { id: "u", sessionId: "s", runId: "r", role: "user", status: "completed", content: [{ id: "u:text:0", type: "text", text: "读取项目文件" }] },
          { id: "a", sessionId: "s", runId: "r", role: "assistant", status: "completed", content: [
            { id: "a:text:0", type: "text", text: "开始检查文件。" }, { id: "a:text:2", type: "text", text: "文件检查步骤。" },
          ] },
        ],
      };
      const snapshot: SessionSnapshot = JSON.parse(localStorage.getItem("tool-fixture") || "null") ?? initial;
      sessionStorage.setItem("mozi.agent.sessionId", "s");
      const listeners = new Set<(event: AgentEvent) => void>();
      const emit = (payload: Pick<AgentEvent, "type" | "data">) => {
        const event = { protocolVersion: 1, kind: "event", sessionId: "s", runId: "r", seq: ++snapshot.lastSeq, ...payload } as AgentEvent;
        for (const listener of listeners) listener(structuredClone(event));
        localStorage.setItem("tool-fixture", JSON.stringify(snapshot));
      };
      window.addEventListener("tool-start", () => {
        snapshot.tools.push({ toolCallId: "call-1", messageId: "a", partIndex: 1, runId: "r", toolName: "read", status: "running",
          inputText: '{"path":"/project/package.json"}', outputText: "", outputTruncated: false });
        emit({ type: "tool.updated", data: { tool: snapshot.tools[0] } });
      });
      window.addEventListener("tool-progress", () => {
        snapshot.tools[0].outputText = "first line\nsecond line";
        emit({ type: "tool.updated", data: { tool: snapshot.tools[0] } });
      });
      const finish = (outcome: ToolOutcome) => {
        const tool = snapshot.tools[0];
        tool.status = outcome;
        if (outcome === "succeeded") tool.outputText = '{"name":"mozi-agent"}';
        if (outcome === "failed") tool.outputText = "ENOENT: /project/package.json\n<script>alert('unsafe')</script>";
        tool.outputTruncated = outcome === "succeeded";
        if (outcome === "succeeded" || outcome === "failed") emit({ type: "tool.completed", data: { toolCallId: tool.toolCallId, outcome, tool } });
        const status = outcome === "cancelled" ? "cancelled" : outcome === "interrupted" ? "interrupted" : "completed";
        snapshot.runs[0].status = status;
        emit({ type: "run.updated", data: { run: snapshot.runs[0] } });
        emit({ type: "run.finished", data: status === "interrupted" ? { status, reason: "后台进程已退出" } : { status } });
      };
      window.addEventListener("tool-finish", event => finish((event as CustomEvent<ToolOutcome>).detail));
      Object.assign(window, { mozi: { agent: {
        getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
        onRuntimeState: () => () => {},
        onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        getModelSettings: async () => ({ ok: true, result: { defaultModel: model, providers: [] } }),
        listSessions: async () => ({ ok: true, result: { items: [snapshot.session] } }),
        subscribeSession: async () => ({ ok: true, result: { sessionId: "s", subscriptionId: "sub" } }),
        unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
        getSessionSnapshot: async () => ({ ok: true, result: structuredClone(snapshot) }),
        cancelRun: async () => { finish("cancelled"); return { ok: true, result: { sessionId: "s", runId: "r", disposition: "requested" } }; },
      } } });
    });
    await page.goto("/mozi_app/chat");
    await expect(page.getByText("开始检查文件。", { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("tool-start")));
    const card = page.locator('[data-tool-call-id="call-1"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-status", "running");
    await expect(card.getByText("执行中", { exact: true })).toBeVisible();
    await card.locator("summary").click();
    await expect(card.getByText("等待工具输出…", { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("tool-progress")));
    await expect(card.locator("pre").last()).toHaveText("first line\nsecond line");
    // Tool part stays between the text blocks that surround it in the native message.
    const positions = await page.evaluate(() => {
      const card = document.querySelector('[data-tool-call-id="call-1"]')!;
      const paragraphs = [...document.querySelectorAll("p")];
      return [paragraphs.find(p => p.textContent === "开始检查文件。")!, card, paragraphs.find(p => p.textContent === "文件检查步骤。")!]
        .map(node => node.getBoundingClientRect().top);
    });
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    if (outcome === "cancelled") await page.getByRole("button", { name: "停止生成", exact: true }).click();
    else await page.evaluate(outcome => window.dispatchEvent(new CustomEvent("tool-finish", { detail: outcome })), outcome);
    await expect(card).toHaveAttribute("data-status", outcome);
    const label = { succeeded: "执行成功", failed: "执行失败", cancelled: "已取消", interrupted: "执行中断" }[outcome];
    await expect(card.getByText(label, { exact: true })).toBeVisible();
    if (outcome === "failed") await expect(card.getByRole("alert")).toHaveText("执行失败");
    if (outcome === "succeeded") await expect(card.getByText("输出过长，仅显示前部分内容。", { exact: true })).toBeVisible();
    await page.reload();
    await expect(card).toHaveAttribute("data-status", outcome);
    await expect(card.getByText(label, { exact: true })).toBeVisible();
    await card.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(card.locator("pre").last()).toContainText(outcome === "succeeded" ? '"name":"mozi-agent"' : outcome === "failed" ? "ENOENT" : "second line");
    if (outcome === "failed") {
      await expect(card.locator("script")).toHaveCount(0);
      await page.screenshot({ path: "/tmp/mozi-tool-failure.png", fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}
