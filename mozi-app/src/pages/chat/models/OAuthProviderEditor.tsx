import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import type { ProviderAuthState, ProviderView } from "../../../../../shared/agent";
import { bridgeApi } from "../../../runtime/bridge";
import { modelActions } from "../../../agent/modelActions";
import { useAgentStore } from "../../../agent/agentStore";
import { useModelStore } from "../../../agent/modelStore";

export function OAuthProviderEditor({ provider, onClose }: { provider: ProviderView; onClose(): void }) {
  const [state, setState] = useState<ProviderAuthState>();
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const runtimeReady = useAgentStore(s => s.runtime.state === "ready");
  const configured = useModelStore(s => s.settings?.providers.find(p => p.id === provider.id)?.configured ?? provider.configured);
  const catalog = useModelStore(s => s.settings?.providers.find(p => p.id === provider.id));
  const reauthRequired = useModelStore(s => s.settings?.providers.find(p => p.id === provider.id)?.authStatus === "reauth_required");
  const alive = useRef(true);
  const revision = useRef(-1);
  const active = !!state && ["starting", "waiting", "completing"].includes(state.phase);

  useEffect(() => {
    alive.current = true;
    revision.current = -1;
    function receive(next: ProviderAuthState) {
      if (!alive.current || next.providerId !== provider.id || next.revision < revision.current) return;
      revision.current = next.revision;
      setState(next);
      setCallbackUrl("");
      if (["succeeded", "idle"].includes(next.phase)) void modelActions.refresh();
    }
    const off = bridgeApi.agent.onProviderAuth(receive);
    if (runtimeReady) void bridgeApi.agent.statusProviderAuth({ providerId: provider.id }).then(receive).catch(e => {
      if (alive.current) setError(e instanceof Error ? e.message : "无法获取登录状态。");
    });
    return () => { alive.current = false; off(); };
  }, [provider.id, runtimeReady]);

  async function action(work: () => Promise<unknown>) {
    setError(undefined); setBusy(true);
    try { await work(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "认证操作失败。"); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Modal open title={`连接 ${provider.name}`} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Typography.Paragraph>
        在系统浏览器中使用 Google 账号授权。授权完成后将自动返回连接状态；关闭此窗口不会取消登录。
      </Typography.Paragraph>
      {!runtimeReady && <Alert type="warning" title="Agent 未连接，请等待恢复后查看登录状态。" />}
      {reauthRequired && <Alert type="warning" title="Google 授权已失效，请重新登录。" />}
      {error && <Alert type="error" title={error} />}
      <Alert type={state?.phase === "failed" || state?.phase === "expired" ? "warning" : "info"}
        title={active ? (state?.phase === "completing" ? "正在完成授权…" : "等待 Google 授权…") : configured ? "已连接 Google 账号" : "尚未连接"}
        description={state?.message} />
      <Alert type={catalog?.catalogStatus === "failed" ? "warning" : "info"}
        title={catalog?.catalogMessage ?? "登录后可同步账号支持的最新模型。"} />
      <Space wrap>
        {!active && <Button type="primary" disabled={!runtimeReady || busy} loading={busy}
          onClick={() => void action(async () => {
            const next = await bridgeApi.agent.startProviderAuth({ providerId: provider.id });
            if (alive.current && next.revision >= revision.current) { revision.current = next.revision; setState(next); }
          })}>{configured ? "重新登录" : "使用 Google 登录"}</Button>}
        {active && <Button disabled={!runtimeReady || busy} onClick={() => void action(() => bridgeApi.agent.cancelProviderAuth({ providerId: provider.id, loginId: state.loginId }))}>取消登录</Button>}
        {active && state.authUrl && <Button disabled={!runtimeReady || busy} onClick={() => void action(() => bridgeApi.agent.openProviderAuth({ providerId: provider.id, loginId: state.loginId }))}>重新打开浏览器</Button>}
        {configured && <Button disabled={!runtimeReady || busy || active || catalog?.catalogStatus === "refreshing"}
          loading={catalog?.catalogStatus === "refreshing"} onClick={() => void action(async () => {
            await bridgeApi.agent.refreshProviderModels({ providerId: provider.id }); await modelActions.refresh();
          })}>刷新模型</Button>}
        {configured && <Button danger disabled={!runtimeReady || busy} onClick={() => void action(async () => {
          await bridgeApi.agent.logoutProviderAuth({ providerId: provider.id }); await modelActions.refresh();
        })}>退出登录</Button>}
      </Space>
      {active && state.prompt && <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text>{state.prompt.message}</Typography.Text>
        <Input.TextArea aria-label="OAuth 回调 URL" autoComplete="off" value={callbackUrl} rows={3}
          placeholder={state.prompt.placeholder} onChange={e => setCallbackUrl(e.target.value)} />
        <Button disabled={!runtimeReady || busy || !callbackUrl.trim()} onClick={() => void action(async () => {
          const value = callbackUrl; setCallbackUrl("");
          await bridgeApi.agent.submitProviderAuth({ providerId: provider.id, loginId: state.loginId,
            promptId: state.prompt!.id, callbackUrl: value });
        })}>提交回调 URL</Button>
      </Space>}
    </Space>
  </Modal>;
}
