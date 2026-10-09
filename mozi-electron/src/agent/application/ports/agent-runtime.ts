import type { InputPart } from "../../../../../shared/agent";

/** Application-owned port. Only the Pi infrastructure imports SDK types. */
export interface RuntimeSessionDescriptor {
  sessionId: string;
  engine: string;
  /** Opaque to the application; interpreted only by the owning adapter. */
  locator: string;
  cwd: string;
}
export interface RuntimeSessionInfo {
  name?: string;
  descriptor: RuntimeSessionDescriptor;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface RuntimeContentPart {
  index: number;
  type: "text" | "reasoning";
  text: string;
}
export type RuntimeEvent =
  | { type: "session.title"; title: string }
  | { type: "message.model"; ordinal: number; responseModelId: string }
  | { type: "message.start"; ordinal: number }
  | { type: "message.delta"; ordinal: number; partIndex: number; delta: string }
  | { type: "message.reasoning.delta"; ordinal: number; partIndex: number; delta: string }
  | { type: "message.complete"; ordinal: number; parts: RuntimeContentPart[]; nativeEntryId?: string };
export interface RuntimeHistoryMessage {
  responseModelId?: string;
  runId?: string;
  role: "user" | "assistant";
  ordinal: number;
  nativeEntryId: string;
  createdAt: string;
  status: "completed" | "failed" | "cancelled";
  parts: RuntimeContentPart[];
}
export interface RuntimeSession {
  execute(input: { runId: string; clientMessageId: string; content: InputPart[] },
    emit: (event: RuntimeEvent) => void): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
export interface AgentRuntime {
  setSessionName(descriptor: RuntimeSessionDescriptor, name: string): void;
  createSession(): Promise<RuntimeSessionDescriptor>;
  listSessions(): Promise<RuntimeSessionInfo[]>;
  openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession>;
  readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]>;
  dispose(): void;
}
