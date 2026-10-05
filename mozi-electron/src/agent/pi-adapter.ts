import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./config";
import type { AgentRuntime, RuntimeHistoryMessage, RuntimeSession, RuntimeSessionDescriptor } from "./runtime";
import { failure } from "./errors";
const parts = (content: unknown): { index: number; text: string }[] => {
  if (typeof content === "string") return [{ index: 0, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => part?.type === "text" && typeof part.text === "string" ? [{ index, text: part.text }] : []);
};
/** SDK-specific types/events stop here. Native history remains owned by Pi. */
export class PiAdapter implements AgentRuntime {
  private readonly sessionDir: string;
  private modelRuntime?: Promise<ModelRuntime>;
  constructor(private readonly config: AgentConfig) {
    this.sessionDir = path.join(config.dataDir, "pi-sessions");
    mkdirSync(this.sessionDir, { recursive: true });
  }
  async createSession(): Promise<RuntimeSessionDescriptor> {
    const manager = SessionManager.create(this.config.cwd, this.sessionDir);
    const filePath = manager.getSessionFile()!;
    // Pi defers writing until its first message. Persist the SDK-generated header
    // now so accepted session.create retains its identity even without a first Run.
    const fd = openSync(filePath, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(manager.getHeader()) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    return { sessionId: manager.getSessionId(), filePath, cwd: this.config.cwd };
  }
  private manager(descriptor: RuntimeSessionDescriptor): SessionManager {
    if (!existsSync(descriptor.filePath)) throw failure("INTERNAL_ERROR", "Pi 会话文件丢失，无法安全恢复历史。");
    const manager = SessionManager.open(descriptor.filePath, this.sessionDir, descriptor.cwd);
    if (manager.getSessionId() !== descriptor.sessionId) throw failure("INTERNAL_ERROR", "Pi 会话身份与应用记录不一致。");
    return manager;
  }
  readHistory(descriptor: RuntimeSessionDescriptor): RuntimeHistoryMessage[] {
    const messages: RuntimeHistoryMessage[] = [];
    let runId: string | undefined;
    let ordinal = 0;
    for (const entry of this.manager(descriptor).getBranch()) {
      if (entry.type === "custom" && entry.customType === "mozi.run") {
        const data = entry.data as { runId?: unknown } | undefined;
        runId = typeof data?.runId === "string" ? data.runId : undefined; ordinal = 0;
      } else if (runId && entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
        messages.push({ runId, role: entry.message.role, ordinal: entry.message.role === "assistant" ? ordinal++ : 0,
          nativeEntryId: entry.id, parts: parts(entry.message.content) });
      }
    }
    return messages;
  }
  async openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession> {
    const manager = this.manager(descriptor);
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
    let cancelled = false;
    return {
      async execute(input, emit) {
        if (cancelled) return;
        let ordinal = -1;
        let observerError: unknown;
        let lastFailure: string | undefined;
        manager.appendCustomEntry("mozi.run", { runId: input.runId, clientMessageId: input.clientMessageId });
        const unsubscribe = session.subscribe((event) => {
          if (cancelled || observerError) return;
          try {
            if (event.type === "message_start" && event.message.role === "assistant") {
              ordinal++; lastFailure = undefined; emit({ type: "message.start", ordinal });
            } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              emit({ type: "message.delta", ordinal, partIndex: event.assistantMessageEvent.contentIndex, delta: event.assistantMessageEvent.delta });
            } else if (event.type === "message_end" && event.message.role === "assistant") {
              if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
                lastFailure = event.message.errorMessage || "模型执行未正常完成。";
              } else emit({ type: "message.complete", ordinal, parts: parts(event.message.content) });
            }
          } catch (error) { observerError = error; void session.abort().catch(() => {}); }
        });
        try {
          await session.prompt(input.content.map((part) => part.text).join("\n"), { expandPromptTemplates: false });
          // Includes automatic retries; agent_end alone is not a Mozi terminal.
          await session.waitForIdle();
          if (observerError) throw observerError;
          if (lastFailure && !cancelled) throw failure("INTERNAL_ERROR", lastFailure);
        } finally { unsubscribe(); }
      },
      async cancel() { cancelled = true; await session.abort(); },
      dispose() { session.dispose(); },
    };
  }
  dispose(): void { /* Each Run disposes its own session; ModelRuntime has no dispose API. */ }
}
