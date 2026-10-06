import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeSession } from "../../application/ports/agent-runtime";
import { failure } from "../../application/errors";
import { PiEventMapper } from "./event-mapper";

/** Owns the SDK session, event subscription and cancellation for one execution. */
export class PiExecution implements RuntimeSession {
  private cancelled = false;
  private cancelPromise?: Promise<void>;
  private disposed = false;
  constructor(private readonly session: AgentSession, private readonly manager: SessionManager) {}
  async execute(input: Parameters<RuntimeSession["execute"]>[0], emit: Parameters<RuntimeSession["execute"]>[1]): Promise<void> {
    if (this.cancelled) return;
    const mapper = new PiEventMapper();
    let observerError: unknown;
    this.manager.appendCustomEntry("mozi.run", { runId: input.runId, clientMessageId: input.clientMessageId });
    const unsubscribe = this.session.subscribe(event => {
      if (this.cancelled || observerError) return;
      try {
        const output = mapper.map(event);
        if (output) emit(output);
      } catch (error) { observerError = error; void this.session.abort().catch(() => {}); }
    });
    try {
      await this.session.prompt(input.content.map(part => part.text).join("\n"), { expandPromptTemplates: false });
      // Includes retries. Neither agent_end nor message_end proves the Run is durable/finished.
      await this.session.waitForIdle();
      if (observerError) throw observerError;
      if (mapper.lastFailure && !this.cancelled) throw failure("INTERNAL_ERROR", mapper.lastFailure);
    } finally { unsubscribe(); }
  }
  cancel(): Promise<void> {
    this.cancelled = true;
    return this.cancelPromise ??= this.session.abort();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }
}
