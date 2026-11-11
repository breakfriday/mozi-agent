import { FolderInput } from "lucide-react";
import { useState } from "react";
import { Button, Input, Modal, Select, Space } from "antd";
import type { ProjectSummary } from "../../../../../shared/agent";
import { bridgeApi } from "@/runtime/bridge";
import { agentActions } from "@/agent/agentActions";

export function ProjectControls({ project, disabled, onChanged, onNew }: {
  project?: ProjectSummary; disabled: boolean; onChanged: () => void; onNew?: () => void;
}) {
  const [mode, setMode] = useState<"name" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      if (mode === "delete" && project) await bridgeApi.agent.deleteProject({ projectId: project.id });
      else if (project) await bridgeApi.agent.renameProject({ projectId: project.id, name: name.trim() });
      else await bridgeApi.agent.createProject({ projectId: id, name: name.trim() });
      setMode(null); onChanged();
      await agentActions.listSessions();
    } catch (e) { setError(e instanceof Error ? e.message : "项目操作失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <>
    <Space size={2}>
      {project && <Button size="small" type="text" disabled={disabled} onClick={onNew}>＋ 新建会话</Button>}
      <Button size="small" type="text" disabled={disabled} onClick={() => {
        setName(project?.name ?? ""); setId(crypto.randomUUID()); setError(""); setMode("name");
      }}>{project ? "重命名" : "＋ 创建项目"}</Button>
      {project && <Button size="small" type="text" disabled={disabled} onClick={() => { setError(""); setMode("delete"); }}>删除项目</Button>}
    </Space>
    <Modal open={mode !== null} title={mode === "delete" ? "删除项目" : project ? "重命名项目" : "创建项目"}
      onCancel={() => { if (!busy) setMode(null); }} onOk={() => void save()} confirmLoading={busy}
      okText={mode === "delete" ? "删除项目" : "保存"} cancelText="取消" closable={!busy}
      okButtonProps={{ danger: mode === "delete", disabled: disabled || (mode === "name" && !name.trim()) }}>
      {mode === "delete" ? <p>删除「{project?.name}」后，其中的会话将移至未归类，聊天记录不会删除。</p>
        : <Input aria-label="项目名称" value={name} maxLength={100} onChange={e => setName(e.target.value)} onPressEnter={() => { if (name.trim()) void save(); }} />}
      {error && <p role="alert">{error}</p>}
    </Modal>
  </>;
}

export function MoveSessionButton({ sessionId, projectId, projects, disabled, onChanged }: {
  sessionId: string; projectId?: string | null; projects: ProjectSummary[]; disabled: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function move() {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      await bridgeApi.agent.moveSession({ sessionId, projectId: target });
      await agentActions.listSessions(); onChanged(); setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : "移动失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <>
    <Button size="small" type="text" aria-label="移动到项目" title="移动到项目" disabled={disabled} onClick={() => {
      setTarget(projectId ?? null); setError(""); setOpen(true);
    }}><FolderInput size={16} /></Button>
    <Modal title="移动会话" open={open} onCancel={() => { if (!busy) setOpen(false); }} onOk={() => void move()}
      okText="移动" cancelText="取消" confirmLoading={busy} closable={!busy} okButtonProps={{ disabled }}>
      <Select style={{ width: "100%" }} aria-label="目标项目" showSearch optionFilterProp="label"
        value={target ?? ""} onChange={value => setTarget(value || null)} options={[
          { value: "", label: "未归类（移出项目）" }, ...projects.map(p => ({ value: p.id, label: p.name })),
        ]} />
      <ProjectControls disabled={busy || disabled} onChanged={onChanged} />
      {error && <p role="alert">{error}</p>}
    </Modal>
  </>;
}
