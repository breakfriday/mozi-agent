import { create } from "zustand";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "completed" | "cancelled";
};

type ChatState = {
  messages: ChatMessage[];
  activeMessageId: string | null;
  conversationVersion: number;
};

// Frontend preview only. Replace the demo actions with Agent IPC integration.
// Keep application messages independent of assistant-ui's rendering types.
export const useChatStore = create<ChatState>(() => ({
  messages: [],
  activeMessageId: null,
  conversationVersion: 0,
}));

let streamTimer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
  clearInterval(streamTimer);
  streamTimer = undefined;
}

export const chatActions = {
  async submit(text: string) {
    const input = text.trim();
    if (!input || useChatStore.getState().activeMessageId) return;

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    useChatStore.setState((state) => ({
      messages: [
        ...state.messages,
        { id: userId, role: "user", text: input, status: "completed" },
        { id: assistantId, role: "assistant", text: "", status: "streaming" },
      ],
      activeMessageId: assistantId,
    }));

    const reply =
      "这是一条 **本地演示回复**，用于体验聊天界面。\n\n" +
      "当前尚未连接 Agent，消息不会发送给模型，也不会执行播放器操作或读取日志。\n\n" +
      "你可以继续发送消息、在输出时点击停止，或切换页面后回来查看本次对话。刷新页面会清空演示记录。";
    let offset = 0;
    streamTimer = setInterval(() => {
      if (useChatStore.getState().activeMessageId !== assistantId) {
        stopTimer();
        return;
      }
      offset = Math.min(offset + 3, reply.length);
      const done = offset === reply.length;
      if (done) stopTimer();
      useChatStore.setState((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: reply.slice(0, offset),
                status: done ? "completed" : "streaming",
              }
            : message,
        ),
        activeMessageId: done ? null : assistantId,
      }));
    }, 40);
  },

  async cancel() {
    stopTimer();
    useChatStore.setState((state) => ({
      messages: state.messages.map((message) =>
        message.id === state.activeMessageId
          ? { ...message, status: "cancelled" }
          : message,
      ),
      activeMessageId: null,
    }));
  },

  clear() {
    stopTimer();
    useChatStore.setState((state) => ({
      messages: [],
      activeMessageId: null,
      conversationVersion: state.conversationVersion + 1,
    }));
  },
};

if (import.meta.hot) import.meta.hot.dispose(stopTimer);
