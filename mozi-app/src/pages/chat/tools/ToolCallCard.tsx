import { useAgentStore } from "@/agent/agentStore";
import type { ToolView } from "../../../../../shared/agent";
import styles from "./tool-call.module.css";

const labels: Record<ToolView["status"], string> = {
  preparing: "准备执行", awaiting_approval: "等待批准", running: "执行中",
  succeeded: "执行成功", failed: "执行失败", denied: "已拒绝", cancelled: "已取消", interrupted: "执行中断",
};

export function ToolCallCard({ toolCallId }: { toolCallId: string }) {
  const tool = useAgentStore(state => state.tools.find(item => item.toolCallId === toolCallId));
  if (!tool) return null;
  let target = "";
  try {
    const args = JSON.parse(tool.inputText);
    if (args && typeof args === "object") {
      const value = args.path ?? args.command;
      if (typeof value === "string") target = value;
    }
  } catch { /* Truncated arguments remain available in the disclosure. */ }
  const failed = tool.status === "failed" || tool.status === "denied";
  const running = tool.status === "running" || tool.status === "preparing";
  return (
    <details className={styles.card} data-tool-call-id={toolCallId} data-status={tool.status}>
      <summary className={styles.heading}>
        <span className={styles.name}>{tool.toolName}</span>
        {target && <span className={styles.target} title={target}>{target}</span>}
        <span className={failed ? styles.error : styles.status} role={failed ? "alert" : "status"}>
          {running && <span className={styles.spinner} aria-hidden="true" />}{labels[tool.status]}
        </span>
      </summary>
      <div className={styles.body}>
        <div className={styles.label}>参数</div>
        <pre>{tool.inputText}</pre>
        {tool.summary && <p>{tool.summary}</p>}
        <div className={styles.label}>{failed ? "错误信息" : "输出"}</div>
        <pre>{tool.outputText || (running ? "等待工具输出…" : "无文本输出")}</pre>
        {tool.outputTruncated && <p>输出过长，仅显示前部分内容。</p>}
      </div>
    </details>
  );
}
