import type { MessageView, RunOutcome, RunView, SessionSnapshot, SessionSummary, ToolView } from "../../../../../shared/agent";
import type { MessageLink, RunMetadata } from "../../storage/metadata";

/** Owned by the projection after construction; never a runtime/session handle. */
export interface SessionProjectionSeed {
  snapshot: SessionSnapshot;
  messageLinks: MessageLink[];
}

export interface AcceptedRunChange {
  metadata: RunMetadata;
  message: MessageView;
  link: MessageLink;
}

export interface StartedMessageChange { message: MessageView; link: MessageLink }
export interface CompletedMessageChange {
  messageId: string;
  content: MessageView["content"];
  links: MessageLink[];
}
export interface FinishedRunChange { run: RunView; outcome: RunOutcome; links: MessageLink[] }
export interface MessageDelta {
  messageId: string;
  partId: string;
  type: "text" | "reasoning";
  delta: string;
}

/** Internal, synchronous, single-use commit. Preparation has no side effects. */
export interface PreparedProjectionChange { commit(): void }
export interface PreparedRunFinish extends PreparedProjectionChange { tools: ToolView[] }

export interface ProjectionSize { bytes: number; nodes: number }
export interface MessageEntry extends ProjectionSize { value: MessageView; position: number; chars: number }
export interface RunEntry extends ProjectionSize { value: RunView; position: number }

/** Internal change set; callers use semantic projection operations instead. */
export interface ProjectionPatch {
  session?: SessionSummary;
  messages?: MessageView[];
  runs?: RunView[];
  links?: MessageLink[];
  tools?: ToolView[];
  usage?: SessionSnapshot["usage"];
}
