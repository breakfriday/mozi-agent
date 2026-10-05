import { useAgentStore } from "./agentStore";

// Frontend preview only. Replace the demo actions with Agent IPC integration.
// All views use these actions; none of them depend on assistant-ui.
let streamTimer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
  clearInterval(streamTimer);
  streamTimer = undefined;
}

export const agentActions = {
  async submit(text: string) {
    const input = text.trim();
    if (!input || useAgentStore.getState().activeMessageId) return;

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    useAgentStore.setState((state) => ({
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
      if (useAgentStore.getState().activeMessageId !== assistantId) {
        stopTimer();
        return;
      }
      offset = Math.min(offset + 3, reply.length);
      const done = offset === reply.length;
      if (done) stopTimer();
      useAgentStore.setState((state) => ({
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
    useAgentStore.setState((state) => ({
      messages: state.messages.map((message) =>
        message.id === state.activeMessageId
          ? { ...message, status: "cancelled" }
          : message,
      ),
      activeMessageId: null,
    }));
  },
};

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void agentActions.cancel();
  });
