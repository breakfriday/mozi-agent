import type {
  AppError, ApprovalView, InputPart, MessageView, RunView, RuntimeNotice, ToolView,
} from "../../../shared/agent";

export type AgentMessage = Pick<MessageView, "id" | "role" | "content" | "status">;

export type PendingSubmission = {
  localSessionId: string;
  sessionId: string | null;
  clientMessageId: string;
  content: InputPart[];
  status: "sending" | "accepted" | "unknown" | "rejected";
  messageId?: string;
  runId?: string;
  error?: AppError;
};

export type AgentState = {
  localSessionId: string;
  sessionId: string | null;
  messages: MessageView[];
  messageOrder: string[];
  runs: RunView[];
  tools: ToolView[];
  approvals: ApprovalView[];
  activeRunId: string | null;
  lastSeq: number;
  syncStatus: "idle" | "syncing" | "ready" | "error";
  runtime: RuntimeNotice;
  inFlightSubmissionId: string | null;
  pendingSubmissions: Record<string, PendingSubmission>;
  error: AppError | null;
};
