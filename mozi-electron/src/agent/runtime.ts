import type { InputPart } from "../../../shared/agent";

/** Application-owned port. Only PiAdapter imports SDK types. */
export interface RuntimeSessionDescriptor {
  sessionId: string;
  engine: string;
  /** Opaque to AgentService; interpreted only by the owning adapter. */
  locator: string;
  cwd: string;
}
export interface RuntimeSessionInfo {
  descriptor: RuntimeSessionDescriptor;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export type RuntimeOutput =
  | { type: "message.start"; ordinal: number }
  | { type: "message.delta"; ordinal: number; partIndex: number; delta: string }
  | { type: "message.complete"; ordinal: number; parts: { index: number; text: string }[]; nativeEntryId?: string };
export interface RuntimeHistoryMessage {
  runId?: string;
  role: "user" | "assistant";
  ordinal: number;
  nativeEntryId: string;
  createdAt: string;
  status: "completed" | "failed" | "cancelled";
  parts: { index: number; text: string }[];
}
export interface RuntimeSession {
  execute(input: { runId: string; clientMessageId: string; content: InputPart[] },
    emit: (event: RuntimeOutput) => void): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
export interface AgentRuntime {
  createSession(): Promise<RuntimeSessionDescriptor>;
  listSessions(): Promise<RuntimeSessionInfo[]>;
  openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession>;
  readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]>;
  dispose(): void;
}
