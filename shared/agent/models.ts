import type { ModelSelection } from "./providers";

// Application views and values. No Electron, Pi, or UI dependencies.
export type Id = string;

export type InputPart = {
  type: "text";
  text: string;
};

export type MessagePart = {
  id: Id; // 与 delta.data.partId 对应
  type: "text";
  text: string;
};

export const APP_ERROR_CODES = [
  "INVALID_ARGUMENT", "SESSION_NOT_FOUND", "RUN_NOT_FOUND", "SESSION_BUSY",
  "CAPACITY_EXCEEDED", "SUBMISSION_CONFLICT", "PERMISSION_DENIED", "APPROVAL_NOT_FOUND",
  "APPROVAL_EXPIRED", "APPROVAL_CONFLICT", "REQUEST_TIMEOUT", "UNSUPPORTED_CAPABILITY",
  "PROTOCOL_MISMATCH", "RUNTIME_UNAVAILABLE", "INTERNAL_ERROR",
] as const;

export type AppError = {
  code: (typeof APP_ERROR_CODES)[number];
  message: string;
};

export const RUN_STATUSES = [
  "accepted", "running", "waiting_approval", "cancelling",
  "completed", "cancelled", "failed", "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ["completed", "cancelled", "failed", "interrupted"] as const satisfies readonly RunStatus[];

export type TerminalStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const MESSAGE_STATUSES = ["accepted", "streaming", "completed", "cancelled", "failed", "interrupted"] as const;
export const TOOL_OUTCOMES = ["succeeded", "failed", "denied", "cancelled", "interrupted"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];
export const TOOL_STATUSES = ["preparing", "awaiting_approval", "running", ...TOOL_OUTCOMES] as const;
export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "cancelled"] as const;

export type RunOutcome =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error: AppError }
  | { status: "interrupted"; reason: string };

export type RunView = {
  id: Id;
  sessionId: Id;
  userMessageId: Id;
  status: RunStatus;
  createdAt: string; // ISO 8601
  updatedAt: string;
  error?: AppError;
  interruptionReason?: string;
  model?: ModelSelection;
  modelConfigVersion?: string;
};

export type MessageView = {
  /** Model identifier explicitly reported by the provider response; never a requested/configured model. */
  responseModelId?: string;
  id: Id;
  sessionId: Id;
  runId?: Id;
  role: "user" | "assistant";
  content: MessagePart[];
  status: (typeof MESSAGE_STATUSES)[number];
  clientMessageId?: Id; // 用户提交关联；助手通常没有
};

export type ToolView = {
  toolCallId: Id;
  runId: Id;
  toolName: string;
  status: (typeof TOOL_STATUSES)[number];
  inputText: string; // 供展示的参数，不是前端执行指令
  outputText: string; // 当前保留的工具输出
  outputTruncated: boolean;
  summary?: string;
};

export type ApprovalView = {
  id: Id;
  sessionId: Id;
  runId: Id;
  toolCallId: Id;
  title: string;
  description: string;
  status: (typeof APPROVAL_STATUSES)[number];
  createdAt: string;
  resolvedAt?: string;
};

export type SessionSummary = {
  model?: ModelSelection;
  sessionId: Id; // Pi 原生会话 ID
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  session: SessionSummary;
  lastSeq: number;
  messages: MessageView[];
  tools: ToolView[];
  runs: RunView[]; // 覆盖返回的展示记录和当前活动 Run
  approvals: ApprovalView[]; // 含当前待审批项及相关历史记录
};
