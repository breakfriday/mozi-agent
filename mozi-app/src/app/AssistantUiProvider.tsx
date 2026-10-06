import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, type PropsWithChildren } from "react";
import { modelActions } from "@/agent/modelActions";
import { agentActions } from "@/agent/agentActions";
import { useAgentStore } from "@/agent/agentStore";
import type { AgentMessage } from "@/agent/types";
import { selectChatMessages } from "@/agent/submissionState";

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const content = message.content.map((part) => ({ type: "text" as const, text: part.text }));
  if (message.role === "user") return { id: message.id, role: "user", content };

  return {
    id: message.id,
    role: "assistant",
    content,
    metadata: { custom: { responseModelId: message.responseModelId } },
    status:
      message.status === "streaming"
        ? { type: "running" }
        : message.status === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : message.status === "failed" || message.status === "interrupted"
            ? { type: "incomplete", reason: "error" }
            : { type: "complete", reason: "stop" },
  };
}

async function onNew(message: AppendMessage) {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  await agentActions.submit(text);
}

// The assistant-ui adapter lives for the entire app, across route changes.
// Other Agent views may use the domain store/actions directly.
export function AssistantUiProvider({ children }: PropsWithChildren) {
  useEffect(() => agentActions.initialize(), []);
  useEffect(() => modelActions.initialize(), []);
  const sessionId = useAgentStore((state) => state.sessionId);
  const localSessionId = useAgentStore((state) => state.localSessionId);
  const sessions = useAgentStore((state) => state.sessions);
  const sessionsLoading = useAgentStore((state) => state.sessionsLoading);
  const sessionOperation = useAgentStore((state) => state.sessionOperation);
  const connected = useAgentStore((state) => state.runtime.state === "ready");
  const threads = useMemo(() => sessions.map((session) => ({
    id: session.sessionId, remoteId: session.sessionId, title: session.title, status: "regular" as const,
  })), [sessions]);
  const authoritativeMessages = useAgentStore((state) => state.messages);
  const pendingSubmissions = useAgentStore((state) => state.pendingSubmissions);
  const messageOrder = useAgentStore((state) => state.messageOrder);
  const isRunning = useAgentStore((state) => state.activeRunId !== null);
  const isSubmitting = useAgentStore((state) => state.inFlightSubmissionId !== null);
  const syncing = useAgentStore((state) => state.syncStatus === "syncing");
  const messages = useMemo(() => selectChatMessages({ messages: authoritativeMessages, pendingSubmissions, messageOrder }),
    [authoritativeMessages, pendingSubmissions, messageOrder]);
  const hasUnknownSubmission = Object.values(pendingSubmissions).some((submission) => submission.status === "unknown");
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isLoading: syncing,
    isSendDisabled: isRunning || isSubmitting || syncing || hasUnknownSubmission || sessionOperation !== null || (!!sessionId && !connected),
    adapters: {
      threadList: {
        threadId: sessionId ?? localSessionId,
        threads,
        isLoading: sessionsLoading,
        onSwitchToNewThread: agentActions.newSession,
        onSwitchToThread: agentActions.activateSession,
        onRename: agentActions.renameSession,
        onDelete: agentActions.deleteSession,
      },
    },
    onNew,
    onCancel: agentActions.cancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
