import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeHistoryMessage, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../../application/ports/agent-runtime";
import { failure } from "../../application/errors";
import type { PiConfig } from "./session-factory";
import { textParts } from "./event-mapper";

/** Native identity and history stay within the Pi integration boundary. */
export class PiNativeHistory {
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
  async listSessions(): Promise<RuntimeSessionInfo[]> {
    // Search the application's native directory across working directories.
    const sessions = await SessionManager.listAll(this.sessionDir);
    return sessions.map(session => ({
      descriptor: { sessionId: session.id, engine: "pi", locator: session.path, cwd: session.cwd || this.config.cwd },
      title: session.name || session.firstMessage.slice(0, 80) || "新会话",
      createdAt: session.created.toISOString(), updatedAt: session.modified.toISOString(),
    }));
  }
  async readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]> {
    const messages: RuntimeHistoryMessage[] = [];
    let runId: string | undefined;
    let ordinal = 0, seenUser = false;
    for (const entry of this.open(descriptor).getBranch()) {
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
          parts: textParts(entry.message.content) });
      }
    }
    return messages;
  }
}
