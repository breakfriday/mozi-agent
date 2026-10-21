import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { RuntimeSessionDescriptor } from "../../agent-runtime";
import type { PiConfig, PiModelBinding } from "../types";
import { failure } from "../../../errors";
import { preserveDeepSeekLocalTools } from "../providers/deepSeek";
import { preserveBailianLocalTools } from "../providers/bailian";
import type { BrowserCall } from "../../../../../../shared/browser";
import { createBrowserTool } from "../browser-tools";
import { collectToolGuidelines } from "./prompt/tool-guidelines";
import {
  MOZI_SYSTEM_PROMPT,
  BROWSER_WEB_GUIDELINES,
  PROVIDER_WEB_GUIDELINES,
} from "./prompt/mozi-guidelines";
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
    // This list is the single source for active custom tools and their prompt rules.
    const customTools: ToolDefinition[] = browser
      ? [
          createBrowserTool(browser, descriptor.sessionId, () => {
            const entries = manager.getEntries();
            for (let i = entries.length - 1; i >= 0; i--) {
              const run = parseRunEntry(entries[i]);
              if (run) return run.runId;
            }
          }),
        ]
      : [];
    const loader = new DefaultResourceLoader({
      cwd: descriptor.cwd,
      agentDir: piDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: MOZI_SYSTEM_PROMPT,
      appendSystemPrompt: [
        browser ? BROWSER_WEB_GUIDELINES : PROVIDER_WEB_GUIDELINES,
        ...collectToolGuidelines(customTools),
      ],
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
        ...customTools.map((tool) => tool.name),
      ],
      customTools,
    });
    preserveBailianLocalTools(session.agent, !!browser);
    preserveDeepSeekLocalTools(session.agent, !!browser);
    return session;
  }
}
