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
import { Tag } from "antd";
import { MoziIcon } from "@/components/MoziIcon";
import styles from "./chat.module.css";

const suggestions = [
  "检查播放器是否异常",
  "帮我分析一段日志",
  "整理问题排查步骤",
];

function UserMessage() {
  return (
    <MessagePrimitive.Root className={styles.userMessage}>
      <div className={styles.userBubble}>
        <MessagePrimitive.Parts />
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
            正在输出演示回复…
          </span>
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
              message.role === "user" ? <UserMessage /> : <AssistantMessage />
            }
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <div className={styles.composerArea}>
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
          本地演示 · 尚未连接 Agent · 刷新页面后记录清空
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
