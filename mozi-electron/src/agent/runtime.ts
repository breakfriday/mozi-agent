import type { InputPart } from "../../../shared/agent";

/** Application-owned port. Only PiAdapter imports SDK types. */
export interface RuntimeSessionDescriptor {
  sessionId: string;
  filePath: string;
  cwd: string;
}
export type RuntimeOutput =
  | { type: "message.start"; ordinal: number }
  | { type: "message.delta"; ordinal: number; partIndex: number; delta: string }
  | { type: "message.complete"; ordinal: number; parts: { index: number; text: string }[]; nativeEntryId?: string };
export interface RuntimeHistoryMessage {
  runId: string;
  role: "user" | "assistant";
  ordinal: number;
  nativeEntryId: string;
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
  openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession>;
  readHistory(descriptor: RuntimeSessionDescriptor): RuntimeHistoryMessage[];
  dispose(): void;
}
