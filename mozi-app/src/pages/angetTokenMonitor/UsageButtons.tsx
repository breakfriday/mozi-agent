import { BarChartOutlined } from "@ant-design/icons";
import { useAgentStore } from "@/agent/agentStore";
import { isTerminalRun } from "@/agent/agentState";
import { messageKey } from "@/agent/submissionState";
import { useElapsed, compact, seconds } from "./format";
import styles from "./token-monitor.module.css";

export function TokenMonitorButton({ onOpen }: { onOpen: () => void }) {
  const total = useAgentStore(state => state.usage?.total);
  return <button type="button" className={styles.entry} onClick={onOpen} aria-label="查看会话用量">
    <BarChartOutlined /> 用量 <span className={styles.tokenValue} data-known={!!total?.reportedCalls}>{total?.reportedCalls ? compact(total.totalTokens) : "—"} token</span>
  </button>;
}

/** One summary at the last displayed message of a Run, including failed runs with no answer. */
export function RunUsageSummary({ messageId, onOpen }: { messageId: string; onOpen: (runId: string) => void }) {
  const runId = useAgentStore(state => state.messages.find(message => messageKey(message) === messageId)?.runId);
  const lastId = useAgentStore(state => {
    const last = runId ? state.messages.filter(message => message.runId === runId).at(-1) : undefined;
    return last ? messageKey(last) : undefined;
  });
  const run = useAgentStore(state => state.runs.find(item => item.id === runId));
  const total = useAgentStore(state => state.usage?.runs.find(item => item.runId === runId)?.total);
  const elapsed = useElapsed(lastId === messageId ? run : undefined);
  if (!runId || lastId !== messageId || !run) return null;
  const active = !isTerminalRun(run.status);
  const label = total?.reportedCalls ? `${active || total.unknownCalls ? "已确认" : "本次用量"} ${compact(total.totalTokens)} token`
    : active ? "等待用量返回" : "用量未返回";
  return <button type="button" className={styles.runSummary} onClick={() => onOpen(runId)} aria-label="查看本次指令用量">
    <BarChartOutlined /><span className={styles.tokenValue} data-known={!!total?.reportedCalls}>{label}</span>
    {total?.reasoning !== undefined && <span className={styles.tokenValue} data-known="true">其中推理 {compact(total.reasoning)} token</span>}
    <span>应用侧请求 {total?.calls ?? 0} 次</span><span>{seconds(elapsed)}</span><span className={styles.link}>详情 →</span>
  </button>;
}
