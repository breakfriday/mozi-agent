import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../../agent-runtime";
import { displayParts } from "./content-mapper";

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
