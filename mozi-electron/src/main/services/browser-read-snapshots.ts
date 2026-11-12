import { BROWSER_MAX_TEXT, BrowserFailure, type BrowserResult } from "../../../../shared/browser";

type ReadResult = Extract<BrowserResult, { kind: "read" }>;
export type ReadSnapshot = {
  sessionId: string;
  navigation: number;
  url: string;
  fullContent: string;
  capturedAt: number;
  result: ReadResult;
};
export const MAX_SNAPSHOT_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const MAX_SESSIONS = 4;
const TTL_MS = 10 * 60_000;

/** UTF-16 offsets are exact; never silently move a caller's starting position. */
export function sliceReadText(text: string, offset: number, limit = BROWSER_MAX_TEXT): string {
  const high = (n: number) => n >= 0xd800 && n <= 0xdbff;
  const low = (n: number) => n >= 0xdc00 && n <= 0xdfff;
  if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= text.length)) {
    throw new BrowserFailure("INVALID_ARGUMENT", `读取偏移量(${offset})超出快照范围，请从 offset=0 重新读取。`);
  }
  if (offset > 0 && high(text.charCodeAt(offset - 1)) && low(text.charCodeAt(offset))) {
    throw new BrowserFailure("INVALID_ARGUMENT", "读取偏移位于 UTF-16 代理对中间，请使用上次 offset + content.length。");
  }
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  return text.slice(offset, end);
}

/** Host-only snapshots; bounded, session-owned, and never silently rebuilt on cache miss. */
export class BrowserReadSnapshots {
  private readonly entries = new Map<string, ReadSnapshot>();
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void { this.entries.clear(); }
  delete(sessionId: string): void { this.entries.delete(sessionId); }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.capturedAt >= TTL_MS) this.entries.delete(id);
    }
  }
  put(entry: ReadSnapshot): boolean {
    this.prune();
    this.delete(entry.sessionId);
    if (entry.fullContent.length > MAX_SNAPSHOT_CHARS) return false;
    const size = () => [...this.entries.values()].reduce((sum, e) => sum + e.fullContent.length, 0);
    while (this.entries.size >= MAX_SESSIONS || size() + entry.fullContent.length > MAX_TOTAL_CHARS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(entry.sessionId, { ...entry, result: { ...entry.result, warnings: [...(entry.result.warnings ?? [])] } });
    return true;
  }
  read(sessionId: string, navigation: number, url: string, offset: number): ReadResult {
    this.prune();
    const entry = this.entries.get(sessionId);
    if (!entry || entry.navigation !== navigation || entry.url !== url) {
      this.delete(sessionId);
      throw new BrowserFailure("INVALID_ARGUMENT", "正文快照不存在、已过期或页面已变化，请使用 target=current、offset=0 重新读取；不能接续旧偏移。");
    }
    const content = sliceReadText(entry.fullContent, offset);
    return {
      ...entry.result,
      warnings: [...(entry.result.warnings ?? [])],
      content, offset, totalLength: entry.fullContent.length,
      truncated: offset + content.length < entry.fullContent.length,
      capturedAt: entry.capturedAt,
    };
  }
}
