import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { PropsWithChildren } from "react";
import { agentActions } from "@/agent/agentActions";
import { useAgentStore } from "@/agent/agentStore";
import type { AgentMessage } from "@/agent/types";

function convertMessage(message: AgentMessage): ThreadMessageLike {
  const content = [{ type: "text" as const, text: message.text }];
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
  const messages = useAgentStore((state) => state.messages);
  const isRunning = useAgentStore((state) => state.activeMessageId !== null);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isSendDisabled: isRunning,
    onNew,
    onCancel: agentActions.cancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
