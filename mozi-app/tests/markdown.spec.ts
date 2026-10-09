import { expect, test } from "@playwright/test";
import type { AgentEvent, SessionSnapshot } from "../../shared/agent";

for (const width of [1280, 560]) {
  test(`official MarkdownText renders streamed tables and math at ${width}px and after reload`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const at = "2026-10-10T00:00:00.000Z";
      const reasoning =
        "先检查公式 $a^2+b^2=c^2$。\n\n| 步骤 | 状态 |\n| --- | --- |\n| 检查 | 完成 |";
      const prefix =
        "## 计算结果\n\n| 项目 | 数值 |\n| :--- | ---: |\n| 均值 | 42 |\n\n行内公式 $E = mc^2$，另一种格式 \\(x^2 + y^2";
      const complete =
        prefix +
        " = 1\\)。\n\n$$\n\\frac{1}{n}\\sum_{i=1}^{n} x_i\n$$\n\n\\[\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\\]\n\n- [x] 表格已完成\n- [ ] 等待确认\n\n~~旧结果~~\n\n```ts\nconst raw = String.raw`\\(x^2\\)`;\nconst price = '$5';\n```\n\n```math\n\\int_0^1 x^2\\,dx\n```\n\n错误公式仍可显示：$\\frac{1}{$\n\n完成。";
      const snapshot: SessionSnapshot = JSON.parse(
        localStorage.getItem("markdown-fixture") || "null",
      ) ?? {
        session: {
          sessionId: "s",
          title: "Markdown 验证",
          createdAt: at,
          updatedAt: at,
        },
        lastSeq: 0,
        messages: [
          {
            id: "a",
            sessionId: "s",
            runId: "r",
            role: "assistant",
            status: "streaming",
            content: [
              { id: "reasoning", type: "reasoning", text: reasoning },
              { id: "text", type: "text", text: prefix },
            ],
          },
        ],
        runs: [
          {
            id: "r",
            sessionId: "s",
            userMessageId: "u",
            status: "running",
            createdAt: at,
            updatedAt: at,
          },
        ],
        tools: [],
        approvals: [],
      };
      sessionStorage.setItem("mozi.agent.sessionId", "s");
      const listeners = new Set<(event: AgentEvent) => void>();
      const save = () =>
        localStorage.setItem("markdown-fixture", JSON.stringify(snapshot));
      const emit = (payload: Pick<AgentEvent, "type" | "data">) => {
        const event = {
          protocolVersion: 1,
          kind: "event",
          sessionId: "s",
          runId: "r",
          seq: ++snapshot.lastSeq,
          ...payload,
        } as AgentEvent;
        listeners.forEach((listener) => listener(structuredClone(event)));
        save();
      };
      window.addEventListener("markdown-continue", () => {
        snapshot.messages[0].content[1].text = complete;
        emit({
          type: "message.text.delta",
          data: {
            messageId: "a",
            partId: "text",
            delta: complete.slice(prefix.length),
          },
        });
      });
      window.addEventListener("markdown-finish", () => {
        snapshot.messages[0].status = "completed";
        snapshot.runs[0].status = "completed";
        emit({
          type: "message.completed",
          data: { messageId: "a", content: snapshot.messages[0].content },
        });
        emit({ type: "run.finished", data: { status: "completed" } });
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            localStorage.setItem("copied-markdown", value);
          },
        },
      });
      Object.assign(window, {
        mozi: {
          agent: {
            getRuntimeState: async () => ({
              ok: true,
              result: { state: "ready" },
            }),
            onRuntimeState: () => () => {},
            onEvent: (listener: (event: AgentEvent) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            getModelSettings: async () => ({
              ok: true,
              result: { providers: [] },
            }),
            listSessions: async () => ({
              ok: true,
              result: { items: [snapshot.session] },
            }),
            subscribeSession: async () => ({
              ok: true,
              result: { sessionId: "s", subscriptionId: "sub" },
            }),
            unsubscribeSession: async () => ({
              ok: true,
              result: { removed: true },
            }),
            getSessionSnapshot: async () => ({
              ok: true,
              result: structuredClone(snapshot),
            }),
          },
        },
      });
    });
    await page.goto("/mozi_app/chat");
    const body = page
      .locator(".aui-md")
      .filter({ has: page.getByRole("heading", { name: "计算结果" }) });
    await expect(body.getByRole("table")).toBeVisible();
    await expect(body.locator(".katex")).toHaveCount(1);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("markdown-continue")),
    );
    await expect(body.getByText("完成。", { exact: true })).toBeVisible();
    await expect(body.locator(".katex")).toHaveCount(5);
    await expect(body.locator(".katex-error")).toHaveCount(1);
    await expect(body.getByRole("checkbox")).toHaveCount(2);
    await expect(body.getByRole("checkbox").first()).toBeChecked();
    await expect(body.locator("del")).toHaveText("旧结果");
    await expect(body.locator("pre code")).toHaveText(
      "const raw = String.raw`\\(x^2\\)`;\nconst price = '$5';",
    );
    await body.getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(
      body.getByRole("button", { name: "已复制", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("copied-markdown")),
    ).toContain("String.raw`\\(x^2\\)`");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("markdown-finish")),
    );
    await expect(page.getByText("正在生成回复…", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "思考过程" }).click();
    const reasoning = page.locator('[data-slot="reasoning-root"]');
    await expect(reasoning.getByRole("table")).toBeVisible();
    await expect(reasoning.locator(".katex")).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(overflow).toBe(false);
    const themeColors = () => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      dark: document.documentElement.classList.contains("dark"),
      tableBackground: getComputedStyle(document.querySelector(".aui-md-th")!).backgroundColor,
    }));
    await expect.poll(themeColors).toEqual({ theme: "dark", dark: true, tableBackground: "rgb(38, 38, 38)" });
    await page.screenshot({
      path: `/tmp/mozi-markdown-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("switch", { name: "切换主题" }).click();
    await expect.poll(themeColors).toEqual({ theme: "light", dark: false, tableBackground: "rgb(247, 247, 247)" });
    await expect(page.locator(".ant-select").first()).toHaveCSS("background-color", "rgb(247, 247, 247)");
    await page.screenshot({ path: `/tmp/mozi-markdown-light-${width}.png`, fullPage: true });
    await page.reload();
    await expect(body.getByRole("table")).toBeVisible();
    await expect(body.locator(".katex")).toHaveCount(5);
    await expect.poll(themeColors).toEqual({ theme: "light", dark: false, tableBackground: "rgb(247, 247, 247)" });
    expect(errors).toEqual([]);
  });
}
