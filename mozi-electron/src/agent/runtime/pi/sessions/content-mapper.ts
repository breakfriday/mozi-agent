import type { RuntimeContentPart } from "../../agent-runtime";

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
