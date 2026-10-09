export const EMPTY_SESSION_TITLE = "新会话";

/** A display fallback, never an explicit native session name. */
export function titleFromFirstMessage(text: string): string {
  return Array.from(text.replace(/\s+/gu, " ").trim()).slice(0, 80).join("") || EMPTY_SESSION_TITLE;
}
