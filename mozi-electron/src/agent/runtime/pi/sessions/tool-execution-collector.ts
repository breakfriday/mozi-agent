import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, RuntimeTool } from "../../agent-runtime";

const MAX_TEXT = 32_000;
const bounded = (value: string) => value.slice(0, MAX_TEXT);

/** Retain displayable text only: images, signatures and opaque tool details stay in Pi. */
export function toolOutput(result: unknown): { outputText: string; outputTruncated: boolean } {
  const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
  const text = Array.isArray(content) ? content.map(part => {
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (part?.type === "image") return "[图片结果]";
    return "";
  }).filter(Boolean).join("\n") : "";
  return { outputText: bounded(text), outputTruncated: text.length > MAX_TEXT };
}

export function toolCalls(content: unknown): RuntimeTool[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, partIndex): RuntimeTool[] => {
    if (part?.type !== "toolCall" || typeof part.id !== "string" || !part.id
      || typeof part.name !== "string" || !part.name) return [];
    const args = JSON.stringify(part.arguments ?? {});
    return [{ toolCallId: part.id, toolName: part.name, partIndex,
      status: "preparing", inputText: bounded(args), outputText: "", outputTruncated: false,
      ...(args.length > MAX_TEXT ? { summary: "参数过长，已截断展示。" } : {}) }];
  });
}

/** One execution owns this collector; results are keyed by call ID, never by tool name. */
export class ToolExecutionCollector {
  private readonly calls = new Map<string, { ordinal: number; tool: RuntimeTool }>();
  constructor(private readonly emit: (event: RuntimeEvent) => void) {}
  private publish(call: { ordinal: number; tool: RuntimeTool }): void {
    this.emit({ type: "tool.update", ordinal: call.ordinal, tool: { ...call.tool } });
  }
  collect(event: AgentSessionEvent, ordinal: number): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const tool of toolCalls(event.message.content)) {
        if (this.calls.has(tool.toolCallId)) continue;
        const call = { ordinal, tool };
        this.calls.set(tool.toolCallId, call);
        this.publish(call);
      }
      return;
    }
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update"
      && event.type !== "tool_execution_end") return;
    const call = this.calls.get(event.toolCallId);
    if (!call || !["preparing", "running"].includes(call.tool.status)) return;
    if (event.type === "tool_execution_start") call.tool.status = "running";
    else {
      // Pi updates are snapshots, not deltas. Replacing avoids duplicated bash output.
      Object.assign(call.tool, toolOutput(event.type === "tool_execution_end" ? event.result : event.partialResult));
      call.tool.status = event.type === "tool_execution_end" ? (event.isError ? "failed" : "succeeded") : "running";
    }
    this.publish(call);
  }
  finish(cancelled: boolean): void {
    for (const call of this.calls.values()) {
      if (!["preparing", "running"].includes(call.tool.status)) continue;
      call.tool.status = cancelled ? "cancelled" : "interrupted";
      this.publish(call);
    }
  }
}
