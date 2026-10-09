import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeContentPart, RuntimeEvent } from "../../application/ports/agent-runtime";

// Preserve native indices and expose only displayable text, never signatures or opaque data.
export const displayParts = (content: unknown, includeReasoning = true): RuntimeContentPart[] => {
  if (typeof content === "string") return [{ index: 0, type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index): RuntimeContentPart[] => {
    if (part?.type === "text" && typeof part.text === "string") return [{ index, type: "text", text: part.text }];
    if (includeReasoning && part?.type === "thinking" && typeof part.thinking === "string") {
      return [{ index, type: "reasoning", text: part.thinking }];
    }
    return [];
  });
};

/** Per-execution mapper. No Mozi IDs, seq, persistence or public event envelopes. */
export class PiEventMapper {
  private ordinal = -1;
  lastFailure?: string;
  get currentOrdinal(): number { return this.ordinal; }
  map(event: AgentSessionEvent): RuntimeEvent | undefined {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.ordinal++; this.lastFailure = undefined;
      return { type: "message.start", ordinal: this.ordinal };
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      return { type: "message.delta", ordinal: this.ordinal,
        partIndex: event.assistantMessageEvent.contentIndex, delta: event.assistantMessageEvent.delta };
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      return { type: "message.reasoning.delta", ordinal: this.ordinal,
        partIndex: event.assistantMessageEvent.contentIndex, delta: event.assistantMessageEvent.delta };
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        this.lastFailure = event.message.errorMessage || "模型执行未正常完成。";
      } else return { type: "message.complete", ordinal: this.ordinal, parts: displayParts(event.message.content) };
    }
  }
}
