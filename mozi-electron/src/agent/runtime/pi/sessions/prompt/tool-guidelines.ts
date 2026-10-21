import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Collect active custom-tool rules once at session creation, preserving flow blocks. */
export function collectToolGuidelines(
  tools: readonly Pick<ToolDefinition, "promptGuidelines">[],
): string[] {
  return [...new Set(tools.flatMap(tool =>
    (tool.promptGuidelines ?? []).map(rule => rule.trim()).filter(Boolean),
  ))];
}
