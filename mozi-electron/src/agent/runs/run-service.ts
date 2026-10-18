import { randomUUID } from "node:crypto";
import type { MessageView, ParamsOf, RunAccepted, RunOutcome, RunView, ResultOf, StartRunInput } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import { isTerminalRun as terminal, transitionRun } from "./run-machine";
import type { MetadataStore } from "../storage/metadata-store";
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from "../runtime/agent-runtime";
import { contentHash } from "./submission";
import type { ApplicationControl } from "../agent-control";
import type { MessageLink } from "../storage/metadata";
import type { SessionService } from "../sessions/session-service";
import type { ModelService } from "../models/model-service";
import type { PreparedModel } from "../models/model-catalog";
import { appError, failure } from "../errors";

const log = createAgentLogger("agent-service");
const now = () => new Date().toISOString();
type Execution = { run: RunView; model?: PreparedModel; cancelled: boolean; session?: RuntimeSession; done: Promise<void> };
export class RunService {
  private readonly active = new Map<string, Execution>();
  private readonly busySessions = new Set<string>();
  constructor(private readonly repository: MetadataStore, private readonly runtime: AgentRuntime,
    private readonly sessions: SessionService,
    private readonly control: ApplicationControl, private readonly models: ModelService) {}

  recover(): void {
    for (const run of this.repository.unfinishedRuns()) {
      transitionRun(run, "interrupted", now());
      run.interruptionReason = "Agent 进程已重启，任务未自动续跑。";
      this.repository.updateRun(run);
      this.sessions.touch(run.sessionId, run.updatedAt);
    }
  }
  async start(input: StartRunInput): Promise<RunAccepted> {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    const duplicate = this.duplicate(input);
    if (duplicate) return duplicate;
    await this.sessions.ensureLoaded(input.sessionId);
    this.control.assertAvailable();
    const selection = this.sessions.model(input.sessionId);
    const prepared = await this.models.prepare(selection);
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    const accepted = this.duplicate(input);
    if (accepted) return accepted;
    const latest = this.sessions.model(input.sessionId);
    if (selection?.providerId !== latest?.providerId || selection?.modelId !== latest?.modelId
      || selection?.thinkingLevel !== latest?.thinkingLevel
      || selection?.webMode !== latest?.webMode
      || selection?.webSearch !== latest?.webSearch || selection?.webExtractor !== latest?.webExtractor) {
      throw failure("SESSION_BUSY", "会话模型已变化，请重新发送。");
    }
    return this.accept(input, prepared);
  }
  get(input: ParamsOf<"run.get">): RunView {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    return structuredClone(this.run(input.sessionId, input.runId));
  }
  cancel(input: ParamsOf<"run.cancel">): ResultOf<"run.cancel"> {
    this.control.assertAvailable(); this.sessions.assertExists(input.sessionId);
    const run = this.run(input.sessionId, input.runId);
    if (terminal(run)) return { ...input, disposition: "already_finished", status: run.status as RunOutcome["status"] };
    const execution = this.active.get(run.id);
    if (!execution) throw failure("RUNTIME_UNAVAILABLE", "任务执行器不可用，请重新同步。");
    execution.cancelled = true;
    if (transitionRun(run, "cancelling", now())) {
      this.sessions.applyRunUpdated(run.sessionId, run);
    }
    if (execution.session) void execution.session.cancel().catch(error => this.control.fail(error));
    return { ...input, disposition: "requested" };
  }
  private duplicate(input: StartRunInput): RunAccepted | undefined {
    const duplicate = this.repository.findSubmission(input.sessionId, input.clientMessageId);
    if (duplicate) {
      if (duplicate.contentHash !== contentHash(input.content)) throw failure("SUBMISSION_CONFLICT", "同一 clientMessageId 的消息内容发生变化。");
      return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: duplicate.runId, messageId: duplicate.messageId, disposition: "duplicate" };
    }
  }

  private accept(input: StartRunInput, prepared?: PreparedModel): RunAccepted {
    // Check again after async history loading: simultaneous retries share one acceptance.
    const duplicate = this.duplicate(input);
    if (duplicate) return duplicate;
    const hash = contentHash(input.content);
    if (this.busySessions.has(input.sessionId)) throw failure("SESSION_BUSY", "当前会话仍有正在执行的任务。");
    if (this.active.size >= 8) throw failure("CAPACITY_EXCEEDED", "同时运行的任务过多。");
    if (prepared && !this.sessions.model(input.sessionId)) this.sessions.bindModel(input.sessionId, prepared.selection);
    const run: RunView = { ...(prepared ? { model: prepared.selection, modelConfigVersion: prepared.configVersion } : {}), id: randomUUID(), sessionId: input.sessionId, userMessageId: randomUUID(), status: "accepted", createdAt: now(), updatedAt: now() };
    const message: MessageView = {
      id: run.userMessageId, sessionId: input.sessionId, runId: run.id, clientMessageId: input.clientMessageId,
      role: "user", status: "accepted", content: input.content.map((part, index) => ({ ...part, id: this.partId(run.userMessageId, index) })),
    };
    const link: MessageLink = { messageId: message.id, runId: run.id, role: "user", ordinal: 0 };
    const execution: Execution = { run, model: prepared, cancelled: false, done: Promise.resolve() };
    this.busySessions.add(input.sessionId);
    this.active.set(run.id, execution);
    try {
      this.sessions.applyRunAccepted(input.sessionId, {
        metadata: { run, clientMessageId: input.clientMessageId, contentHash: hash, pendingContent: input.content }, message, link,
      });
    } catch (error) {
      this.active.delete(run.id); this.busySessions.delete(input.sessionId);
      throw error;
    }
    execution.done = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.execute(run, input, execution)).catch(error => { if (!this.control.isFailed()) this.control.fail(error); });
    return { sessionId: input.sessionId, clientMessageId: input.clientMessageId, runId: run.id, messageId: message.id, disposition: "accepted" };
  }

  private async execute(run: RunView, input: StartRunInput, execution: Execution): Promise<void> {
    const descriptor = this.sessions.descriptor(run.sessionId);
    let outcome: RunOutcome = { status: "completed" };
    try {
      if (!execution.cancelled) execution.session = await (execution.model
        ? execution.model.openSession(descriptor) : this.runtime.openSession(descriptor));
      if (!execution.cancelled) {
        transitionRun(run, "running", now());
        this.sessions.applyRunUpdated(run.sessionId, run, true);
        await execution.session!.execute({ runId: run.id, clientMessageId: input.clientMessageId, content: input.content },
          event => { if (!this.control.isFailed() && (!execution.cancelled || event.type === "tool.update" || event.type === "usage.update" || event.type === "message.model" || event.type === "session.title") && !terminal(run)) this.output(run, event); });
      }
      if (execution.cancelled) outcome = { status: "cancelled" };
    } catch (error) {
      outcome = execution.cancelled ? { status: "cancelled" } : { status: "failed", error: appError(error) };
    } finally {
      const links: MessageLink[] = [];
      try {
        const session = execution.session;
        execution.session = undefined;
        session?.dispose();
        // Only update mappings belonging to this Run. History does not trigger row rewrites.
        for (const native of this.control.isFailed() ? [] : await this.runtime.readHistory(descriptor)) {
          if (native.runId !== run.id) continue;
          const link = this.sessions.findMessageLink(run.sessionId, run.id, native.role, native.ordinal);
          if (link && link.nativeEntryId !== native.nativeEntryId) { link.nativeEntryId = native.nativeEntryId; links.push(link); }
        }
      } catch (error) {
        if (outcome.status === "completed") outcome = { status: "failed", error: appError(error) };
      }
      // Cancellation can arrive while native-history reconciliation is awaiting I/O.
      if (execution.cancelled) outcome = { status: "cancelled" };
      try { if (!this.control.isFailed()) this.finish(run, outcome, links); }
      finally { this.active.delete(run.id); this.busySessions.delete(run.sessionId); }
    }
  }

  private output(run: RunView, event: RuntimeEvent): void {
    if (event.type === "usage.update") {
      if (event.call.runId !== run.id) throw failure("PROTOCOL_MISMATCH", "用量记录与当前任务不匹配。");
      this.sessions.reportUsage(run.sessionId, event.call);
      return;
    }
    if (event.type === "session.title") {
      this.sessions.updateAutomaticTitle(run.sessionId, event.title, run.id);
      return;
    }
    if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时消息序号。");
    let link = this.sessions.findMessageLink(run.sessionId, run.id, "assistant", event.ordinal);
    if (!link) {
      link = { messageId: randomUUID(), runId: run.id, role: "assistant", ordinal: event.ordinal };
      const message: MessageView = { id: link.messageId, sessionId: run.sessionId, runId: run.id, role: "assistant", status: "streaming", content: [] };
      this.sessions.applyAssistantStarted(run.sessionId, { message, link });
    }
    const messageId = link.messageId;
    if (event.type === "tool.update") {
      const tool = { ...event.tool, runId: run.id, messageId };
      this.sessions.reportTool(run.sessionId, tool);
      return;
    }
    if (!this.sessions.isMessageStreaming(run.sessionId, messageId)) return;
    if (event.type === "message.model") {
      this.sessions.reportResponseModel(run.sessionId, run.id, messageId, event.responseModelId);
    } else if (event.type === "message.delta" || event.type === "message.reasoning.delta") {
      const type = event.type === "message.delta" ? "text" : "reasoning";
      const partId = this.partId(messageId, event.partIndex, type);
      this.sessions.appendMessageDelta(run.sessionId, run.id, { messageId, partId, type, delta: event.delta });
    } else if (event.type === "message.complete") {
      const content = event.parts.map(part => ({ id: this.partId(messageId, part.index, part.type), type: part.type, text: part.text }));
      if (new Set(content.map(part => part.id)).size !== content.length) throw failure("PROTOCOL_MISMATCH", "重复的运行时内容块。");
      const links: MessageLink[] = [];
      if (event.nativeEntryId && link.nativeEntryId !== event.nativeEntryId) { link.nativeEntryId = event.nativeEntryId; links.push(link); }
      this.sessions.applyMessageCompleted(run.sessionId, run.id, { messageId, content, links });
    }
  }

  private finish(run: RunView, outcome: RunOutcome, links: MessageLink[]): void {
    if (!transitionRun(run, outcome.status, now())) return;
    if (outcome.status === "failed") run.error = { ...outcome.error, message: outcome.error.message.slice(0, 8_000) };
    if (outcome.status === "interrupted") run.interruptionReason = outcome.reason;
    this.sessions.applyRunFinished(run.sessionId, {
      run, outcome: outcome.status === "failed" ? { status: "failed", error: run.error! } : outcome, links,
    });
    log.info("run.finished", { sessionId: run.sessionId, runId: run.id, status: outcome.status });
  }

  private partId(messageId: string, index: number, type: "text" | "reasoning" = "text"): string {
    if (!Number.isSafeInteger(index) || index < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时内容块序号。");
    return `${messageId}:${type}:${index}`;
  }
  private run(sessionId: string, runId: string): RunView {
    const run = this.active.get(runId)?.run ?? this.repository.findRun(sessionId, runId);
    if (!run || run.sessionId !== sessionId) throw failure("RUN_NOT_FOUND", "任务不存在。");
    return run;
  }
  cancelAll(): void {
    for (const execution of this.active.values()) {
      execution.cancelled = true;
      if (execution.session) void execution.session.cancel().catch(error => this.control.fail(error));
    }
  }
  async close(): Promise<void> {
    this.cancelAll();
    await Promise.all([...this.active.values()].map(execution => execution.done));
  }
}
