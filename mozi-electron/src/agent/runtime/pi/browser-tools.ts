import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_OPERATION_SCHEMA,
  BrowserFailure,
  isBrowserOperation,
  type BrowserCall,
} from "../../../../../shared/browser";

export { BROWSER_GUIDELINES } from "./sessions/prompt/browser-guidelines";

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
    description:
      "操作 MoziBrowser（墨子浏览器）。search + query：在窗口中用 Bing 搜索互联网，返回标题、链接和摘要。" +
      "read + url：打开指定网址并读取正文。read + target=current：直接读取现有窗口当前渲染的页面，返回真实 URL、标题和正文，不刷新、不根据历史猜网址。" +
      "inspect：列出当前页可交互元素及编号；找搜索输入框先用 filter=inputs，不加 query，避免漏掉热词占位框。query 可按名称或占位提示过滤。click + elementId：点击刚刚 inspect 返回的元素，支持 JavaScript 动态链接和按钮。fill + elementId + text：替换输入框全部内容，空字符串清空。press + elementId + key：对元素按键，如 Enter 提交站内搜索。" +
      "inspect 提供输入类型、可编辑/只读状态、placeholder 和 hasValue，不返回输入值；占位热词不代表已输入。fill 成功返回 inputVerified=true。每次 click/fill/press 后整组编号失效，必须重新 inspect 获取编号；操作后需读取/查看页面确认业务结果。" +
      "页面搜索/站内搜索必须先 fill 用户关键词，再重新 inspect，用 click/press 携带 expect={elementId:新输入框编号,text:完整关键词} 提交；不匹配会拦截。普通点击可省略 expect。禁止猜测或拼接搜索 URL 代替页面操作或补救失败。" +
      "用户说‘分析浏览器内容’或‘总结当前页面’时使用 target=current；没有当前页面则报告错误。url 和 target 二选一。",
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
