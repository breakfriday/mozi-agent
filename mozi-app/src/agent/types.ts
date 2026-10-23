import type {
  AppError, ApprovalView, InputPart, ModelSelection, MessageView, RunView, RuntimeNotice, SessionSummary, ToolView,
} from "../../../shared/agent";

export type AgentMessage = Pick<MessageView, "id" | "role" | "content" | "status" | "responseModelId">;

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
  usage?: import("../../../shared/agent").UsageMonitorView;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsError: AppError | null;
  sessionOperation: string | null;
  localSessionId: string;
  sessionId: string | null;
  modelSelection: ModelSelection | null;
  messages: MessageView[];
  messageOrder: string[];
  runs: RunView[];
  tools: ToolView[];
  approvals: ApprovalView[];
  activeRunId: string | null;
  sessionActivity: Record<string, Pick<RunView, "id" | "status">>;
  lastSeq: number;
  syncStatus: "idle" | "syncing" | "ready" | "error";
  runtime: RuntimeNotice;
  inFlightSubmissionId: string | null;
  pendingSubmissions: Record<string, PendingSubmission>;
  error: AppError | null;
};
