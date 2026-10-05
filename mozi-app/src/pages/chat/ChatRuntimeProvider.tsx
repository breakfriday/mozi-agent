import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { PropsWithChildren } from "react";
import { chatActions, useChatStore, type ChatMessage } from "./chatStore";

function convertMessage(message: ChatMessage): ThreadMessageLike {
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
  await chatActions.submit(text);
}

export function ChatRuntimeProvider({ children }: PropsWithChildren) {
  const messages = useChatStore((state) => state.messages);
  const isRunning = useChatStore((state) => state.activeMessageId !== null);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isSendDisabled: isRunning,
    onNew,
    onCancel: chatActions.cancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
