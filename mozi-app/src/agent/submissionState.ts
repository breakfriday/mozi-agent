import type { MessageView } from "../../../shared/agent";
import type { AgentMessage, AgentState, PendingSubmission } from "./types";

export const submissionKey = (clientMessageId: string) => `client:${clientMessageId}`;
const messageKey = (message: MessageView) => message.role === "user" && message.clientMessageId
  ? submissionKey(message.clientMessageId) : `message:${message.id}`;

/** A retry updates one record; a new clientMessageId appends one stable display slot. */
export function putSubmission(state: AgentState, submission: PendingSubmission): AgentState {
  const key = submissionKey(submission.clientMessageId);
  return {
    ...state,
    pendingSubmissions: { ...state.pendingSubmissions, [submission.clientMessageId]: submission },
    messageOrder: state.messageOrder.includes(key) ? state.messageOrder : [...state.messageOrder, key],
  };
}

/** Keep local slots when authority arrives. Insert new history beside known anchors. */
export function reconcileMessages(state: AgentState, fromSnapshot = false): AgentState {
  const pendingSubmissions = { ...state.pendingSubmissions };
  for (const message of state.messages) {
    if (message.role === "user" && message.clientMessageId) delete pendingSubmissions[message.clientMessageId];
  }
  if (fromSnapshot) {
    for (const [id, submission] of Object.entries(pendingSubmissions)) {
      if (submission.status === "accepted") pendingSubmissions[id] = { ...submission, status: "unknown" };
    }
  }
  const authoritativeKeys = state.messages.map(messageKey);
  const validKeys = new Set([...authoritativeKeys, ...Object.keys(pendingSubmissions).map(submissionKey)]);
  const messageOrder = state.messageOrder.filter((key) => validKeys.has(key));
  for (let index = authoritativeKeys.length - 1; index >= 0; index--) {
    const key = authoritativeKeys[index];
    if (messageOrder.includes(key)) continue;
    const following = authoritativeKeys.slice(index + 1).find((item) => messageOrder.includes(item));
    const preceding = authoritativeKeys.slice(0, index).reverse().find((item) => messageOrder.includes(item));
    const position = following ? messageOrder.indexOf(following)
      : preceding ? messageOrder.indexOf(preceding) + 1 : 0;
    messageOrder.splice(position, 0, key);
  }
  return { ...state, pendingSubmissions, messageOrder };
}

/** Presentation only: no optimistic messageId/runId is sent to the backend. */
export function selectChatMessages(state: Pick<AgentState, "messages" | "pendingSubmissions" | "messageOrder">): AgentMessage[] {
  const byKey = new Map<string, AgentMessage>();
  for (const message of state.messages) {
    const key = messageKey(message);
    byKey.set(key, { ...message, id: key });
  }
  for (const submission of Object.values(state.pendingSubmissions)) {
    const key = submissionKey(submission.clientMessageId);
    if (!byKey.has(key)) byKey.set(key, {
      id: key, role: "user", status: "accepted",
      content: submission.content.map((part, index) => ({ ...part, id: `${key}:part:${index}` })),
    });
  }
  return state.messageOrder.flatMap((key) => {
    const message = byKey.get(key);
    return message ? [message] : [];
  });
}

export function interruptSubmissions(state: AgentState, startInFlight: boolean): AgentState {
  const pendingSubmissions = { ...state.pendingSubmissions };
  for (const [id, submission] of Object.entries(pendingSubmissions)) {
    if (submission.status !== "sending" && submission.status !== "accepted") continue;
    const unknown = submission.status === "accepted" || (id === state.inFlightSubmissionId && startInFlight);
    pendingSubmissions[id] = {
      ...submission, status: unknown ? "unknown" : "rejected",
      error: { code: "RUNTIME_UNAVAILABLE", message: "Agent 连接已变化，请重试原提交。" },
    };
  }
  return { ...state, pendingSubmissions, inFlightSubmissionId: null };
}
