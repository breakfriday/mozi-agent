import type { InputPart, RunView, SessionSummary } from "../../../../shared/agent";
import type { RuntimeSessionDescriptor } from "../runtime/agent-runtime";

export interface MessageLink {
  messageId: string; runId: string; role: "user" | "assistant"; ordinal: number; nativeEntryId?: string;
}
export interface SessionMetadata {
  /** Undefined only for metadata written before native title synchronization. */
  titleSource?: "automatic" | "explicit";
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
