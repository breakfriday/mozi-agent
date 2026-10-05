import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  StopOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { MoziIcon } from "@/components/MoziIcon";
import { useAgentStore } from "@/agent/agentStore";
import { agentActions } from "@/agent/agentActions";
import styles from "./chat.module.css";

const suggestions = [
  "检查播放器是否异常",
  "帮我分析一段日志",
  "整理问题排查步骤",
];

function UserMessage({ messageKey }: { messageKey: string }) {
  const clientMessageId = messageKey.startsWith("client:") ? messageKey.slice("client:".length) : undefined;
  const submission = useAgentStore((state) => clientMessageId ? state.pendingSubmissions[clientMessageId] : undefined);
  const busy = useAgentStore((state) => state.inFlightSubmissionId !== null || state.syncStatus === "syncing"
    || (state.activeRunId !== null && submission?.status !== "unknown")
    || Object.values(state.pendingSubmissions).some((item) => item.status === "unknown" && item.clientMessageId !== clientMessageId));
  const canRetry = submission?.status === "rejected" || submission?.status === "unknown";
  const statusText = submission?.status === "unknown" ? "提交结果尚未确认，请重试原提交。"
    : submission?.status === "rejected" ? submission.error?.code === "RUNTIME_UNAVAILABLE"
      ? "Agent 后台尚未连接，消息已保留。" : submission.error?.message || "发送失败，消息已保留。"
      : submission?.status === "sending" ? "正在发送…"
        : submission?.status === "accepted" ? "后台已接受，正在同步…" : undefined;
  return (
    <MessagePrimitive.Root className={styles.userMessage}>
      <div className={styles.userBody}>
        <div className={styles.userBubble}>
          <MessagePrimitive.Parts />
        </div>
        {statusText && <div className={styles.submissionStatus} role={canRetry ? "alert" : "status"}>
          <span>{statusText}</span>
          {canRetry && <button type="button" disabled={busy} onClick={() => void agentActions.retry(submission.clientMessageId)}>重试原提交</button>}
        </div>}
      </div>
      <span className={styles.avatar} aria-label="你">
        <UserOutlined />
      </span>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className={styles.assistantMessage}>
      <MoziIcon />
      <div className={styles.assistantBody}>
        <span className={styles.messageAuthor}>Mozi</span>
        <div className={styles.markdown}>
          <MessagePrimitive.Parts>
            {({ part }) =>
              part.type === "text" ? <MarkdownTextPrimitive /> : null
            }
          </MessagePrimitive.Parts>
        </div>
        <AuiIf condition={(s) => s.message.status?.type === "running"}>
          <span className={styles.messageStatus} role="status">
            正在生成回复…
          </span>
        </AuiIf>
        <AuiIf condition={(s) => s.message.status?.type === "incomplete" && s.message.status.reason === "error"}>
          <span className={styles.messageStatus}>任务未完成</span>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.message.status?.type === "incomplete" &&
            s.message.status.reason === "cancelled"
          }
        >
          <span className={styles.messageStatus}>已停止生成</span>
        </AuiIf>
      </div>
    </MessagePrimitive.Root>
  );
}

function ChatThread() {
  const runtime = useAgentStore((state) => state.runtime);
  const error = useAgentStore((state) => state.error);
  const busy = useAgentStore((state) => state.inFlightSubmissionId !== null || state.syncStatus === "syncing");
  const errorText = error?.code === "RUNTIME_UNAVAILABLE" ? "Agent 后台尚未连接，请稍后检查连接。" : error?.message;
  return (
    <ThreadPrimitive.Root className={styles.thread}>
      <ThreadPrimitive.Viewport className={styles.viewport}>
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className={styles.welcome}>
            <MoziIcon animated />
            <h2 lang="en">Hello, I’m Mozi.</h2>
            <div className={styles.suggestions}>
              {suggestions.map((prompt) => (
                <ThreadPrimitive.Suggestion
                  key={prompt}
                  prompt={prompt}
                  method="replace"
                  autoSend={false}
                  className={styles.suggestion}
                >
                  {prompt}
                  <ArrowUpOutlined />
                </ThreadPrimitive.Suggestion>
              ))}
            </div>
          </div>
        </AuiIf>
        <div className={styles.messages}>
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" ? <UserMessage messageKey={message.id} /> : <AssistantMessage />
            }
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <div className={styles.composerArea}>
        {errorText && (
          <div className={styles.connectionError} role="alert">
            <span>{errorText}</span>
          </div>
        )}
        <ThreadPrimitive.ScrollToBottom
          className={styles.scrollToBottom}
          aria-label="滚动到底部"
        >
          <ArrowDownOutlined />
        </ThreadPrimitive.ScrollToBottom>
        <ComposerPrimitive.Root className={styles.composer}>
          <ComposerPrimitive.Input
            className={styles.input}
            placeholder="向 Mozi 发送消息…"
            aria-label="消息内容"
            rows={2}
          />
          <div className={styles.composerToolbar}>
            <span className={styles.inputHint}>
              Enter 发送 · Shift + Enter 换行
            </span>
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send
                className={styles.sendButton}
                aria-label="发送消息"
              >
                <ArrowUpOutlined />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel
                className={styles.sendButton}
                aria-label="停止生成"
              >
                <StopOutlined />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </ComposerPrimitive.Root>
        <p className={styles.disclaimer}>
          {busy ? "正在连接或同步会话…" : runtime.state === "ready" ? "已连接 Agent" : "Agent 尚未连接"}
          {runtime.state !== "ready" && <button type="button" onClick={() => void agentActions.refresh()}>检查连接</button>}
        </p>
      </div>
    </ThreadPrimitive.Root>
  );
}

export function ChatPage() {
  return (
    <section className={styles.page} aria-label="智能对话">
      <ChatThread />
    </section>
  );
}
