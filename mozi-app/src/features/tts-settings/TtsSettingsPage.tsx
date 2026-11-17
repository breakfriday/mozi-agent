import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Form,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { bridgeApi } from "@/runtime/bridge";
import { TtsAudioPlayer } from "@/runtime/ttsAudioPlayer";
import type {
  TtsProviderId,
  TtsSettings,
  TtsSettingsSaveInput,
  TtsSettingsView,
  TtsVolcAuthMode,
} from "../../../../shared/tts";

type RunPhase =
  | "idle"
  | "starting"
  | "streaming"
  | "playing_tail"
  | "completed"
  | "cancelled"
  | "error";

interface RunTelemetry {
  utteranceId: string;
  phase: RunPhase;
  startedAtMs: number;
  ttfaMs?: number;
  audioBytes: number;
  sampleRate: number;
  textWords?: number;
  logId?: string;
  lastSentence?: string;
  errorText?: string;
}

const DEFAULT_SAMPLE_TEXT =
  "你好，我是墨子桌面助手。现在正在通过火山引擎双向流式接口进行语音合成测试，支持边发文字边收音频，延迟更低、韵律更自然。";

function createUtteranceId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `utt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function TtsSettingsPage() {
  const api = bridgeApi.tts;
  const [view, setView] = useState<TtsSettingsView | null>(null);
  const [draft, setDraft] = useState<TtsSettings | null>(null);

  // Write-only 密钥草稿（留空表示不修改已保存密钥）
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [appIdInput, setAppIdInput] = useState("");
  const [accessKeyInput, setAccessKeyInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  // 测试台输入状态
  const [testText, setTestText] = useState(DEFAULT_SAMPLE_TEXT);
  const [testTone, setTestTone] = useState("");
  const [simulateStream, setSimulateStream] = useState(true);
  const [telemetry, setTelemetry] = useState<RunTelemetry>({
    utteranceId: "",
    phase: "idle",
    startedAtMs: 0,
    audioBytes: 0,
    sampleRate: 24000,
  });
  const [outputLevel, setOutputLevel] = useState(0);

  const playerRef = useRef<TtsAudioPlayer | null>(null);
  const activeUtteranceRef = useRef<string>("");
  const streamTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const clearStreamSimulationTimer = () => {
    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!api) return;
    let mounted = true;

    const player = new TtsAudioPlayer({
      onDrained: (drainedId) => {
        if (!mounted || activeUtteranceRef.current !== drainedId) return;
        activeUtteranceRef.current = "";
        setTelemetry((prev) =>
          prev.utteranceId === drainedId && (prev.phase === "playing_tail" || prev.phase === "streaming")
            ? { ...prev, phase: "completed" }
            : prev,
        );
      },
    });
    playerRef.current = player;

    api
      .getState()
      .then((initial) => {
        if (!mounted) return;
        setView(initial);
        setDraft(structuredClone(initial.settings));
        setAppIdInput(initial.credentials.volcengine.appId ?? "");
      })
      .catch((err) => {
        if (mounted) setPageError(err instanceof Error ? err.message : String(err));
      });

    const offEvent = api.onEvent((event) => {
      if (!mounted) return;
      const currentId = activeUtteranceRef.current;
      if (event.utteranceId && event.utteranceId !== currentId) return;

      switch (event.type) {
        case "started":
          setTelemetry((prev) => ({
            ...prev,
            phase: "streaming",
            logId: event.logId ?? prev.logId,
          }));
          break;
        case "audio":
          player.pushPcm16Le(event.utteranceId, event.pcm, event.sampleRate);
          setTelemetry((prev) => {
            const now = performance.now();
            const ttfaMs =
              prev.ttfaMs ?? Math.max(1, Math.round(now - (startedAtRef.current || prev.startedAtMs)));
            return {
              ...prev,
              phase: prev.phase === "playing_tail" ? "playing_tail" : "streaming",
              ttfaMs,
              audioBytes: prev.audioBytes + event.pcm.byteLength,
              sampleRate: event.sampleRate,
            };
          });
          break;
        case "sentenceStart":
          if (event.text) {
            setTelemetry((prev) => ({ ...prev, lastSentence: event.text }));
          }
          break;
        case "finished":
          player.markNetworkFinished(event.utteranceId);
          setTelemetry((prev) => {
            const noAudio = event.audioBytes === 0 && prev.audioBytes === 0;
            if (noAudio && activeUtteranceRef.current === event.utteranceId) {
              activeUtteranceRef.current = "";
            }
            return {
              ...prev,
              phase: noAudio ? "completed" : "playing_tail",
              audioBytes: Math.max(prev.audioBytes, event.audioBytes),
              textWords: event.textWords ?? prev.textWords,
              logId: event.logId ?? prev.logId,
            };
          });
          break;
        case "cancelled":
          clearStreamSimulationTimer();
          player.clearImmediate();
          activeUtteranceRef.current = "";
          setTelemetry((prev) => ({ ...prev, phase: "cancelled" }));
          break;
        case "error":
          clearStreamSimulationTimer();
          player.clearImmediate();
          activeUtteranceRef.current = "";
          setTelemetry((prev) => ({
            ...prev,
            phase: "error",
            logId: event.logId ?? prev.logId,
            errorText: `[${event.code}] ${event.message}`,
          }));
          break;
      }
    });

    let rafId = 0;
    const sampleMeter = () => {
      setOutputLevel(player.getOutputLevel());
      rafId = window.requestAnimationFrame(sampleMeter);
    };
    rafId = window.requestAnimationFrame(sampleMeter);

    return () => {
      mounted = false;
      window.cancelAnimationFrame(rafId);
      clearStreamSimulationTimer();
      offEvent();
      player.dispose();
      playerRef.current = null;
    };
  }, [api]);

  const activeProvider = useMemo(() => {
    if (!view || !draft) return undefined;
    return view.catalog.find((item) => item.id === draft.activeProviderId) ?? view.catalog[0];
  }, [view, draft]);

  const selectedModel = useMemo(() => {
    if (!activeProvider || !draft) return undefined;
    return activeProvider.models.find((m) => m.id === draft.providers.volcengine.modelId);
  }, [activeProvider, draft]);

  if (!api) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
        <Alert type="info" showIcon message="请在 Mozi 桌面客户端中打开语音合成配置与测试窗口。" />
      </div>
    );
  }

  if (!view || !draft || !activeProvider) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: 24 }}>
        {pageError ? (
          <Alert type="error" showIcon message={pageError} />
        ) : (
          <Typography.Text type="secondary">正在加载语音合成配置…</Typography.Text>
        )}
      </div>
    );
  }

  const volc = draft.providers.volcengine;
  const credStatus = view.credentials.volcengine;
  const isRunning =
    telemetry.phase === "starting" ||
    telemetry.phase === "streaming" ||
    telemetry.phase === "playing_tail";

  const updateVolc = (patch: Partial<typeof volc>) => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            providers: {
              ...prev.providers,
              volcengine: { ...prev.providers.volcengine, ...patch },
            },
          }
        : prev,
    );
    setDirty(true);
    setSaveMessage(null);
  };

  const persistSettings = async (clearSecrets = false): Promise<boolean> => {
    setSaving(true);
    setPageError(null);
    setSaveMessage(null);
    try {
      const payload: TtsSettingsSaveInput = {
        settings: draft,
        credentials: {
          volcengine: clearSecrets
            ? { apiKey: "", appId: "", accessKey: "" }
            : {
                ...(apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
                ...(volc.authMode === "legacy_app" && appIdInput.trim()
                  ? { appId: appIdInput.trim() }
                  : {}),
                ...(volc.authMode === "legacy_app" && accessKeyInput.trim()
                  ? { accessKey: accessKeyInput.trim() }
                  : {}),
              },
        },
      };
      const updated = await api.saveSettings(payload);
      setView(updated);
      setDraft(structuredClone(updated.settings));
      setApiKeyInput("");
      setAccessKeyInput("");
      if (clearSecrets) setAppIdInput("");
      setDirty(false);
      setSaveMessage(clearSecrets ? "已清除保存的密钥" : "配置已保存并热生效");
      return true;
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRunTest = async () => {
    const content = testText.trim();
    if (!content) {
      setPageError("请输入要测试合成的文本内容。");
      return;
    }

    // 若表单或密钥输入框有未保存改动，自动先保存再执行测试，避免填完密钥忘点保存
    const hasPendingSecret =
      Boolean(apiKeyInput.trim()) ||
      (volc.authMode === "legacy_app" && Boolean(appIdInput.trim() || accessKeyInput.trim()));
    if (dirty || hasPendingSecret) {
      const ok = await persistSettings(false);
      if (!ok) return;
    }

    clearStreamSimulationTimer();
    const utteranceId = createUtteranceId();
    const now = performance.now();
    activeUtteranceRef.current = utteranceId;
    startedAtRef.current = now;

    setPageError(null);
    setTelemetry({
      utteranceId,
      phase: "starting",
      startedAtMs: now,
      audioBytes: 0,
      sampleRate: 24000,
    });

    await playerRef.current?.prepare(utteranceId, 24000);
    if (activeUtteranceRef.current !== utteranceId) return;

    const tone = testTone.trim() || undefined;
    if (!simulateStream) {
      api.sendCommand({ type: "speak", utteranceId, text: content, contextText: tone });
      return;
    }

    // 模拟大模型流式吐字：每 60ms 切分 5 个 Unicode 码点推入双向流式通道
    api.sendCommand({ type: "start", utteranceId, contextText: tone });
    const chars = Array.from(content);
    let cursor = 0;
    const stepSize = 5;

    const pushNextSlice = () => {
      if (activeUtteranceRef.current !== utteranceId) {
        clearStreamSimulationTimer();
        return;
      }
      const slice = chars.slice(cursor, cursor + stepSize).join("");
      cursor += stepSize;
      if (slice) {
        api.sendCommand({ type: "delta", utteranceId, text: slice });
      }
      if (cursor >= chars.length) {
        clearStreamSimulationTimer();
        api.sendCommand({ type: "finish", utteranceId });
      }
    };

    pushNextSlice();
    if (cursor < chars.length) {
      streamTimerRef.current = window.setInterval(pushNextSlice, 60);
    }
  };

  const handleStop = () => {
    clearStreamSimulationTimer();
    const currentId = activeUtteranceRef.current;
    activeUtteranceRef.current = "";
    playerRef.current?.clearImmediate();
    api.sendCommand({ type: "cancel", ...(currentId ? { utteranceId: currentId } : {}) });
    setTelemetry((prev) => (isRunning ? { ...prev, phase: "cancelled" } : prev));
  };

  const audioSeconds =
    telemetry.sampleRate > 0 ? (telemetry.audioBytes / (telemetry.sampleRate * 2)).toFixed(2) : "0.00";

  const phaseBadge = () => {
    switch (telemetry.phase) {
      case "idle":
        return <Tag>空闲就绪</Tag>;
      case "starting":
        return <Tag color="processing">建连与启动会话中…</Tag>;
      case "streaming":
        return <Tag color="blue">流式合成播放中…</Tag>;
      case "playing_tail":
        return <Tag color="cyan">云端已完成 · 播放剩余缓冲…</Tag>;
      case "completed":
        return <Tag color="success">播放完成</Tag>;
      case "cancelled":
        return <Tag color="warning">已停止</Tag>;
      case "error":
        return <Tag color="error">合成异常</Tag>;
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px 24px 36px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {pageError && <Alert type="error" showIcon closable message={pageError} onClose={() => setPageError(null)} />}

          <Card
            size="small"
            title={
              <Space>
                <span>TTS 服务商与模型配置</span>
                {credStatus.configured ? (
                  <Tag color="success">密钥已配置</Tag>
                ) : (
                  <Tag color="warning">未配置密钥</Tag>
                )}
              </Space>
            }
            extra={
              <Space>
                {saveMessage && <Typography.Text type="success">{saveMessage}</Typography.Text>}
                {(credStatus.hasApiKey || credStatus.hasLegacyApp) && (
                  <Button size="small" danger disabled={saving} onClick={() => void persistSettings(true)}>
                    清除已存密钥
                  </Button>
                )}
                <Button
                  type="primary"
                  size="small"
                  loading={saving}
                  onClick={() => void persistSettings(false)}
                >
                  保存配置
                </Button>
              </Space>
            }
          >
            <Form layout="vertical" size="middle">
              <Row gutter={16}>
                <Col xs={24} sm={10}>
                  <Form.Item label="语音服务商（Provider）">
                    <Select
                      aria-label="语音服务商"
                      value={draft.activeProviderId}
                      options={view.catalog.map((p) => ({ value: p.id, label: p.name }))}
                      onChange={(providerId: TtsProviderId) => {
                        setDraft((prev) => (prev ? { ...prev, activeProviderId: providerId } : prev));
                        setDirty(true);
                      }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={14}>
                  <Form.Item
                    label="语音合成模型（Model / Resource）"
                    extra={selectedModel?.description}
                  >
                    <Select
                      aria-label="语音合成模型"
                      value={volc.modelId}
                      options={activeProvider.models.map((m) => ({ value: m.id, label: m.name }))}
                      onChange={(modelId) => updateVolc({ modelId })}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item
                label={
                  <Space size={8} wrap>
                    <span>WebSocket 接入端点</span>
                    {activeProvider.endpointPresets.map((preset) => (
                      <Button
                        key={preset.id}
                        size="small"
                        type={volc.endpoint === preset.endpoint ? "primary" : "default"}
                        ghost={volc.endpoint === preset.endpoint}
                        onClick={() => updateVolc({ endpoint: preset.endpoint })}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </Space>
                }
              >
                <Input
                  aria-label="WebSocket 接入端点"
                  value={volc.endpoint}
                  placeholder="wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection"
                  onChange={(e) => updateVolc({ endpoint: e.target.value })}
                />
              </Form.Item>

              <Form.Item label="鉴权方式与密钥（0600 独立加密权限存储，不回传明文）">
                <Space direction="vertical" size={10} style={{ width: "100%" }}>
                  <Segmented
                    value={volc.authMode}
                    options={[
                      { label: "单密钥 API Key（方舟 / 新版推荐）", value: "api_key" },
                      { label: "AppID + Access Token（旧版控制台）", value: "legacy_app" },
                    ]}
                    onChange={(val) => updateVolc({ authMode: val as TtsVolcAuthMode })}
                  />
                  {volc.authMode === "api_key" ? (
                    <Input.Password
                      aria-label="API Key"
                      value={apiKeyInput}
                      placeholder={
                        credStatus.hasApiKey
                          ? "已保存 API Key（留空保持不变，输入新值覆盖）"
                          : "输入火山方舟或豆包语音 X-Api-Key"
                      }
                      onChange={(e) => setApiKeyInput(e.target.value)}
                    />
                  ) : (
                    <Row gutter={12}>
                      <Col xs={24} sm={10}>
                        <Input
                          aria-label="AppID"
                          value={appIdInput}
                          placeholder="输入 X-Api-App-Key (AppID)"
                          onChange={(e) => {
                            setAppIdInput(e.target.value);
                            setDirty(true);
                          }}
                        />
                      </Col>
                      <Col xs={24} sm={14}>
                        <Input.Password
                          aria-label="Access Token"
                          value={accessKeyInput}
                          placeholder={
                            credStatus.hasLegacyApp
                              ? "已保存 Access Token（留空保持不变）"
                              : "输入 X-Api-Access-Key (Access Token)"
                          }
                          onChange={(e) => setAccessKeyInput(e.target.value)}
                        />
                      </Col>
                    </Row>
                  )}
                </Space>
              </Form.Item>

              <Row gutter={16}>
                <Col xs={24} sm={12}>
                  <Form.Item label="发音人音色（可下拉选择预设或直接粘贴音色 ID）">
                    <AutoComplete
                      aria-label="发音人音色"
                      value={volc.speaker}
                      options={activeProvider.presetSpeakers.map((s) => ({
                        value: s.id,
                        label: `${s.label} · ${s.tag} (${s.id})`,
                      }))}
                      placeholder="例如 zh_female_vv_uranus_bigtts 或复刻 S_xxx"
                      onChange={(speaker) => updateVolc({ speaker })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item label="默认语气指令（可选，2.0 音色生效且不计费）">
                    <Input
                      aria-label="默认语气指令"
                      value={volc.defaultContextText}
                      placeholder="例如：请用温和清晰的语气回答"
                      onChange={(e) => updateVolc({ defaultContextText: e.target.value })}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={20}>
                <Col xs={24} sm={8}>
                  <Form.Item label={`语速 (${volc.speechRate})`}>
                    <Slider
                      min={-50}
                      max={100}
                      value={volc.speechRate}
                      onChange={(speechRate) => updateVolc({ speechRate })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item label={`音量 (${volc.loudnessRate})`}>
                    <Slider
                      min={-50}
                      max={100}
                      value={volc.loudnessRate}
                      onChange={(loudnessRate) => updateVolc({ loudnessRate })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item label={`音调 (${volc.pitch})`}>
                    <Slider
                      min={-12}
                      max={12}
                      value={volc.pitch}
                      onChange={(pitch) => updateVolc({ pitch })}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <span>双向流式语音合成测试台</span>
                {phaseBadge()}
              </Space>
            }
            extra={
              <Space size={12}>
                <Space size={6}>
                  <Switch
                    size="small"
                    checked={simulateStream}
                    onChange={setSimulateStream}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    模拟流式逐块输入
                  </Typography.Text>
                </Space>
                <Button
                  danger
                  disabled={!isRunning}
                  onClick={handleStop}
                >
                  Stop
                </Button>
                <Button
                  type="primary"
                  loading={saving}
                  onClick={() => void handleRunTest()}
                >
                  Run 合成播放
                </Button>
              </Space>
            }
          >
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Input.TextArea
                aria-label="测试文本"
                rows={4}
                value={testText}
                placeholder="输入要测试朗读的文字内容…"
                onChange={(e) => setTestText(e.target.value)}
              />

              <Input
                aria-label="单次语气指令"
                value={testTone}
                placeholder="单次语气指令覆盖（可选，留空使用上方默认语气指令，例如：用轻松愉快的语气朗读）"
                onChange={(e) => setTestTone(e.target.value)}
              />

              {telemetry.errorText && (
                <Alert type="error" showIcon message={telemetry.errorText} />
              )}

              <Row gutter={[16, 8]} align="middle">
                <Col xs={12} sm={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    首包音频延迟 (TTFA)
                  </Typography.Text>
                  <div style={{ fontWeight: 600 }}>
                    {telemetry.ttfaMs !== undefined ? `${telemetry.ttfaMs} ms` : "—"}
                  </div>
                </Col>
                <Col xs={12} sm={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    接收音频时长 / 大小
                  </Typography.Text>
                  <div style={{ fontWeight: 600 }}>
                    {audioSeconds}s ({(telemetry.audioBytes / 1024).toFixed(1)} KB)
                  </div>
                </Col>
                <Col xs={12} sm={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    计费字数
                  </Typography.Text>
                  <div style={{ fontWeight: 600 }}>
                    {telemetry.textWords !== undefined ? telemetry.textWords : "—"}
                  </div>
                </Col>
                <Col xs={12} sm={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    输出电平 (24kHz AudioWorklet)
                  </Typography.Text>
                  <Progress
                    percent={Math.round(outputLevel * 100)}
                    showInfo={false}
                    size="small"
                    status={isRunning ? "active" : "normal"}
                  />
                </Col>
              </Row>

              {(telemetry.logId || telemetry.lastSentence) && (
                <Space size={16} wrap>
                  {telemetry.logId && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: telemetry.logId }}>
                      LogID: {telemetry.logId}
                    </Typography.Text>
                  )}
                  {telemetry.lastSentence && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      当前分句：{telemetry.lastSentence}
                    </Typography.Text>
                  )}
                </Space>
              )}
            </Space>
          </Card>
        </Space>
      </div>
    </div>
  );
}
