import { useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Alert,
  Space,
  Divider,
} from "antd";
import {
  MinusCircleOutlined,
  PlusOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderModel,
  type ProviderSaveInput,
  type ProviderView,
  type ModelSelection,
} from "../../../../shared/agent";
import { useAgentStore } from "@/agent/agentStore";
import { useModelStore } from "@/agent/modelStore";
import { agentActions } from "@/agent/agentActions";
import { modelActions } from "@/agent/modelActions";
import {
  showsAllProviders,
  visibleProviders,
} from "@/agent/providerVisibility";
import styles from "./model-controls.module.css";

type ProviderForm = {
  providerId: string;
  name: string;
  baseUrl: string;
  api?: ProviderApi;
  apiKey?: string;
  models: ProviderModel[];
};
const apiLabels: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions 兼容",
  "openai-responses": "OpenAI Responses 兼容",
  "anthropic-messages": "Anthropic Messages 兼容",
};

function ProviderEditor({
  provider,
  onClose,
}: {
  provider?: ProviderView;
  onClose(): void;
}) {
  const [form] = Form.useForm<ProviderForm>();
  const saving = useModelStore((state) => state.saving);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const connected = useAgentStore((state) => state.runtime.state === "ready");
  async function save(values: ProviderForm) {
    setError(null);
    const input: ProviderSaveInput = {
      providerId: values.providerId.trim(),
      name: values.name.trim(),
      ...(values.baseUrl && (!provider || values.baseUrl !== provider.baseUrl)
        ? { baseUrl: values.baseUrl.trim().replace(/\/$/, "") }
        : {}),
      ...(values.api && (!provider || values.api !== provider.api)
        ? { api: values.api }
        : {}),
      ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
      models: (values.models ?? []).map((model) => ({
        ...model,
        id: model.id.trim(),
        name: (model.name || model.id).trim(),
        reasoning: model.reasoning ?? false,
        vision: model.vision ?? false,
      })),
    };
    try {
      await modelActions.saveProvider(input);
      form.resetFields(["apiKey"]);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败。");
    }
  }
  async function remove() {
    if (!provider) return;
    try {
      await modelActions.removeProvider(provider.id);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "删除失败。");
      setDeleting(false);
    }
  }
  return (
    <Modal
      open
      title={provider ? `配置 ${provider.name}` : "添加 provider"}
      width={720}
      onCancel={() => {
        if (!saving) onClose();
      }}
      closable={!saving}
      keyboard={!saving}
      footer={
        <Space>
          {provider?.removable && (
            <Button
              danger
              disabled={saving || !connected}
              onClick={() => setDeleting(true)}
            >
              删除 provider
            </Button>
          )}
          <Button disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!connected}
            onClick={() => form.submit()}
          >
            保存
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void save(values)}
        initialValues={{
          providerId: provider?.id ?? "",
          name: provider?.name ?? "",
          baseUrl: provider?.baseUrl ?? "",
          api:
            provider && PROVIDER_APIS.includes(provider.api as ProviderApi)
              ? provider.api
              : provider
                ? undefined
                : "openai-completions",
          models: provider?.customModels ?? [],
        }}
      >
        {provider?.endpointLocked && (
          <Alert
            type="info"
            showIcon
            title="此 provider 使用 Token Plan 专属入口，不会自动切换到按量计费通道。"
          />
        )}
        <div className={styles.formRow}>
          <Form.Item
            name="providerId"
            label="Provider ID"
            rules={[
              { required: true },
              {
                pattern: /^[a-z0-9][a-z0-9._-]*$/,
                message: "使用小写字母、数字、点、下划线或短横线",
              },
            ]}
          >
            <Input
              disabled={!!provider || saving}
              placeholder="例如 my-deepseek"
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="显示名称"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input disabled={saving} />
          </Form.Item>
        </div>
        <Form.Item
          name="baseUrl"
          label="API 地址（Base URL）"
          rules={[
            { required: !provider },
            { type: "url", message: "请输入完整的 http:// 或 https:// 地址" },
          ]}
        >
          <Input
            disabled={saving || provider?.endpointLocked}
            placeholder="https://example.com/v1"
          />
        </Form.Item>
        <Form.Item
          name="api"
          label="接口协议"
          rules={[{ required: !provider }]}
        >
          <Select
            disabled={saving || provider?.endpointLocked}
            placeholder="沿用 provider 原生协议"
            options={PROVIDER_APIS.map((value) => ({
              value,
              label: apiLabels[value],
            }))}
          />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API Key"
          extra={
            provider?.configured
              ? "已配置凭据。留空保留现有 Key，不回显原值。"
              : "填写此服务的 API Key；Token Plan 需要套餐专属 Key。"
          }
        >
          <Input.Password
            autoComplete="new-password"
            disabled={saving}
            placeholder={
              provider?.configured ? "已配置，留空保留" : "输入 API Key"
            }
          />
        </Form.Item>
        <Divider titlePlacement="left">
          {provider ? "补充 / 覆盖模型（可选）" : "支持的模型"}
        </Divider>
        <Form.List
          name="models"
          rules={[
            {
              validator: async (_, values) => {
                if (!provider && !values?.length)
                  throw new Error("请至少添加一个模型。");
              },
            },
          ]}
        >
          {(fields, { add, remove: removeModel }, { errors }) => (
            <>
              {fields.map((field) => (
                <div className={styles.modelForm} key={field.key}>
                  <div className={styles.formRow}>
                    <Form.Item
                      name={[field.name, "id"]}
                      label="模型 ID"
                      rules={[{ required: true, whitespace: true }]}
                    >
                      <Input disabled={saving} />
                    </Form.Item>
                    <Form.Item name={[field.name, "name"]} label="模型名称">
                      <Input disabled={saving} placeholder="默认使用模型 ID" />
                    </Form.Item>
                    <Button
                      type="text"
                      aria-label="移除模型配置"
                      disabled={saving}
                      icon={<MinusCircleOutlined />}
                      onClick={() => removeModel(field.name)}
                    />
                  </div>
                  <div className={styles.formRow}>
                    <Form.Item
                      name={[field.name, "contextWindow"]}
                      label="上下文长度"
                      rules={[{ required: true }]}
                    >
                      <InputNumber
                        min={1}
                        max={100000000}
                        precision={0}
                        disabled={saving}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "maxTokens"]}
                      label="最大输出"
                      rules={[{ required: true }]}
                    >
                      <InputNumber
                        min={1}
                        max={100000000}
                        precision={0}
                        disabled={saving}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "reasoning"]}
                      label="推理"
                      valuePropName="checked"
                    >
                      <Switch disabled={saving} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, "vision"]}
                      label="视觉"
                      valuePropName="checked"
                    >
                      <Switch disabled={saving} />
                    </Form.Item>
                  </div>
                </div>
              ))}
              <Form.ErrorList errors={errors} />
              <Button
                block
                icon={<PlusOutlined />}
                disabled={saving}
                onClick={() =>
                  add({
                    contextWindow: 32768,
                    maxTokens: 8192,
                    reasoning: false,
                    vision: false,
                  })
                }
              >
                添加模型配置
              </Button>
            </>
          )}
        </Form.List>
      </Form>
      {error && (
        <Alert className={styles.error} type="error" showIcon title={error} />
      )}
      <Modal
        open={deleting}
        title="删除 provider"
        okText="删除"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => {
          if (!saving) setDeleting(false);
        }}
        onOk={() => void remove()}
        okButtonProps={{ danger: true, disabled: !connected }}
      >
        <p>
          删除此自定义 provider 及保存的凭据？仍在使用它的会话需要先切换到其他
          provider。
        </p>
      </Modal>
    </Modal>
  );
}

