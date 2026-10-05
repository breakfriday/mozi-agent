import type {
  AppError, ApprovalView, InputPart, MessageView, RunView, RuntimeNotice, ToolView,
} from "../../../shared/agent";

export type AgentMessage = Pick<MessageView, "id" | "role" | "content" | "status">;

export type PendingSubmission = {
  clientMessageId: string;
  content: InputPart[];
  status: "sending" | "accepted" | "unknown" | "rejected";
};

export type AgentState = {
  sessionId: string | null;
  messages: MessageView[];
  runs: RunView[];
  tools: ToolView[];
  approvals: ApprovalView[];
  activeRunId: string | null;
  lastSeq: number;
  syncStatus: "idle" | "syncing" | "ready" | "error";
  runtime: RuntimeNotice;
  isSubmitting: boolean;
  pendingSubmission: PendingSubmission | null;
  error: AppError | null;
};
