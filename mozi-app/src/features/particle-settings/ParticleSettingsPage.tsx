import { useEffect, useState } from "react";
import { Alert, Button, Form, Select, Slider, Space, Switch, Typography } from "antd";
import { bridgeApi } from "@/runtime/bridge";
import { PARTICLE_STYLES, type ParticleSettings } from "../../../../shared/particles";

const names = ["万象 · 流转", "星陨 · 流光", "花火 · 绽放", "水墨 · 氤氲", "星涡 · 坍缩", "极光 · 漫游", "星环 · 潮汐", "静水 · 浮沉"];
export function ParticleSettingsPage() {
  const [settings, setSettings] = useState<ParticleSettings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const api = bridgeApi.particleSettings;
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    api.get().then(value => { if (mounted) setSettings(value); }).catch(error => { if (mounted) setError(String(error)); });
    return () => { mounted = false; };
  }, [api]);
  const update = (patch: Partial<ParticleSettings>) => { setSettings(current => current && ({ ...current, ...patch })); setSaved(false); };
  if (!api) return <Alert type="info" message="请从桌面托盘打开粒子场设置。" />;
  return <div style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
    <Typography.Paragraph type="secondary">设置会保存到本机，运行中的粒子场立即应用；未启动时，下次开启生效。</Typography.Paragraph>
    {error && <Alert type="error" message={error} />}
    {settings && <Form layout="vertical" disabled={busy}>
      <Form.Item label="粒子风格"><Select aria-label="粒子风格" value={settings.style} options={PARTICLE_STYLES.map((value, i) => ({ value, label: names[i] }))} onChange={style => update({ style })} /></Form.Item>
      <Form.Item label="壁纸">
        <Typography.Paragraph ellipsis={{ tooltip: true }}>{settings.wallpaper ?? "使用系统壁纸"}</Typography.Paragraph>
        <Space><Button onClick={async () => { try { const wallpaper = await api.chooseWallpaper(); if (wallpaper) update({ wallpaper }); } catch (error) { setError(String(error)); } }}>选择图片</Button><Button onClick={() => update({ wallpaper: null })}>使用系统壁纸</Button></Space>
      </Form.Item>
      <Form.Item label="立体深度"><Slider aria-label="立体深度" min={0} max={3} step={0.05} value={settings.depth} onChange={depth => update({ depth })} /></Form.Item>
      <Space size="large">
        <Form.Item label="镜头巡航"><Switch aria-label="镜头巡航" checked={settings.cruise} onChange={cruise => update({ cruise })} /></Form.Item>
        <Form.Item label="暂停动画"><Switch aria-label="暂停动画" checked={settings.paused} onChange={paused => update({ paused })} /></Form.Item>
      </Space>
      <div><Button type="primary" loading={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await api.save(settings); setSaved(true); } catch (error) { setError(String(error)); } finally { setBusy(false); }
      }}>保存并应用</Button>{saved && <Typography.Text type="success" style={{ marginLeft: 12 }}>已保存</Typography.Text>}</div>
    </Form>}
  </div>;
}
