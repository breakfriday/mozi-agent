import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../../agent-runtime";
import { failure } from "../../../errors";
import { titleFromFirstMessage } from "../../../sessions/session-title";
import { observeModelCalls } from "../model-call/observer";
import { PiEventMapper } from "./event-mapper";
import { displayParts } from "./content-mapper";
import { createUsageEntry, createResponseModelEntry } from "./session-entries";
import { ToolExecutionCollector } from "./tool-execution-collector";

/** Owns event observation and model-call hooks for one execution, never the SDK session. */
export function observeExecution(session: AgentSession, manager: SessionManager, options: {
  runId: string;
  emit: (event: RuntimeEvent) => void;
  isCancelled: () => boolean;
  onError: () => void;
}) {
  const mapper = new PiEventMapper();
  const tools = new ToolExecutionCollector(options.emit);
  const pending = new Map<object, string>();
  let observationFailure: { error: unknown } | undefined;
  let titlePublished = false;
  let disposed = false;
  let unsubscribe = () => {};
  const modelCalls = observeModelCalls(session.agent, {
    runId: options.runId,
    onCallUpdated: call => {
      const entry = createUsageEntry(call);
      manager.appendCustomEntry(entry.customType, entry.data);
      options.emit({ type: "usage.update", call });
    },
  });
  const fail = (error: unknown) => {
    if (observationFailure) return;
    observationFailure = { error };
    if (!disposed) options.onError();
  };
  const persistEvidence = () => {
    if (!pending.size) return;
    for (const entry of manager.getBranch()) {
      if (entry.type !== "message") continue;
      const responseModelId = pending.get(entry.message);
      if (!responseModelId) continue;
      const evidence = createResponseModelEntry({
        nativeEntryId: entry.id,
        responseModelId,
      });
      manager.appendCustomEntry(evidence.customType, evidence.data);
      pending.delete(entry.message);
    }
  };
  const publishTitle = () => {
    if (titlePublished || observationFailure || disposed) return;
    const first = manager.getEntries().find(
      entry => entry.type === "message" && entry.message.role === "user",
    );
    if (!first || first.type !== "message" || first.message.role !== "user") return;
    titlePublished = true;
    options.emit({
      type: "session.title",
      title: manager.getSessionName() || titleFromFirstMessage(
        displayParts(first.message.content, false).map(part => part.text).join("\n"),
      ),
    });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe(); }
    catch (error) { fail(error); }
    finally {
      // A failed unsubscribe must not leave streamFunction wrapped or calls unsettled.
      try { modelCalls.dispose(); }
      catch (error) { fail(error); }
      finally {
        pending.clear();
        try { tools.finish(options.isCancelled()); }
        catch (error) { fail(error); }
      }
    }
  };

  try {
    // Session events and provider stream events are separate inputs with different timing.
    unsubscribe = session.subscribe(event => {
      if (disposed || observationFailure) return;
      try {
        if (event.type === "message_end" && event.message.role === "user") {
          // Pi emits message_end before its synchronous native write. Read in a microtask.
          void Promise.resolve().then(publishTitle).catch(fail);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const responseModelId = modelCalls.getResponseModel(event.message);
          if (responseModelId) {
            pending.set(event.message, responseModelId);
            options.emit({ type: "message.model", ordinal: mapper.currentOrdinal, responseModelId });
          }
        }
        if (event.type === "turn_end" || event.type === "agent_end") persistEvidence();
        const output = mapper.map(event);
        if (output && !options.isCancelled()) options.emit(output);
        tools.collect(event, mapper.currentOrdinal);
      } catch (error) { fail(error); }
    });
  } catch (error) {
    // Installation owns rollback until the fully initialized observer is returned.
    dispose();
    throw error;
  }

  return {
    flush() {
      if (disposed) return;
      publishTitle();
      persistEvidence();
    },
    throwIfFailed() {
      if (observationFailure) throw observationFailure.error;
      if (modelCalls.error) throw modelCalls.error;
      if (mapper.lastFailure && !options.isCancelled())
        throw failure("INTERNAL_ERROR", mapper.lastFailure);
    },
    dispose,
  };
}
