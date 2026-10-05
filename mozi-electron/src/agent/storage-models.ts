import { createHash } from "node:crypto";
import type { InputPart, RunView, SessionSnapshot, SessionSummary } from "../../../shared/agent";
import type { RuntimeSessionDescriptor } from "./runtime";

export interface MessageLink {
  messageId: string; runId: string; role: "user" | "assistant"; ordinal: number; nativeEntryId?: string;
}
/** Memory-only projection. Never passed to the metadata store. */
export interface SessionRecord {
  descriptor: RuntimeSessionDescriptor;
  snapshot: SessionSnapshot;
  messageLinks: MessageLink[];
}
export interface SessionMetadata {
  descriptor: RuntimeSessionDescriptor;
  session: SessionSummary;
}
export interface SubmissionRecord {
  sessionId: string; clientMessageId: string; contentHash: string; runId: string; messageId: string;
}
export interface RunMetadata {
  run: RunView;
  clientMessageId: string;
  contentHash: string;
  /** Accepted input not yet confirmed in native history; cleared on reconciliation. */
  pendingContent?: InputPart[];
}
export interface SessionMetadataDetails {
  runs: RunMetadata[];
  links: MessageLink[];
}
export const contentHash = (content: InputPart[]): string => createHash("sha256")
  .update(JSON.stringify(content.map(({ type, text }) => ({ type, text })))).digest("hex");
