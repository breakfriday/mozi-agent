import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { RuntimeSessionDescriptor } from "../../application/ports/agent-runtime";
import { failure } from "../../application/errors";

/** Pi-specific options; bootstrap configuration is structurally compatible. */
export interface PiConfig { dataDir: string; cwd: string; piDir: string; provider?: string; modelId?: string }

/** SDK configuration/resource customization has a single assembly point. */
export class PiSessionFactory {
  private modelRuntime?: Promise<ModelRuntime>;
  constructor(private readonly config: PiConfig) {}
  async create(manager: SessionManager, descriptor: RuntimeSessionDescriptor): Promise<AgentSession> {
    const { piDir, provider, modelId } = this.config;
    this.modelRuntime ??= ModelRuntime.create({ authPath: path.join(piDir, "auth.json"), modelsPath: path.join(piDir, "models.json"),
      modelsStorePath: path.join(this.config.dataDir, "models-cache.json"), allowModelNetwork: false });
    const modelRuntime = await this.modelRuntime;
    const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
    if (provider && !model) throw failure("INVALID_ARGUMENT", `未找到配置的模型 ${provider}/${modelId}，请检查 Pi models.json。`);
    const settings = SettingsManager.inMemory(SettingsManager.create(descriptor.cwd, piDir).getSettings());
    const loader = new DefaultResourceLoader({ cwd: descriptor.cwd, agentDir: piDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "你是 Mozi，一个嵌入桌面应用的智能助手。当前仅提供文本对话，没有执行工具。请准确回答用户的问题。" });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: descriptor.cwd, agentDir: piDir,
      modelRuntime, model, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all", tools: [] });
    return session;
  }
}
