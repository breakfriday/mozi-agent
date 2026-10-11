import { useEffect } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { agentActions } from "@/agent/agentActions";
import { useAgentStore } from "@/agent/agentStore";
import { AgentTokenMonitor } from "./AgentTokenMonitor";
import { MonitorTag } from "./MonitorTag";
import { CheckCircleOutlined, ExclamationCircleOutlined, ClockCircleOutlined } from "@ant-design/icons";
import styles from "./token-monitor.module.css";

const route = getRouteApi("/angetTokenMonitor");

export function TokenMonitorPage() {
  const { sessionId, runId } = route.useSearch();
  const navigate = route.useNavigate();
  const stateSession = useAgentStore(state => state.sessionId);
  const title = useAgentStore(state => state.sessions.find(session => session.sessionId === sessionId)?.title);
  const sync = useAgentStore(state => state.syncStatus);
  const runtime = useAgentStore(state => state.runtime.state);
  const error = useAgentStore(state => state.error);
  useEffect(() => { void agentActions.activateSession(sessionId || null); }, [sessionId]);
  useEffect(() => { document.title = `${title || "会话用量"} · Agent Token Monitor`; }, [title]);
  return <section className={styles.page} aria-label="Agent Token Monitor">
    <header className={styles.pageHeader}>
      <div><h1>Agent Token Monitor</h1><p>{title || "会话用量"}</p></div>
      <div className={styles.pageActions}><span role="status"><MonitorTag tone={runtime !== "ready" ? "amber" : sync === "ready" ? "green" : sync === "error" ? "red" : "info"}
        icon={runtime !== "ready" || sync === "error" ? <ExclamationCircleOutlined /> : sync === "ready" ? <CheckCircleOutlined /> : <ClockCircleOutlined />}>
        {runtime !== "ready" ? "Agent 未连接" : sync === "ready" ? "已连接 · 自动更新" : sync === "error" ? "同步失败" : "正在同步…"}</MonitorTag></span>
        <button type="button" onClick={() => void agentActions.refresh()}>刷新</button>
      </div>
    </header>
    {error && <p role="alert" className={styles.notice} data-tone="red">{error.message}</p>}
    {!sessionId ? <p className={styles.empty}>请从聊天页打开对应会话的用量窗口。</p>
      : stateSession === sessionId && <AgentTokenMonitor runId={runId} onSelectRun={value => void navigate({ search: { sessionId, runId: value }, replace: true })} />}
  </section>;
}
