import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  QRCode,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { bridgeApi } from "@/runtime/bridge";
import {
  buildDeviceLinkQrPayload,
  pickPreferredLanIp,
  type DeviceLinkStateView,
} from "../../../../shared/device-link";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function DeviceLinkSettingsPage() {
  const api = bridgeApi.deviceLink;
  const [state, setState] = useState<DeviceLinkStateView | null>(null);
  const [portDraft, setPortDraft] = useState<number>(8080);
  const [pathDraft, setPathDraft] = useState<string>("/");
  const [dirty, setDirty] = useState(false);

  const [selectedIp, setSelectedIp] = useState<string>("");
  const [toggling, setToggling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [outgoingText, setOutgoingText] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    api
      .getState()
      .then((initial) => {
        if (!mounted) return;
        setState(initial);
        setPortDraft(initial.settings.port);
        setPathDraft(initial.settings.path);
      })
      .catch((err) => {
        if (mounted) setPageError(err instanceof Error ? err.message : String(err));
      });

    const unsubscribe = api.onEvent((evt) => {
      if (!mounted) return;
      if (evt.type === "stateChanged") {
        setState(evt.state);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);

  const availableIps = useMemo(() => {
    if (!state || state.lanAddresses.length === 0) {
      return ["127.0.0.1"];
    }
    return state.lanAddresses;
  }, [state]);

  const activeIp = useMemo(() => {
    if (selectedIp && availableIps.includes(selectedIp)) {
      return selectedIp;
    }
    return pickPreferredLanIp(availableIps);
  }, [availableIps, selectedIp]);

  const displayPort = state?.running ? state.activePort : (state?.settings.port ?? portDraft);
  const displayPath = state?.running ? state.path : (state?.settings.path ?? pathDraft);

  const qrPayload = useMemo(() => {
    try {
      return buildDeviceLinkQrPayload({
        host: activeIp,
        port: displayPort,
        path: displayPath,
      });
    } catch {
      return buildDeviceLinkQrPayload({
        host: activeIp,
        port: 8080,
        path: "/",
      });
    }
  }, [activeIp, displayPort, displayPath]);

  const qrCompactJson = useMemo(() => JSON.stringify(qrPayload), [qrPayload]);
  const qrPrettyJson = useMemo(() => JSON.stringify(qrPayload, null, 2), [qrPayload]);

  if (!api) {
    return (
      <div style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
        <Alert type="info" showIcon message="请在桌面客户端中打开互联服务配置。" />
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
        {pageError ? (
          <Alert type="error" showIcon message={pageError} />
        ) : (
          <Typography.Text type="secondary">正在加载互联服务状态…</Typography.Text>
        )}
      </div>
    );
  }

  const handleToggle = async (nextEnabled: boolean) => {
    setToggling(true);
    setPageError(null);
    setFeedback(null);
    try {
      const next = await api.setEnabled(nextEnabled);
      setState(next);
      if (nextEnabled && !next.running && next.lastError) {
        setPageError(`启动失败：${next.lastError}`);
      } else {
        setFeedback(next.running ? `服务已启动（端口 ${next.activePort}）` : "互联服务已关闭");
      }
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setPageError(null);
    setFeedback(null);
    try {
      const next = await api.saveSettings({
        port: portDraft,
        path: pathDraft,
      });
      setState(next);
      setPortDraft(next.settings.port);
      setPathDraft(next.settings.path);
      setDirty(false);
      if (next.lastError) {
        setPageError(next.lastError);
      } else {
        setFeedback(next.running ? "配置已保存并重启监听" : "配置已保存（下次开启生效）");
      }
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (content: string, label: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setFeedback(`已复制${label}`);
    } catch {
      setPageError("写入系统剪贴板失败");
    }
  };

  const handleSendText = async () => {
    const trimmed = outgoingText.trim();
    if (!trimmed) return;
    setSending(true);
    setPageError(null);
    try {
      const res = await api.sendText(trimmed);
      setState(res.state);
      setOutgoingText("");
      setFeedback(
        res.deliveredCount > 0
          ? `已推送给 ${res.deliveredCount} 台在线设备`
          : "已记录（当前暂无手机在线连接）",
      );
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const noLanWarning = state.lanAddresses.length === 0;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 24px 32px" }}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card size="small">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <Space direction="vertical" size={4}>
              <Space align="center" size={8} wrap>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  设备互联服务（Device Link）
                </Typography.Title>
                <Tag color={state.running ? "success" : "default"}>
                  {state.running ? `运行中 · :${state.activePort}` : "已关闭"}
                </Tag>
                {state.running && (
                  <Tag color={state.connectedClients.length > 0 ? "processing" : "default"}>
                    {state.connectedClients.length} 台设备在线
                  </Tag>
                )}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                默认关闭。开启后，同一局域网下的鸿蒙「声桥」App 可直接扫描下方二维码连接 WebSocket 服务。
              </Typography.Text>
            </Space>

            <Switch
              aria-label="互联服务开关"
              checked={state.running}
              loading={toggling}
              checkedChildren="已开启"
              unCheckedChildren="已关闭"
              onChange={(checked) => {
                void handleToggle(checked);
              }}
            />
          </div>
        </Card>

        {(pageError || state.lastError) && (
          <Alert type="error" showIcon message={pageError || state.lastError} />
        )}
        {feedback && <Alert type="success" showIcon message={feedback} closable onClose={() => setFeedback(null)} />}
        {noLanWarning && (
          <Alert
            type="warning"
            showIcon
            message="未检测到局域网 IPv4 地址，当前回退显示 127.0.0.1（手机扫码需连接同一 Wi-Fi / 局域网）。"
          />
        )}

        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card
              size="small"
              title="声桥 App 扫码直连"
              extra={
                <Button
                  size="small"
                  onClick={() => {
                    void handleCopy(qrPayload.ws, " WebSocket 地址");
                  }}
                >
                  复制 WS 地址
                </Button>
              }
              style={{ height: "100%" }}
            >
              <Space direction="vertical" size={14} style={{ width: "100%" }}>
                {availableIps.length > 1 && (
                  <Form layout="vertical" size="small">
                    <Form.Item label="选择本机网卡 IP" style={{ marginBottom: 0 }}>
                      <Select
                        aria-label="选择本机网卡 IP"
                        value={activeIp}
                        options={availableIps.map((ip) => ({
                          value: ip,
                          label: `${ip}:${displayPort}`,
                        }))}
                        onChange={(val) => setSelectedIp(val)}
                      />
                    </Form.Item>
                  </Form>
                )}

                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "16px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(128,128,128,0.2)",
                  }}
                >
                  <div style={{ opacity: state.running ? 1 : 0.22, transition: "opacity 0.2s" }}>
                    <QRCode value={qrCompactJson} size={196} bordered={false} />
                  </div>

                  {!state.running && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 10,
                        borderRadius: 12,
                        backdropFilter: "blur(2px)",
                      }}
                    >
                      <Typography.Text strong>服务尚未开启</Typography.Text>
                      <Button
                        type="primary"
                        size="small"
                        loading={toggling}
                        onClick={() => {
                          void handleToggle(true);
                        }}
                      >
                        立即开启服务
                      </Button>
                    </div>
                  )}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    rowGap: 6,
                    columnGap: 12,
                    fontSize: 13,
                  }}
                >
                  <Typography.Text type="secondary">服务 IP：</Typography.Text>
                  <Typography.Text code>{qrPayload.host}</Typography.Text>

                  <Typography.Text type="secondary">端口号：</Typography.Text>
                  <Typography.Text code>{qrPayload.port}</Typography.Text>

                  <Typography.Text type="secondary">WS 地址：</Typography.Text>
                  <Typography.Text code ellipsis={{ tooltip: qrPayload.ws }}>
                    {qrPayload.ws}
                  </Typography.Text>
                </div>
              </Space>
            </Card>
          </Col>

          <Col xs={24} md={12}>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <Card size="small" title="监听参数配置">
                <Form layout="vertical">
                  <Row gutter={12}>
                    <Col span={12}>
                      <Form.Item label="监听端口 (1–65535)" style={{ marginBottom: 12 }}>
                        <InputNumber
                          aria-label="监听端口"
                          min={1}
                          max={65535}
                          precision={0}
                          style={{ width: "100%" }}
                          value={portDraft}
                          onChange={(val) => {
                            if (typeof val === "number") {
                              setPortDraft(val);
                              setDirty(true);
                            }
                          }}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="WebSocket 路径" style={{ marginBottom: 12 }}>
                        <Input
                          aria-label="WebSocket 路径"
                          placeholder="/"
                          value={pathDraft}
                          onChange={(e) => {
                            setPathDraft(e.target.value);
                            setDirty(true);
                          }}
                        />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Space>
                    <Button
                      type="primary"
                      loading={saving}
                      disabled={!dirty}
                      onClick={() => {
                        void handleSaveSettings();
                      }}
                    >
                      {state.running ? "保存并重启监听" : "保存配置"}
                    </Button>
                    {dirty && (
                      <Button
                        onClick={() => {
                          setPortDraft(state.settings.port);
                          setPathDraft(state.settings.path);
                          setDirty(false);
                        }}
                      >
                        重置修改
                      </Button>
                    )}
                  </Space>
                </Form>
              </Card>

              <Card
                size="small"
                title="二维码 JSON 内容"
                extra={
                  <Button
                    size="small"
                    onClick={() => {
                      void handleCopy(qrCompactJson, "二维码 JSON");
                    }}
                  >
                    复制 JSON
                  </Button>
                }
              >
                <pre
                  style={{
                    margin: 0,
                    padding: "10px 12px",
                    fontSize: 12,
                    lineHeight: 1.5,
                    borderRadius: 8,
                    overflowX: "auto",
                    background: "rgba(128,128,128,0.1)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  {qrPrettyJson}
                </pre>
              </Card>
            </Space>
          </Col>
        </Row>

        <Card
          size="small"
          title={`实时文本帧收发（在线设备 ${state.connectedClients.length} 台）`}
          extra={
            state.recentMessages.length > 0 ? (
              <Button
                size="small"
                type="text"
                onClick={() => {
                  void api.clearHistory().then(setState);
                }}
              >
                清空记录
              </Button>
            ) : null
          }
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {state.connectedClients.length > 0 && (
              <Space size={[6, 6]} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前在线：
                </Typography.Text>
                {state.connectedClients.map((peer) => (
                  <Tag key={peer.clientId} color="green">
                    {peer.remoteAddress} ({formatTime(peer.connectedAt)})
                  </Tag>
                ))}
              </Space>
            )}

            <Space.Compact style={{ width: "100%" }}>
              <Input
                placeholder="输入文本或链接，测试通过 WebSocket 推送到已连接的声桥 App…"
                value={outgoingText}
                disabled={!state.running}
                onChange={(e) => setOutgoingText(e.target.value)}
                onPressEnter={() => {
                  void handleSendText();
                }}
              />
              <Button
                type="primary"
                loading={sending}
                disabled={!state.running || !outgoingText.trim()}
                onClick={() => {
                  void handleSendText();
                }}
              >
                推送文本帧
              </Button>
            </Space.Compact>

            {state.recentMessages.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无收发记录。手机端发送的链接或文本将实时显示在此处。
              </Typography.Text>
            ) : (
              <div
                style={{
                  maxHeight: 220,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {state.recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid rgba(128,128,128,0.18)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Space size={6} style={{ marginBottom: 2 }}>
                        <Tag
                          color={msg.direction === "incoming" ? "cyan" : "gold"}
                          style={{ marginInlineEnd: 0 }}
                        >
                          {msg.direction === "incoming" ? "↓ 手机发来" : "↑ 本机发出"}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {formatTime(msg.timestamp)}
                          {msg.remoteAddress ? ` · ${msg.remoteAddress}` : ""}
                        </Typography.Text>
                      </Space>
                      <div>
                        <Typography.Text
                          ellipsis={{ tooltip: msg.text }}
                          style={{ width: "100%" }}
                        >
                          {msg.text}
                        </Typography.Text>
                      </div>
                    </div>

                    <Button
                      size="small"
                      onClick={() => {
                        void handleCopy(msg.text, "消息内容");
                      }}
                    >
                      复制
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Space>
        </Card>
      </Space>
    </div>
  );
}
