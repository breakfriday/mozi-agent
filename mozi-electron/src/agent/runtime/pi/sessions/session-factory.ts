import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { RuntimeSessionDescriptor } from "../../agent-runtime";
import type { PiConfig, PiModelBinding } from "../types";
import { failure } from "../../../errors";
import { preserveDeepSeekLocalTools } from "../providers/deepSeek";
import { preserveBailianLocalTools } from "../providers/bailian";
import type { BrowserCall } from "../../../../../../shared/browser";
import {
  BROWSER_GUIDELINES,
  BROWSER_TOOL_NAME,
  createBrowserTool,
} from "../browser-tools";
import { parseRunEntry } from "./session-entries";

/** SDK configuration/resource customization has a single assembly point. */
export class PiSessionFactory {
  private modelRuntime?: Promise<ModelRuntime>;
  constructor(
    private readonly config: PiConfig,
    private readonly browser?: BrowserCall,
  ) {}
  async create(
    manager: SessionManager,
    descriptor: RuntimeSessionDescriptor,
    binding?: PiModelBinding,
  ): Promise<AgentSession> {
    const { piDir, provider, modelId } = this.config;
    if (!binding)
      this.modelRuntime ??= ModelRuntime.create({
        authPath: path.join(piDir, "auth.json"),
        modelsPath: path.join(piDir, "models.json"),
        modelsStorePath: path.join(this.config.dataDir, "models-cache.json"),
        allowModelNetwork: false,
      });
    const modelRuntime = binding?.runtime ?? (await this.modelRuntime!);
    const model =
      binding?.model ??
      (provider && modelId
        ? modelRuntime.getModel(provider, modelId)
        : undefined);
    if (provider && !model)
      throw failure(
        "INVALID_ARGUMENT",
        `未找到配置的模型 ${provider}/${modelId}，请检查 Pi models.json。`,
      );
    const settings = SettingsManager.inMemory(
      SettingsManager.create(descriptor.cwd, piDir).getSettings(),
    );
    const browser =
      (binding?.webMode ?? (this.browser ? "browser" : "provider")) ===
      "browser"
        ? this.browser
        : undefined;
    const loader = new DefaultResourceLoader({
      cwd: descriptor.cwd,
      agentDir: piDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "你是 Mozi，一个嵌入桌面应用的智能助手。请准确回答用户的问题；涉及实时信息时，以实际获取的信息为依据，无法核实时明确说明。 思考内容使用中文 " +
        (browser
          ? BROWSER_GUIDELINES
          : "当前使用服务商原生联网模式，按当前可用的服务端工具联网；不要调用历史中的 Mozi 浏览器工具，也不要使用 bash、curl、wget 或脚本代替联网搜索和网页读取。无法联网时明确说明。"),
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: descriptor.cwd,
      agentDir: piDir,
      modelRuntime,
      model,
      thinkingLevel: binding?.thinkingLevel,
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
      tools: [
        "read",
        "bash",
        "edit",
        "write",
        ...(browser ? [BROWSER_TOOL_NAME] : []),
      ],
      customTools: browser
        ? [
            createBrowserTool(browser, descriptor.sessionId, () => {
              const entries = manager.getEntries();
              for (let i = entries.length - 1; i >= 0; i--) {
                const run = parseRunEntry(entries[i]);
                if (run) return run.runId;
              }
            }),
          ]
        : undefined,
    });
    preserveBailianLocalTools(session.agent, !!browser);
    preserveDeepSeekLocalTools(session.agent, !!browser);
    return session;
  }
}
