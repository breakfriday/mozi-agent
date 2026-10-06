import { useState } from "react";
import { ThreadListPrimitive, ThreadListItemPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { DeleteOutlined, EditOutlined, MessageOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Input, Modal } from "antd";
import { useAgentStore } from "@/agent/agentStore";
import { agentActions } from "@/agent/agentActions";
import styles from "./session-list.module.css";

function SessionItem() {
  const aui = useAui();
  const id = useAuiState((s) => s.threadListItem.id);
  const title = useAuiState((s) => s.threadListItem.title || "新会话");
  const disabled = useAgentStore((s) => s.sessionOperation !== null || s.inFlightSubmissionId !== null || s.runtime.state !== "ready");
  const running = useAgentStore((s) => s.sessionId === id && s.activeRunId !== null);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (saving || disabled || (dialog === "rename" && !name.trim())) return;
    setSaving(true);
    setError(null);
    try {
      if (dialog === "rename") await aui.threadListItem().rename(name.trim());
      else await aui.threadListItem().delete();
      setDialog(null);
    } catch {
      setError(useAgentStore.getState().sessionsError?.message ?? "操作失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ThreadListItemPrimitive.Root className={styles.item}>
      <ThreadListItemPrimitive.Trigger className={styles.trigger} disabled={disabled} title={title}>
        <MessageOutlined aria-hidden="true" />
        <span className={styles.title}><ThreadListItemPrimitive.Title fallback="新会话" /></span>
        {running && <span className={styles.running} aria-label="正在运行" />}
      </ThreadListItemPrimitive.Trigger>
      <div className={styles.actions}>
        <button type="button" disabled={disabled} aria-label={`重命名会话：${title}`} title="重命名"
          onClick={() => { setName(title); setError(null); setDialog("rename"); }}><EditOutlined /></button>
        <button type="button" disabled={disabled || running} aria-label={`删除会话：${title}`}
          title={running ? "请先停止任务再删除" : "删除"}
          onClick={() => { setError(null); setDialog("delete"); }}><DeleteOutlined /></button>
      </div>
      <Modal open={dialog !== null} title={dialog === "rename" ? "重命名会话" : "删除会话"}
        okText={dialog === "rename" ? "保存" : "删除"} cancelText="取消"
        confirmLoading={saving} okButtonProps={{ danger: dialog === "delete", disabled: disabled || (dialog === "rename" && !name.trim()) }}
        cancelButtonProps={{ disabled: saving }} closable={!saving} keyboard={!saving}
        onCancel={() => { if (!saving) setDialog(null); }} onOk={() => void confirm()}>
        {dialog === "rename" ? <Input aria-label="会话名称" value={name} maxLength={200} showCount
          onChange={(event) => setName(event.target.value)} onPressEnter={() => void confirm()} />
          : <p>删除「{title}」后，它将从会话列表移除，无法在应用中重新打开。原生历史文件会保留。</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </Modal>
    </ThreadListItemPrimitive.Root>
  );
}

export function SessionList() {
  const loading = useAgentStore((s) => s.sessionsLoading);
  const empty = useAgentStore((s) => s.sessions.length === 0);
  const error = useAgentStore((s) => s.sessionsError);
  const connected = useAgentStore((s) => s.runtime.state === "ready");
  const busy = useAgentStore((s) => s.sessionOperation !== null || s.inFlightSubmissionId !== null);
  return (
    <aside className={styles.sidebar} aria-label="会话列表">
      <ThreadListPrimitive.Root className={styles.list}>
        <div className={styles.header}>
          <h2>会话</h2>
          <Button type="text" size="small" icon={<ReloadOutlined spin={loading} />} aria-label="刷新会话列表"
            disabled={loading || busy || !connected} onClick={() => void agentActions.listSessions()} />
        </div>
        <ThreadListPrimitive.New className={styles.newButton} disabled={busy || !connected}>
          <PlusOutlined /> 新建会话
        </ThreadListPrimitive.New>
        {error && <div role="alert" className={styles.error}>{error.message}</div>}
        {loading && <p className={styles.hint} role="status">正在加载会话…</p>}
        {!loading && empty && <p className={styles.hint}>{connected ? "发送消息，开始第一个会话" : "连接 Agent 后查看历史会话"}</p>}
        <div className={styles.items} aria-busy={loading}>
          <ThreadListPrimitive.Items components={{ ThreadListItem: SessionItem }} />
        </div>
      </ThreadListPrimitive.Root>
    </aside>
  );
}
