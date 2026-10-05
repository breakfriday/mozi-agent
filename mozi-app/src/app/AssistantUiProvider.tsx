import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, type PropsWithChildren } from "react";
import { agentActions } from "@/agent/agentActions";
import { useAgentStore } from "@/agent/agentStore";
import type { AgentMessage } from "@/agent/types";

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const content = message.content.map((part) => ({ type: "text" as const, text: part.text }));
  if (message.role === "user") return { id: message.id, role: "user", content };

  return {
    id: message.id,
    role: "assistant",
    content,
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
  const authoritativeMessages = useAgentStore((state) => state.messages);
  const pending = useAgentStore((state) => state.pendingSubmission);
  const isRunning = useAgentStore((state) => state.activeRunId !== null);
  const isSubmitting = useAgentStore((state) => state.isSubmitting);
  const syncing = useAgentStore((state) => state.syncStatus === "syncing");
  const messages = useMemo<AgentMessage[]>(() => {
    if (!pending || authoritativeMessages.some((message) => message.clientMessageId === pending.clientMessageId)) return authoritativeMessages;
    // Local presentation only; these IDs never enter the wire contract or backend mapping.
    return [...authoritativeMessages, {
      id: pending.clientMessageId, role: "user", status: "accepted",
      content: pending.content.map((part, index) => ({ ...part, id: `optimistic-${pending.clientMessageId}-${index}` })),
    }];
  }, [authoritativeMessages, pending]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isSendDisabled: isRunning || isSubmitting || syncing || pending?.status === "unknown",
    onNew,
    onCancel: agentActions.cancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
