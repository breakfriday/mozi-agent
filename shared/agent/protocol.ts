import type { Id, InputPart, TerminalStatus, SessionSummary, SessionSnapshot, RunView, AppError, MessageView, MessagePart, ToolView, ToolOutcome, ApprovalView, RunOutcome } from "./models";

import type { ModelSelection, ModelSettings, ProviderSaveInput } from "./providers";

export type StartRunInput = {
  sessionId: Id;
  clientMessageId: Id;
  content: InputPart[];
};

export type RunAccepted = {
  sessionId: Id;
  runId: Id;
  clientMessageId: Id;
  messageId: Id; // 本次用户消息，不是助手回复
  disposition: "accepted" | "duplicate";
};

export type CancelRunResult = {
  sessionId: Id;
  runId: Id;
} & (
  | { disposition: "requested" }
  | { disposition: "already_finished"; status: TerminalStatus }
);

export type MethodMap = {
  "model.settings": { params: Record<string, never>; result: ModelSettings };
  "provider.save": { params: ProviderSaveInput; result: ModelSettings };
  "provider.remove": { params: { providerId: string }; result: ModelSettings };
  "model.setDefault": { params: { model: ModelSelection }; result: ModelSettings };
  "session.setModel": { params: { sessionId: Id; model: ModelSelection }; result: { session: SessionSummary } };
  "runtime.getState": {
    params: Record<string, never>;
    result: RuntimeNotice;
  };
  "session.create": {
    params: { clientOperationId: Id; title?: string; model?: ModelSelection };
    result: { sessionId: Id };
  };
  "session.list": {
    params: { cursor?: string; limit?: number };
    result: { items: SessionSummary[]; nextCursor?: string };
  };
  "session.rename": {
    params: { sessionId: Id; title: string };
    result: { session: SessionSummary };
  };
  "session.delete": {
    params: { sessionId: Id };
    result: { sessionId: Id };
  };
  "session.snapshot": {
    params: { sessionId: Id };
    result: SessionSnapshot;
  };
  "session.subscribe": {
    params: { sessionId: Id };
    result: { subscriptionId: Id; sessionId: Id };
  };
  "session.unsubscribe": {
    params: { subscriptionId: Id };
    result: { removed: boolean };
  };
  "run.start": {
    params: StartRunInput;
    result: RunAccepted;
  };
  "run.cancel": {
    params: { sessionId: Id; runId: Id };
    result: CancelRunResult;
  };
  "approval.respond": {
    params: {
      sessionId: Id;
      runId: Id;
      approvalId: Id;
      decision: "approve" | "deny";
    };
    result: {
      approval: ApprovalView;
      disposition: "applied" | "already_resolved";
    };
  };
  "run.get": {
    params: { sessionId: Id; runId: Id };
    result: RunView;
  };
};

export type Method = keyof MethodMap;

export type AgentRequest = {
  [M in Method]: {
    protocolVersion: 1;
    kind: "request";
    requestId: Id;
    method: M;
    params: MethodMap[M]["params"];
  }
}[Method];

export type ResponseFor<M extends Method> = {
  protocolVersion: 1;
  kind: "response";
  requestId: Id;
} & (
  | { ok: true; result: MethodMap[M]["result"] }
  | { ok: false; error: AppError }
);

export type StartRunResponse = ResponseFor<"run.start">;

export type RequestFor<M extends Method> = Extract<AgentRequest, { method: M }>;
export type AgentResponse = { [M in Method]: ResponseFor<M> }[Method];

// Main owns connection state and window subscriptions; these never reach Pi.
export type RuntimeMethod = Exclude<Method,
  "runtime.getState" | "session.subscribe" | "session.unsubscribe"
>;
export type RuntimeRequest = Extract<AgentRequest, { method: RuntimeMethod }>;
export type RuntimeResponse = { [M in RuntimeMethod]: ResponseFor<M> }[RuntimeMethod];

export type EventPayload =
  | { type: "run.started"; data: Record<string, never> }
  | { type: "run.updated"; data: { run: RunView } }
  | { type: "message.accepted"; data: { message: MessageView } }
  | {
      type: "message.started";
      data: { messageId: Id; role: "assistant" };
    }
  | {
      type: "message.text.delta";
      data: { messageId: Id; partId: Id; delta: string };
    }
  | {
      type: "message.completed";
      data: { messageId: Id; content: MessagePart[] };
    }
  | { type: "message.model.reported"; data: { messageId: Id; responseModelId: string } }
  | { type: "tool.updated"; data: { tool: ToolView } }
  | {
      type: "tool.input.delta";
      data: { toolCallId: Id; delta: string };
    }
  | {
      type: "tool.output.delta";
      data: { toolCallId: Id; delta: string };
    }
  | { type: "approval.requested"; data: { approval: ApprovalView } }
  | { type: "approval.resolved"; data: { approval: ApprovalView } }
  | {
      type: "tool.started";
      data: { toolCallId: Id; toolName: string };
    }
  | {
      type: "tool.completed";
      data: {
        toolCallId: Id;
        outcome: ToolOutcome;
        tool: ToolView; // 完整结果校准参数、输出、摘要和终态
      };
    }
  | { type: "run.finished"; data: RunOutcome };

export type AgentEvent = {
  protocolVersion: 1;
  kind: "event";
  sessionId: Id;
  runId: Id;
  seq: number;
} & EventPayload;

// Main 发出的连接控制通知，不使用会话 seq。
export type RuntimeNotice = {
  state: "unavailable" | "ready";
  reason?: string;
};

// Internal process handshake. `ready` means recovery is complete, not just spawned.
export type RuntimeControl = {
  protocolVersion: 1;
  kind: "runtime";
} & RuntimeNotice;

export type RuntimePacket = RuntimeResponse | AgentEvent | RuntimeControl;

/** Main → utility process lifecycle command; never exposed through window.mozi. */
export type RuntimeShutdown = { protocolVersion: 1; kind: "control"; action: "shutdown" };
