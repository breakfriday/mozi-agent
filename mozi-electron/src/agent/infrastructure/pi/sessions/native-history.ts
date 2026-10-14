import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { RuntimeHistoryMessage, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../../../application/ports/agent-runtime";
import { failure } from "../../../application/errors";
import type { PiConfig } from "../types";
import { displayParts } from "./event-mapper";
import { RESPONSE_MODEL_ENTRY, validResponseModel } from "../model-call/response-model-collector";
import { EMPTY_SESSION_TITLE, titleFromFirstMessage } from "../../../domain/session-title";
import { isModelCallView, type ModelCallView } from "../../../../../../shared/agent";
import { normalizeUsage, USAGE_ENTRY } from "../model-call/usage-collector";

/** Native identity and history stay within the Pi integration boundary. */
export class PiNativeHistory {
  private readonly active = new Map<string, SessionManager>();
  private readonly sessionDir: string;
  constructor(private readonly config: Pick<PiConfig, "cwd" | "dataDir">) {
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
    return { sessionId: manager.getSessionId(), engine: "pi", locator: filePath, cwd: this.config.cwd };
  }
  open(descriptor: RuntimeSessionDescriptor): SessionManager {
    if (descriptor.engine !== "pi") throw failure("UNSUPPORTED_CAPABILITY", "当前适配器不支持此会话引擎。");
    if (!existsSync(descriptor.locator)) throw failure("INTERNAL_ERROR", "Pi 会话文件丢失，无法安全恢复历史。");
    const manager = SessionManager.open(descriptor.locator, this.sessionDir, descriptor.cwd);
    if (manager.getSessionId() !== descriptor.sessionId) throw failure("INTERNAL_ERROR", "Pi 会话身份与应用记录不一致。");
    return manager;
  }
  deleteSession(descriptor: RuntimeSessionDescriptor): void {
    if (this.active.has(descriptor.sessionId)) throw failure("SESSION_BUSY", "会话正在执行，请先停止任务再删除。");
    if (descriptor.engine !== "pi") throw failure("UNSUPPORTED_CAPABILITY", "当前适配器不支持此会话引擎。");
    const inside = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const locator = path.resolve(descriptor.locator);
    if (!inside(path.resolve(this.sessionDir), locator) || path.extname(locator) !== ".jsonl") {
      throw failure("PERMISSION_DENIED", "只能永久删除本应用管理的 Pi 会话文件。");
    }
    try {
      const stat = lstatSync(locator, { throwIfNoEntry: false });
      // A previous attempt may have removed the file before metadata committed.
      if (!stat) return;
      if (!stat.isFile() || stat.isSymbolicLink()
        || !inside(realpathSync(this.sessionDir), realpathSync(locator))) {
        throw failure("PERMISSION_DENIED", "会话文件路径不安全，未执行永久删除。");
      }
      this.open(descriptor); // Verify native session identity before unlinking.
      unlinkSync(locator);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && ["PERMISSION_DENIED", "INTERNAL_ERROR"].includes(String(error.code))) throw error;
      throw failure("INTERNAL_ERROR", "无法删除 Pi 会话文件，会话记录已保留，请检查文件权限后重试。");
    }
  }
  acquire(descriptor: RuntimeSessionDescriptor): SessionManager {
    if (this.active.has(descriptor.sessionId)) throw failure("SESSION_BUSY", "会话正在执行。");
    const manager = this.open(descriptor);
    this.active.set(descriptor.sessionId, manager);
    return manager;
  }
  release(descriptor: RuntimeSessionDescriptor): void { this.active.delete(descriptor.sessionId); }
  setSessionName(descriptor: RuntimeSessionDescriptor, name: string): void {
    // Reuse the live writer so its leaf cursor includes the name entry.
    const manager = this.active.get(descriptor.sessionId) ?? this.open(descriptor);
    if (manager.getSessionName() !== name) manager.appendSessionInfo(name);
  }
  async listSessions(): Promise<RuntimeSessionInfo[]> {
    // Search the application's native directory across working directories.
    const sessions = await SessionManager.listAll(this.sessionDir);
    return sessions.map(session => ({
      descriptor: { sessionId: session.id, engine: "pi", locator: session.path, cwd: session.cwd || this.config.cwd },
      ...(session.name ? { name: session.name } : {}),
      title: session.name || (session.messageCount ? titleFromFirstMessage(session.firstMessage) : EMPTY_SESSION_TITLE),
      createdAt: session.created.toISOString(), updatedAt: session.modified.toISOString(),
    }));
  }
  async readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]> {
    const messages: RuntimeHistoryMessage[] = [];
    let runId: string | undefined;
    let ordinal = 0, seenUser = false;
    const branch = this.open(descriptor).getBranch();
    const responseModels = new Map<string, string>();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== RESPONSE_MODEL_ENTRY) continue;
      const data = entry.data as { nativeEntryId?: unknown; responseModelId?: unknown } | undefined;
      if (typeof data?.nativeEntryId === "string" && validResponseModel(data.responseModelId)) {
        responseModels.set(data.nativeEntryId, data.responseModelId);
      }
    }
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === "mozi.run") {
        const data = entry.data as { runId?: unknown } | undefined;
        runId = typeof data?.runId === "string" ? data.runId : undefined;
        ordinal = 0; seenUser = false;
      } else if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
        // Native/imported messages need no Mozi marker. An external continuation
        // must not inherit the previous Mozi Run's IDs or ordinal mappings.
        if (entry.message.role === "user") {
          if (seenUser) { runId = undefined; ordinal = 0; }
          seenUser = true;
        }
        const stop = entry.message.role === "assistant" ? entry.message.stopReason : undefined;
        messages.push({ ...(runId ? { runId } : {}), role: entry.message.role,
          ordinal: entry.message.role === "assistant" ? ordinal++ : 0,
          nativeEntryId: entry.id, createdAt: entry.timestamp,
          status: stop === "error" ? "failed" : stop === "aborted" ? "cancelled" : "completed",
          ...(entry.message.role === "assistant" && responseModels.has(entry.id) ? { responseModelId: responseModels.get(entry.id) } : {}),
          parts: displayParts(entry.message.content, entry.message.role === "assistant") });
      }
    }
    return messages;
  }
  async readUsage(descriptor: RuntimeSessionDescriptor): Promise<ModelCallView[]> {
    // Consumption includes all recorded branches, even if no longer in the current context.
    const entries = this.open(descriptor).getEntries();
    const calls = new Map<string, ModelCallView>();
    const monitoredRuns = new Set<string>();
    const responseModels = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === RESPONSE_MODEL_ENTRY) {
        const data = entry.data as { nativeEntryId?: unknown; responseModelId?: unknown } | undefined;
        if (typeof data?.nativeEntryId === "string" && validResponseModel(data.responseModelId)) responseModels.set(data.nativeEntryId, data.responseModelId);
      }
      if (entry.type !== "custom" || entry.customType !== USAGE_ENTRY || !isModelCallView(entry.data)) continue;
      const call = entry.data;
      calls.set(call.id, call.status === "running" ? { ...call, status: "interrupted" } : call);
      if (call.runId) monitoredRuns.add(call.runId);
    }
    let runId: string | undefined, thinkingLevel: string | undefined;
    let seenUser = false;
    for (const entry of entries) {
      if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
      if (entry.type === "custom" && entry.customType === "mozi.run") {
        const data = entry.data as { runId?: unknown } | undefined;
        runId = typeof data?.runId === "string" ? data.runId : undefined; seenUser = false;
      }
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") {
        if (seenUser) runId = undefined;
        seenUser = true;
      }
      if (entry.message.role !== "assistant" || (runId && monitoredRuns.has(runId))) continue;
      const message = entry.message;
      const usage = normalizeUsage(message.usage);
      const call: ModelCallView = { id: `native:${entry.id}`, nativeEntryId: entry.id,
        ...(runId ? { runId } : {}), provider: message.provider, model: message.model,
        ...(responseModels.has(entry.id) ? { responseModelId: responseModels.get(entry.id) } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}), startedAt: entry.timestamp,
        status: message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed",
        ...(usage ? { usage } : {}) };
      calls.set(call.id, call);
    }
    return [...calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
