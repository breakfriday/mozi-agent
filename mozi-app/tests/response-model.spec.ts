import { expect, test } from "@playwright/test";
import type { SessionSnapshot, StartRunInput } from "../../shared/agent";

test("answer badges use only response evidence, update from events, and survive reloading history", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (/Maximum update depth|getSnapshot should be cached/i.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript(() => {
    const timestamp = "2026-10-06T00:00:00.000Z";
    const selected = { providerId: "bailian-tp", modelId: "requested-model-only" };
    const initial: SessionSnapshot = {
      session: { sessionId: "s", title: "模型对比", model: selected, createdAt: timestamp, updatedAt: timestamp },
      lastSeq: 0, tools: [], approvals: [],
      runs: [{ id: "past", sessionId: "s", userMessageId: "user-past", status: "completed", model: selected, createdAt: timestamp, updatedAt: timestamp }],
      messages: [
        { id: "reported", runId: "past", sessionId: "s", role: "assistant", status: "completed", responseModelId: "server-reported-v1", content: [{ id: "p1", type: "text", text: "带服务商模型信息的回答" }] },
        { id: "unreported", runId: "past", sessionId: "s", role: "assistant", status: "completed", content: [{ id: "p2", type: "text", text: "没有服务商模型信息的回答" }] },
      ],
    };
    const snapshot: SessionSnapshot = JSON.parse(localStorage.getItem("response-model-fixture") || "null") ?? initial;
    sessionStorage.setItem("mozi.agent.sessionId", "s");
    const save = () => localStorage.setItem("response-model-fixture", JSON.stringify(snapshot));
    const listeners = new Set<(event: unknown) => void>();
    const emit = (type: string, data: unknown, runId: string) => {
      snapshot.lastSeq++;
      for (const listener of listeners) listener({ protocolVersion: 1, kind: "event", sessionId: "s", runId, seq: snapshot.lastSeq, type, data });
    };
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: "ready" } }),
      onRuntimeState: () => () => {},
      onEvent: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getModelSettings: async () => ({ ok: true, result: { defaultModel: selected, providers: [{
        id: "bailian-tp", name: "百炼 Token Plan", source: "extension", configured: true,
        baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions",
        endpointLocked: true, removable: false, customModels: [],
        models: [{ id: selected.modelId, name: "Selected Model", contextWindow: 32000, maxTokens: 4096, reasoning: false, vision: false }],
      }] } }),
      listSessions: async () => ({ ok: true, result: { items: [snapshot.session] } }),
      subscribeSession: async () => ({ ok: true, result: { sessionId: "s", subscriptionId: "sub" } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async () => ({ ok: true, result: structuredClone(snapshot) }),
      startRun: async (input: StartRunInput) => {
        const runId = "new-run";
        const user = { id: "new-user", sessionId: "s", runId, clientMessageId: input.clientMessageId,
          role: "user" as const, status: "completed" as const, content: input.content.map((part, index) => ({ ...part, id: `user-${index}` })) };
        const assistant = { id: "new-answer", sessionId: "s", runId, role: "assistant" as const, status: "completed" as const,
          responseModelId: "server-reported-v2", content: [{ id: "answer-part", type: "text" as const, text: "新的服务商回答" }] };
        const run = { id: runId, sessionId: "s", userMessageId: user.id, status: "completed" as const, model: selected, createdAt: timestamp, updatedAt: timestamp };
        snapshot.messages.push(user, assistant); snapshot.runs.push(run);
        emit("message.accepted", { message: user }, runId);
        emit("message.started", { messageId: assistant.id, role: "assistant" }, runId);
        emit("message.text.delta", { messageId: assistant.id, partId: "answer-part", delta: "新的服务商回答" }, runId);
        emit("message.model.reported", { messageId: assistant.id, responseModelId: assistant.responseModelId }, runId);
        emit("message.completed", { messageId: assistant.id, content: assistant.content }, runId);
        emit("run.updated", { run }, runId);
        emit("run.finished", { status: "completed" }, runId);
        save();
        return { ok: true, result: { sessionId: "s", runId, messageId: user.id, clientMessageId: input.clientMessageId, disposition: "accepted" } };
      },
    } } });
  });
  await page.goto("/mozi_app/chat");
  const badges = page.getByLabel("服务商返回模型", { exact: true });
  await expect(page.getByText("没有服务商模型信息的回答", { exact: true })).toBeVisible();
  await expect(badges).toHaveText(["server-reported-v1"]);
  await page.getByRole("textbox", { name: "消息内容" }).fill("比较下一条回答");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(badges).toHaveText(["server-reported-v1", "server-reported-v2"]);
  await expect(page.getByText("新的服务商回答", { exact: true })).toBeVisible();
  await page.reload();
  await expect(badges).toHaveText(["server-reported-v1", "server-reported-v2"]);
  await expect(page.getByText("没有服务商模型信息的回答", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/mozi-response-model-badges.png" });
  expect(errors).toEqual([]);
});
