import type { AgentEvent, SessionSnapshot } from "../../../shared/agent";
import type { AgentState } from "./types";
import { reconcileMessages } from "./submissionState";

export const isTerminalRun = (status: string) => ["completed", "cancelled", "failed", "interrupted"].includes(status);

export function initialAgentState(sessionId: string | null = null): AgentState {
  return {
    sessions: [], sessionsLoading: false, sessionsError: null, sessionOperation: null,
    localSessionId: crypto.randomUUID(), sessionId, messages: [], messageOrder: [], runs: [], tools: [], approvals: [], activeRunId: null,
    lastSeq: 0, syncStatus: "idle", runtime: { state: "unavailable" },
    inFlightSubmissionId: null, pendingSubmissions: {}, error: null,
  };
}

function upsert<T>(items: T[], item: T, id: (item: T) => string): T[] {
  return items.some((existing) => id(existing) === id(item))
    ? items.map((existing) => id(existing) === id(item) ? item : existing)
    : [...items, item];
}

export function installAgentSnapshot(state: AgentState, snapshot: SessionSnapshot): AgentState {
  return reconcileMessages({
    ...state, sessionId: snapshot.session.sessionId, messages: snapshot.messages,
    sessions: upsert(state.sessions, snapshot.session, (session) => session.sessionId),
    runs: snapshot.runs, tools: snapshot.tools, approvals: snapshot.approvals, lastSeq: snapshot.lastSeq,
    activeRunId: snapshot.runs.find((run) => !isTerminalRun(run.status))?.id ?? null,
  }, true);
}

/** Caller enforces session routing and consecutive seq before applying an event. */
export function applyAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  const next = { ...state, lastSeq: event.seq };
  switch (event.type) {
    case "run.started":
      next.activeRunId = event.runId;
      break;
    case "run.updated":
      next.runs = upsert(state.runs, event.data.run, (run) => run.id);
      if (!isTerminalRun(event.data.run.status)) next.activeRunId = event.runId;
      else if (state.activeRunId === event.runId) next.activeRunId = null;
      break;
    case "message.accepted":
      next.messages = upsert(state.messages, event.data.message, (message) => message.id);
      break;
    case "message.started":
      if (!state.messages.some((message) => message.id === event.data.messageId)) {
        next.messages = [...state.messages, {
          id: event.data.messageId, sessionId: event.sessionId, runId: event.runId,
          role: "assistant", content: [], status: "streaming",
        }];
      }
      break;
    case "message.text.delta":
    case "message.completed": {
      const message = state.messages.find((item) => item.id === event.data.messageId);
      if (!message) throw new Error("Missing message before event.");
      const updated = event.type === "message.completed"
        ? { ...message, content: event.data.content, status: "completed" as const }
        : { ...message, content: message.content.some((part) => part.id === event.data.partId)
          ? message.content.map((part) => part.id === event.data.partId ? { ...part, text: part.text + event.data.delta } : part)
          : [...message.content, { id: event.data.partId, type: "text" as const, text: event.data.delta }] };
      next.messages = upsert(state.messages, updated, (item) => item.id);
      break;
    }
    case "tool.updated":
    case "tool.completed":
      next.tools = upsert(state.tools, event.data.tool, (tool) => tool.toolCallId);
      break;
    case "tool.started":
    case "tool.input.delta":
    case "tool.output.delta": {
      const tool = state.tools.find((item) => item.toolCallId === event.data.toolCallId);
      if (!tool) throw new Error("Missing tool before event.");
      const updated = event.type === "tool.started" ? { ...tool, status: "running" as const }
        : event.type === "tool.input.delta" ? { ...tool, inputText: tool.inputText + event.data.delta }
          : { ...tool, outputText: tool.outputText + event.data.delta };
      next.tools = upsert(state.tools, updated, (item) => item.toolCallId);
      break;
    }
    case "approval.requested":
    case "approval.resolved":
      next.approvals = upsert(state.approvals, event.data.approval, (approval) => approval.id);
      break;
    case "run.finished": {
      const outcome = event.data;
      next.runs = state.runs.map((run) => run.id === event.runId ? {
        ...run, status: outcome.status,
        error: outcome.status === "failed" ? outcome.error : undefined,
        interruptionReason: outcome.status === "interrupted" ? outcome.reason : undefined,
      } : run);
      if (state.activeRunId === event.runId) next.activeRunId = null;
      next.messages = state.messages.map((message) => message.runId === event.runId
        && (message.status === "streaming" || message.status === "accepted")
        ? { ...message, status: message.role === "user" ? "completed" : outcome.status } : message);
      next.tools = state.tools.map((tool) => tool.runId === event.runId
        && ["preparing", "awaiting_approval", "running"].includes(tool.status)
        ? { ...tool, status: outcome.status === "cancelled" ? "cancelled" : "interrupted" } : tool);
      next.approvals = state.approvals.map((approval) => approval.runId === event.runId && approval.status === "pending"
        ? { ...approval, status: outcome.status === "cancelled" ? "cancelled" : "expired" } : approval);
      if (outcome.status === "failed") next.error = outcome.error;
      break;
    }
  }
  return event.type === "message.accepted" || event.type === "message.started" ? reconcileMessages(next) : next;
}
