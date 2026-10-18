import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ToolView } from "../../../shared/agent";
import type { AgentMessage } from "./types";

/** Join tool executions to their originating assistant message in native content order. */
export function convertAssistantMessage(message: AgentMessage, tools: readonly ToolView[]): ThreadMessageLike {
  if (message.role === "user") return {
    id: message.id, role: "user",
    content: message.content.filter(part => part.type === "text").map(part => ({ type: "text" as const, text: part.text })),
  };
  type Part = Exclude<ThreadMessageLike["content"], string>[number];
  const content: { index: number; part: Part }[] = message.content.map((part, index) => ({
    index: Number(part.id.match(/:(?:text|reasoning):(\d+)$/)?.[1] ?? index),
    part: { type: part.type, text: part.text },
  }));
  const related = tools.filter(tool => `message:${tool.messageId}` === message.id);
  const active = (tool: ToolView) => ["preparing", "running", "awaiting_approval"].includes(tool.status);
  for (const tool of related) content.push({
    index: tool.partIndex ?? Number.MAX_SAFE_INTEGER,
    part: { type: "tool-call", toolCallId: tool.toolCallId, toolName: tool.toolName,
      argsText: tool.inputText, result: tool.outputText, isPreliminary: active(tool),
      isError: ["failed", "denied", "cancelled", "interrupted"].includes(tool.status) },
  });
  return {
    id: message.id, role: "assistant", content: content.sort((a, b) => a.index - b.index).map(item => item.part),
    metadata: { custom: { responseModelId: message.responseModelId } },
    status: message.status === "cancelled" ? { type: "incomplete", reason: "cancelled" }
      : message.status === "failed" || message.status === "interrupted" ? { type: "incomplete", reason: "error" }
        : message.status === "streaming" || related.some(active) ? { type: "running" }
          : { type: "complete", reason: "stop" },
  };
}
