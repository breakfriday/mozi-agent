import type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeSession } from "../../application/ports/agent-runtime";
import { failure } from "../../application/errors";
import { PiEventMapper } from "./event-mapper";
import { RESPONSE_MODEL_ENTRY } from "./response-model";
import { titleFromFirstMessage } from "../../domain/session-title";
import { displayParts } from "./event-mapper";
import { USAGE_ENTRY } from "./usage-monitor";
import { observeModelCalls } from "./model-call-observer";

/** Owns the SDK session, event subscription and cancellation for one execution. */
export class PiExecution implements RuntimeSession {
  private cancelled = false;
  private cancelPromise?: Promise<void>;
  private disposed = false;
  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly release: () => void = () => {},
  ) {}
  async execute(
    input: Parameters<RuntimeSession["execute"]>[0],
    emit: Parameters<RuntimeSession["execute"]>[1],
  ): Promise<void> {
    if (this.cancelled) return;
    const mapper = new PiEventMapper();
    this.manager.appendCustomEntry("mozi.run", {
      runId: input.runId,
      clientMessageId: input.clientMessageId,
    });
    const observer = observeModelCalls(this.session.agent, {
      runId: input.runId,
      onCallUpdated: (call) => {
        this.manager.appendCustomEntry(USAGE_ENTRY, call);
        emit({ type: "usage.update", call });
      },
    });
    const pending = new Map<object, string>();
    const persistEvidence = () => {
      if (!pending.size) return;
      for (const entry of this.manager.getBranch()) {
        if (entry.type !== "message") continue;
        const responseModelId = pending.get(entry.message);
        if (!responseModelId) continue;
        this.manager.appendCustomEntry(RESPONSE_MODEL_ENTRY, {
          nativeEntryId: entry.id,
          responseModelId,
        });
        pending.delete(entry.message);
      }
    };
    let observerError: unknown;
    let titlePublished = false;
    const publishTitle = () => {
      if (titlePublished || observerError || this.disposed) return;
      const first = this.manager
        .getEntries()
        .find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      if (!first || first.type !== "message" || first.message.role !== "user")
        return;
      titlePublished = true;
      emit({
        type: "session.title",
        title:
          this.manager.getSessionName() ||
          titleFromFirstMessage(
            displayParts(first.message.content, false)
              .map((part) => part.text)
              .join("\n"),
          ),
      });
    };
    let unsubscribe = () => {};
    try {
      // Pi's session events are a separate input from raw provider events in the observer.
      unsubscribe = this.session.subscribe((event) => {
        if (observerError) return;
        try {
          if (event.type === "message_end" && event.message.role === "user") {
            // SDK notifies message_end listeners before appending the message.
            // The microtask runs after its synchronous native write, before model output.
            void Promise.resolve()
              .then(publishTitle)
              .catch((error) => {
                observerError = error;
                void this.session.abort().catch(() => {});
              });
          }
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            const responseModelId = observer.getResponseModel(event.message);
            if (responseModelId) {
              pending.set(event.message, responseModelId);
              emit({
                type: "message.model",
                ordinal: mapper.currentOrdinal,
                responseModelId,
              });
            }
          }
          if (event.type === "turn_end" || event.type === "agent_end")
            persistEvidence();
          const output = mapper.map(event);
          if (output && !this.cancelled) emit(output);
        } catch (error) {
          observerError = error;
          void this.session.abort().catch(() => {});
        }
      });
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(new Date());
      await this.session.sendCustomMessage(
        {
          customType: "mozi.prompt-time",
          content: `本轮用户消息的本地时间：${localTime}（${timeZone}）。`,
          display: false,
        },
        { triggerTurn: false },
      );
      await this.session.prompt(
        input.content.map((part) => part.text).join("\n"),
        { expandPromptTemplates: false },
      );
      // Includes retries. Neither agent_end nor message_end proves the Run is durable/finished.
      await this.session.waitForIdle();
      publishTitle();
      persistEvidence();
      if (observerError) throw observerError;
      if (observer.error) throw observer.error;
      if (mapper.lastFailure && !this.cancelled)
        throw failure("INTERNAL_ERROR", mapper.lastFailure);
    } finally {
      unsubscribe();
      observer.dispose();
    }
    // Disposal may publish an interrupted call; persistence/delivery errors still fail the run.
    if (observer.error) throw observer.error;
  }
  cancel(): Promise<void> {
    this.cancelled = true;
    return (this.cancelPromise ??= this.session.abort());
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.session.dispose();
    } finally {
      this.release();
    }
  }
}
