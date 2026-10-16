import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { RuntimeHistoryMessage, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../../agent-runtime";
import { failure } from "../../../errors";
import type { PiConfig } from "../types";
import { EMPTY_SESSION_TITLE, titleFromFirstMessage } from "../../../sessions/session-title";
import type { ModelCallView } from "../../../../../../shared/agent";
import { readHistory, readUsage } from "./history-reader";

/** Owns native session storage, identity checks and active writer reservations. */
export class PiSessionStore {
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
    return readHistory(this.open(descriptor).getBranch());
  }
  async readUsage(descriptor: RuntimeSessionDescriptor): Promise<ModelCallView[]> {
    // Consumption includes all recorded branches, even if no longer in the current context.
    return readUsage(this.open(descriptor).getEntries());
  }
}
