import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../../../../../shared/agent";
import type { PiModelBinding } from "../types";

export function thinkingLevels(
  model: PiModelBinding["model"],
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  const levels = THINKING_LEVELS.filter(
    (level) =>
      model.thinkingLevelMap?.[level] !== null &&
      (!(level === "xhigh" || level === "max") ||
        model.thinkingLevelMap?.[level] !== undefined),
  );
  const compat =
    model.compat && "thinkingFormat" in model.compat ? model.compat : undefined;
  // This Qwen compatibility path sends only enable_thinking, without an effort or budget.
  if (
    model.api === "openai-completions" &&
    compat?.thinkingFormat === "qwen" &&
    compat.supportsReasoningEffort === false &&
    !compat.supportsThinkingTokenBudget &&
    !compat.thinkingTokenBudgetField &&
    !model.samplingParamsByThinkingLevel
  ) {
    const enabled = levels.includes("medium")
      ? "medium"
      : levels.find((level) => level !== "off");
    return levels.filter((level) => level === "off" || level === enabled);
  }
  return levels;
}

export function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}
