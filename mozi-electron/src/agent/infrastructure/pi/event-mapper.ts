import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../../application/ports/agent-runtime";

export const textParts = (content: unknown): { index: number; text: string }[] => {
  if (typeof content === "string") return [{ index: 0, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => part?.type === "text" && typeof part.text === "string" ? [{ index, text: part.text }] : []);
};

/** Per-execution mapper. No Mozi IDs, seq, persistence or public event envelopes. */
export class PiEventMapper {
  private ordinal = -1;
  lastFailure?: string;
  map(event: AgentSessionEvent): RuntimeEvent | undefined {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.ordinal++; this.lastFailure = undefined;
      return { type: "message.start", ordinal: this.ordinal };
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      return { type: "message.delta", ordinal: this.ordinal,
        partIndex: event.assistantMessageEvent.contentIndex, delta: event.assistantMessageEvent.delta };
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        this.lastFailure = event.message.errorMessage || "模型执行未正常完成。";
      } else return { type: "message.complete", ordinal: this.ordinal, parts: textParts(event.message.content) };
    }
  }
}
