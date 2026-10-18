import { failure } from "../errors";

export const linkKey = (runId: string, role: string, ordinal: number): string => `${runId}:${role}:${ordinal}`;

/** Live output and rebuilt history use the same application part identity. */
export function partId(messageId: string, index: number, type: "text" | "reasoning" = "text"): string {
  if (!Number.isSafeInteger(index) || index < 0) throw failure("PROTOCOL_MISMATCH", "无效的运行时内容块序号。");
  return `${messageId}:${type}:${index}`;
}
