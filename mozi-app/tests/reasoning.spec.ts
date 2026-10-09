import { expect, test } from "@playwright/test";
import type { AgentEvent, MessageView, SessionSnapshot, StartRunInput } from "../../shared/agent";

for (const outcome of ["completed", "cancelled"] as const) {
  test(`reasoning streams in a collapsible part and survives ${outcome} and reload`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const timestamp = "2026-10-09T00:00:00.000Z";
      const selected = { providerId: "fixture", modelId: "reasoning-model" };
      const initial: SessionSnapshot = {
        session: { sessionId: "s", title: "思考展示", model: selected, createdAt: timestamp, updatedAt: timestamp },
        lastSeq: 0, messages: [], runs: [], tools: [], approvals: [],
      };
      const snapshot: SessionSnapshot = JSON.parse(localStorage.getItem("reasoning-fixture") || "null") ?? initial;
      sessionStorage.setItem("mozi.agent.sessionId", "s");
      const listeners = new Set<(event: AgentEvent) => void>();
      const save = () => localStorage.setItem("reasoning-fixture", JSON.stringify(snapshot));
      const emit = (payload: Pick<AgentEvent, "type" | "data">) => {
        const event = { protocolVersion: 1, kind: "event", sessionId: "s", runId: "r", seq: ++snapshot.lastSeq, ...payload } as AgentEvent;
        for (const listener of listeners) listener(structuredClone(event));
        save();
      };
      const finish = (status: "completed" | "cancelled") => {
        const assistant = snapshot.messages.at(-1)!;
        if (status === "completed") {
          assistant.content[0].text = "先检查连接，再核对日志。";
          assistant.content[2].text = "连接正常，可以继续操作。";
          emit({ type: "message.completed", data: { messageId: assistant.id, content: assistant.content } });
        }
        assistant.status = status;
        snapshot.runs[0].status = status;
        emit({ type: "run.updated", data: { run: snapshot.runs[0] } });
        emit({ type: "run.finished", data: { status } });
      };
      window.addEventListener("reasoning-continue", () => {
        const assistant = snapshot.messages.at(-1)!;
        assistant.content[0].text += "，再核对日志";
        emit({ type: "message.reasoning.delta", data: { messageId: assistant.id, partId: "a:reasoning:0", delta: "，再核对日志" } });
        assistant.content.push({ id: "a:reasoning:1", type: "reasoning", text: "**随后复核结果。**" });
        emit({ type: "message.reasoning.delta", data: { messageId: assistant.id, partId: "a:reasoning:1", delta: "**随后复核结果。**" } });
        assistant.content.push({ id: "a:text:2", type: "text", text: "连接正常" });
        emit({ type: "message.text.delta", data: { messageId: assistant.id, partId: "a:text:2", delta: "连接正常" } });
      });
      window.addEventListener("reasoning-finish", () => finish("completed"));
      Object.assign(window, { mozi: { agent: {
        getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
        onRuntimeState: () => () => {},
        onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        getModelSettings: async () => ({ ok: true, result: { defaultModel: selected, providers: [{
          id: "fixture", name: "测试模型", source: "custom", configured: true, baseUrl: "https://example.com/v1",
          api: "openai-completions", endpointLocked: false, removable: true, customModels: [],
          models: [{ id: selected.modelId, name: "Reasoning Model", contextWindow: 32000, maxTokens: 4096, reasoning: true, vision: false }],
        }] } }),
        listSessions: async () => ({ ok: true, result: { items: [snapshot.session] } }),
        subscribeSession: async () => ({ ok: true, result: { sessionId: "s", subscriptionId: "sub" } }),
        unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
        getSessionSnapshot: async () => ({ ok: true, result: structuredClone(snapshot) }),
        cancelRun: async () => { finish("cancelled"); return { ok: true, result: { sessionId: "s", runId: "r", disposition: "requested" } }; },
        startRun: async (input: StartRunInput) => {
          const user: MessageView = { id: "u", sessionId: "s", runId: "r", clientMessageId: input.clientMessageId,
            role: "user", status: "completed", content: input.content.map((part, i) => ({ ...part, id: `u:text:${i}` })) };
          const assistant: MessageView = { id: "a", sessionId: "s", runId: "r", role: "assistant", status: "streaming", content: [] };
          snapshot.messages.push(user, assistant);
          snapshot.runs.push({ id: "r", sessionId: "s", userMessageId: "u", status: "running", createdAt: timestamp, updatedAt: timestamp });
          emit({ type: "run.updated", data: { run: snapshot.runs[0] } });
          emit({ type: "message.accepted", data: { message: user } });
          emit({ type: "message.started", data: { messageId: "a", role: "assistant" } });
          assistant.content.push({ id: "a:reasoning:0", type: "reasoning", text: "先检查连接" });
          emit({ type: "message.reasoning.delta", data: { messageId: "a", partId: "a:reasoning:0", delta: "先检查连接" } });
          return { ok: true, result: { sessionId: "s", runId: "r", messageId: "u", clientMessageId: input.clientMessageId, disposition: "accepted" } };
        },
      } } });
    });
    await page.goto("/mozi_app/chat");
    await expect(page.getByText("已连接 Agent", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "消息内容" }).fill("检查连接");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const reasoning = page.locator('[data-slot="reasoning-root"]');
    const trigger = reasoning.getByRole("button");
    await expect(reasoning).toHaveCount(1);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveText("正在思考");
    await expect(reasoning.getByText("先检查连接", { exact: true })).toBeVisible();
    if (outcome === "cancelled") {
      // A manual collapse takes ownership even as more reasoning streams in.
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
    }
    await page.evaluate(() => window.dispatchEvent(new Event("reasoning-continue")));
    // Reasoning ends when the text part begins, before the whole Run completes.
    await expect(trigger).toHaveText("思考过程");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(reasoning).toHaveCount(1); // Consecutive reasoning parts share a disclosure.
    await trigger.click();
    await expect(reasoning.getByText("先检查连接，再核对日志", { exact: true })).toBeVisible();
    await expect(reasoning.locator("strong")).toHaveText("随后复核结果。");
    await expect(page.getByText("连接正常", { exact: true })).toBeVisible();
    if (outcome === "completed") await page.evaluate(() => window.dispatchEvent(new Event("reasoning-finish")));
    else await page.getByRole("button", { name: "停止生成", exact: true }).click();
    const thought = outcome === "completed" ? "先检查连接，再核对日志。" : "先检查连接，再核对日志";
    const answer = outcome === "completed" ? "连接正常，可以继续操作。" : "连接正常";
    await expect(reasoning.getByText(thought, { exact: true })).toBeVisible();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    if (outcome === "cancelled") await expect(page.getByText("已停止生成", { exact: true })).toBeVisible();
    await page.reload();
    await expect(reasoning).toHaveCount(1);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(reasoning.getByText(thought, { exact: true })).toBeVisible();
    await expect(page.getByText(answer, { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/mozi-official-reasoning-${outcome}.png` });
    expect(errors).toEqual([]);
  });
}