function ModelChoices({
  providers,
  loaded,
  value,
  onChange,
  disabled,
}: {
  providers: ProviderView[];
  loaded: boolean;
  value?: ModelSelection;
  onChange(model: ModelSelection): void;
  disabled?: boolean;
}) {
  const provider = providers.find((item) => item.id === value?.providerId);
  const hiddenSelection = loaded && value && !provider;
  return (
    <div className={styles.selection}>
      <div className={styles.choices}>
        <Select
          aria-label="服务提供商"
          placeholder="选择 provider"
          showSearch
          optionFilterProp="label"
          value={provider?.id}
          disabled={disabled}
          options={providers.map((item) => ({
            value: item.id,
            disabled: !item.configured,
            label: `${item.name}${item.configured ? "" : "（未配置凭据）"}`,
          }))}
          onChange={(id) => {
            const model = providers.find((item) => item.id === id)?.models[0];
            if (model) onChange({ providerId: id, modelId: model.id });
          }}
        />
        <Select
          aria-label="模型"
          placeholder="选择该 provider 的模型"
          showSearch
          optionFilterProp="label"
          value={provider ? value?.modelId : undefined}
          disabled={disabled || !provider?.configured}
          options={
            provider?.models.map((model) => ({
              value: model.id,
              label: model.name,
            })) ?? []
          }
          onChange={(modelId) => {
            if (provider) onChange({ providerId: provider.id, modelId });
          }}
        />
      </div>
      {hiddenSelection && (
        <div role="status" className={styles.hint}>
          当前选择的服务未在列表中展示，原有模型绑定仍保留；可重新选择服务。
        </div>
      )}
    </div>
  );
}

