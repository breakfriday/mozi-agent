import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_OPERATION_SCHEMA,
  BrowserFailure,
  isBrowserOperation,
  type BrowserCall,
} from "../../../../../shared/browser";

import { BROWSER_GUIDELINES } from "./sessions/prompt/browser-guidelines";

export { BROWSER_GUIDELINES };

export const BROWSER_TOOL_NAME = "mozi_browser";

/** Pi owns tool execution; this adapter only converts the browser boundary into tools. */
export function createBrowserTool(
  call: BrowserCall,
  sessionId: string,
  getRunId: () => string | undefined,
): ToolDefinition {
  return {
    name: BROWSER_TOOL_NAME,
    label: "Mozi 浏览器",
    description: `
操作 MoziBrowser（墨子浏览器）页面，通过 action 选择操作。支持后台交互，无需用户将窗口置前；用户也可手动导航该窗口。

支持的操作：
- search：通过 Bing 搜索互联网。必填 query，可选 limit；返回标题、链接和摘要，不代表已读取来源正文。
- read：提取当前页面已加载 DOM 中的正文，返回真实 URL、标题、content 和 truncated。传 url 打开指定网址；或传 target=current 读取当前页面，不导航、不刷新。url 和 target 二选一，没有当前页面时返回错误。不自动遍历分页、展开折叠内容或加载全部列表；truncated=true 表示正文超出返回长度限制。
- inspect：列出当前页面匹配的可交互元素及 elementId。可选 query 按名称或占位提示过滤，可选 filter=inputs 仅查看输入控件。返回控件状态、placeholder、hasValue 等信息，不返回输入值；truncated=true 表示匹配元素未全部返回，应缩小筛选范围。
- click：点击 elementId 指定的元素，支持页面链接、按钮和菜单。
- fill：用 text 替换 elementId 指定输入框的全部内容；空字符串清空，不提交。成功返回 inputVerified=true。
- press：向 elementId 指定的元素发送 key 按键，支持 Enter、Tab、Escape、ArrowUp、ArrowDown、ArrowLeft、ArrowRight。

交互约束：
- elementId 必须来自最新 inspect；每次 click/fill/press 尝试后，整组旧编号失效。
- click/press 支持 expect={elementId,text}，提供时执行前核对指定输入框的实际文本，不匹配则拒绝操作。站内搜索提交必须主动携带 expect；普通点击可省略。
- dispatched 仅表示事件已发送，不代表业务成功。
`,
    promptSnippet: "通过 Mozi 浏览器搜索互联网、读取当前已加载的网页内容并后台操作页面元素。",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: BROWSER_OPERATION_SCHEMA,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate) {
      if (!isBrowserOperation(params))
        throw new BrowserFailure(
          "INVALID_ARGUMENT",
          "请按操作提供参数：search + query；read + url 或 target=current；inspect 可选 query/filter；click + elementId；fill + elementId + text；press + elementId + key；click/press 提交站内搜索携带 expect={elementId,text}。不同操作参数不能混用。",
        );
      const runId = getRunId();
      if (!runId)
        throw new BrowserFailure(
          "UNAVAILABLE",
          "浏览器工具需要当前 Run 上下文。",
        );
      const result = await call(params, {
        sessionId,
        runId,
        toolCallId,
        signal: signal ?? new AbortController().signal,
        onProgress: (progress) =>
          onUpdate?.({
            content: [{ type: "text", text: progress.message }],
            details: progress,
          }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
