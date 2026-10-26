import {
  createAgentSession,
  DefaultResourceLoader,
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
  constructor(
    private readonly config: PiConfig,
    private readonly browser?: BrowserCall,
    private readonly configureAgent?: PiModelBinding["configureAgent"],
  ) {}
  async create(
    manager: SessionManager,
    descriptor: RuntimeSessionDescriptor,
    binding?: PiModelBinding,
  ): Promise<AgentSession> {
    if (!binding)
      throw failure("INVALID_ARGUMENT", "请先在 Mozi 中选择并配置模型。");
    const piDir = path.join(this.config.dataDir, "providers");
    const modelRuntime = binding.runtime;
    const model = binding.model;
    const settings = SettingsManager.inMemory({});
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
    (binding?.configureAgent ?? this.configureAgent)?.(
      session.agent,
      !!browser,
    );
    return session;
  }
}