export function ModelControls() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderView | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings = useModelStore((state) => state.settings);
  // Derive the display list after reading the stable store snapshot, never inside its selector.
  const providers = visibleProviders(settings?.providers);
  const loading = useModelStore((state) => state.loading);
  const saving = useModelStore((state) => state.saving);
  const loadError = useModelStore((state) => state.error);
  const selection = useAgentStore((state) => state.modelSelection);
  const connected = useAgentStore((state) => state.runtime.state === "ready");
  const busy = useAgentStore(
    (state) =>
      !!state.activeRunId ||
      !!state.inFlightSubmissionId ||
      !!state.sessionOperation ||
      state.syncStatus === "syncing" ||
      Object.values(state.pendingSubmissions).some(
        (item) => item.status === "unknown",
      ),
  );
  const selected = selection ?? settings?.defaultModel;
  async function select(model: ModelSelection) {
    setError(null);
    try {
      await agentActions.setModel(model);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "模型切换失败。");
    }
  }
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <ModelChoices
          providers={providers}
          loaded={!!settings}
          value={selected}
          disabled={!connected || busy || loading || saving}
          onChange={(model) => void select(model)}
        />
        <Button
          icon={<SettingOutlined />}
          onClick={() => {
            setOpen(true);
            if (connected) void modelActions.refresh();
          }}
          aria-label="模型服务设置"
        >
          配置
        </Button>
      </div>
      {(error || loadError) && (
        <div role="alert" className={styles.hint}>
          {error || loadError}
          <button
            type="button"
            disabled={!connected || saving || loading}
            onClick={() => {
              setError(null);
              void modelActions.refresh();
            }}
          >
            重新加载
          </button>
        </div>
      )}
      <Modal
        open={open}
        title="模型服务设置"
        footer={null}
        width={760}
        onCancel={() => {
          if (!saving) setOpen(false);
        }}
      >
        <p>
          先配置服务，再选择它支持的模型。默认模型用于新会话，已有会话保留自己的选择。
        </p>
        <ModelChoices
          providers={providers}
          loaded={!!settings}
          value={settings?.defaultModel}
          disabled={!connected || loading || saving}
          onChange={(model) => {
            void modelActions.setDefault(model).catch(() => {});
          }}
        />
        <p className={styles.hint}>
          上方选择为全局默认模型。凭据仅在桌面端后台保存；当前配置表单支持 API
          Key。
        </p>
        {loadError && <Alert type="error" showIcon title={loadError} />}
        <div className={styles.settingsActions}>
          <Button
            onClick={() => void modelActions.refresh()}
            disabled={!connected || saving}
            loading={loading}
          >
            刷新服务列表
          </Button>
          {showsAllProviders() && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!connected || saving}
              onClick={() => setEditing("new")}
            >
              添加 provider
            </Button>
          )}
        </div>
        <div className={styles.providers}>
          {providers.map((provider) => (
            <div className={styles.provider} key={provider.id}>
              <div>
                <strong>{provider.name}</strong>
                <div className={styles.hint}>
                  {provider.id} · {provider.models.length} 个模型 ·{" "}
                  {provider.configured ? "凭据已配置" : "未配置凭据"}
                </div>
              </div>
              <Button
                disabled={!connected || saving}
                onClick={() => setEditing(provider)}
              >
                配置服务
              </Button>
            </div>
          ))}
        </div>
      </Modal>
      {editing && (
        <ProviderEditor
          key={editing === "new" ? "new" : editing.id}
          provider={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
