import type { AgentEvent } from "../../../shared/agent";
import type { ChatProjection } from "./particleProjection";
import type { AgentState, PendingSubmission } from "./types";

export interface SpeechProjectionSink {
  isAutoSpeakEnabled(): boolean;
  startRunStream(streamKey: string, sessionId: string): void;
  appendDelta(streamKey: string, text: string): void;
  finishRunStream(streamKey: string): void;
  stop(): void;
}

/** 剥离完整 Markdown 文本中的围栏代码块（```` ```...``` ```` 与 `~~~...~~~`），供手动单条朗读使用。 */
export function stripCodeBlocks(markdown: string): string {
  if (!markdown) return "";
  return markdown
    .replace(/^(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^(?: {0,3})\1[~`]*[ \t]*$|(?![\s\S]))/gm, "\n")
    .replace(/^(?: {0,3})(?:`{3,}|~{3,})[\s\S]*$/gm, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 极简流式围栏代码块过滤器：
 * - 普通自然语言字符 0 滞留直通输出；
 * - 仅在行首遇到空格或 `< 3` 个 `` ` `` / `~` 时暂存最多几个前缀字符，满 3 个即进入代码块静默吞字态，闭合围栏后恢复。
 */
export function createCodeFenceFilter() {
  let inFence: "`" | "~" | null = null;
  let fenceLen = 0;
  let skipHeaderLine = false;
  let atLineStart = true;
  let lineSpaces = "";
  let fenceChars = "";

  const resetLinePrefix = () => {
    lineSpaces = "";
    fenceChars = "";
  };

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      let out = "";

      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        if (!inFence) {
          if (atLineStart) {
            if (fenceChars.length === 0 && ch === " " && lineSpaces.length < 3) {
              lineSpaces += ch;
              continue;
            }
            if (
              (ch === "`" || ch === "~") &&
              (fenceChars.length === 0 || fenceChars[0] === ch)
            ) {
              fenceChars += ch;
              if (fenceChars.length >= 3) {
                inFence = ch;
                fenceLen = fenceChars.length;
                skipHeaderLine = true;
                atLineStart = false;
                resetLinePrefix();
              }
              continue;
            }
            out += lineSpaces + fenceChars + ch;
            resetLinePrefix();
            atLineStart = ch === "\n";
          } else {
            out += ch;
            if (ch === "\n") atLineStart = true;
          }
          continue;
        }

        // 处于围栏代码块内部：静默吞字直到匹配闭合围栏行
        if (skipHeaderLine) {
          if (ch === "\n") {
            skipHeaderLine = false;
            atLineStart = true;
            resetLinePrefix();
          } else if (ch === inFence && fenceChars.length === 0) {
            // 支持 ```` ``` ```` 超过 3 个围栏符的长度记录
            fenceLen++;
          }
          continue;
        }

        if (atLineStart) {
          if (fenceChars.length === 0 && ch === " " && lineSpaces.length < 3) {
            lineSpaces += ch;
            continue;
          }
          if (ch === inFence) {
            fenceChars += ch;
            continue;
          }
          if (fenceChars.length >= fenceLen && (ch === "\n" || ch === "\r" || ch === " " || ch === "\t")) {
            if (ch === "\n") {
              inFence = null;
              fenceLen = 0;
              atLineStart = true;
              resetLinePrefix();
              out += "\n";
            } else {
              // 闭合围栏后允许行尾空白，等待换行正式退出
              lineSpaces = "";
            }
            continue;
          }
          resetLinePrefix();
          atLineStart = ch === "\n";
        } else if (ch === "\n") {
          atLineStart = true;
          resetLinePrefix();
        }
      }

      return out;
    },

    /** 段落或消息结束时冲刷未构成围栏的行首残留字符。 */
    flushSegment(): string {
      if (inFence) {
        // 单条消息异常未闭合围栏时重置，避免污染后续消息
        inFence = null;
        fenceLen = 0;
        skipHeaderLine = false;
        atLineStart = true;
        resetLinePrefix();
        return "";
      }
      const tail = lineSpaces + fenceChars;
      resetLinePrefix();
      atLineStart = true;
      return tail;
    },

    reset(): void {
      inFence = null;
      fenceLen = 0;
      skipHeaderLine = false;
      atLineStart = true;
      resetLinePrefix();
    },
  };
}

/** 组合多个无耦合 `ChatProjection` 旁路消费者。 */
export function composeProjections(...projections: ChatProjection[]): ChatProjection {
  return {
    user(pending) {
      for (const p of projections) p.user(pending);
    },
    receive(event, state) {
      for (const p of projections) p.receive(event, state);
    },
    failed(pending, message) {
      for (const p of projections) p.failed(pending, message);
    },
    sync(state) {
      for (const p of projections) p.sync(state);
    },
    reset() {
      for (const p of projections) p.reset();
    },
  };
}

/**
 * Pi Agent 回复语音投影：
 * - 1 次 Run 对应 1 条连续 TTS 流（中间穿插的工具调用不断流、不互抢）；
 * - 仅消费 `message.text.delta` 与 `run.finished`，完全忽略思考（`reasoning`）、工具（`tool.*`）及历史快照（`sync`）。
 */
export function createSpeechProjection(sink: SpeechProjectionSink): ChatProjection {
  const fenceFilter = createCodeFenceFilter();
  let activeStreamKey: string | null = null;
  let activeSessionId: string | null = null;
  let seqCounter = 0;

  const abortCurrent = () => {
    fenceFilter.reset();
    if (activeStreamKey !== null) {
      activeStreamKey = null;
      activeSessionId = null;
      sink.stop();
    }
  };

  return {
    user(_pending: PendingSubmission) {
      // 用户发出新提问：若上一轮还在播报则立即打断
      fenceFilter.reset();
      activeStreamKey = null;
      activeSessionId = null;
      sink.stop();
    },

    failed(_pending: PendingSubmission, _message: string) {
      abortCurrent();
    },

    sync(_state: AgentState) {
      // 切换会话或快照重同步时绝不自动重播历史消息
    },

    reset() {
      fenceFilter.reset();
      activeStreamKey = null;
      activeSessionId = null;
      sink.stop();
    },

    receive(event: AgentEvent, _state: AgentState) {
      switch (event.type) {
        case "message.text.delta": {
          if (!sink.isAutoSpeakEnabled()) return;
          if (activeSessionId && activeSessionId !== event.sessionId) {
            abortCurrent();
          }
          const cleaned = fenceFilter.push(event.data.delta);
          if (!cleaned || (!activeStreamKey && !cleaned.trim())) return;

          if (!activeStreamKey) {
            seqCounter += 1;
            activeStreamKey = `run:${event.sessionId}:${seqCounter}`;
            activeSessionId = event.sessionId;
            sink.startRunStream(activeStreamKey, event.sessionId);
          }
          sink.appendDelta(activeStreamKey, cleaned);
          return;
        }

        case "message.completed": {
          if (!activeStreamKey) {
            fenceFilter.reset();
            return;
          }
          // 冲刷本条消息末尾残留字符并补一个换行分隔，若后续工具执行完还有下一段回复可自然衔接
          const tail = fenceFilter.flushSegment();
          sink.appendDelta(activeStreamKey, `${tail}\n`);
          return;
        }

        case "run.finished": {
          if (!activeStreamKey) {
            fenceFilter.reset();
            return;
          }
          if (event.data.status === "completed") {
            const tail = fenceFilter.flushSegment();
            if (tail.trim()) sink.appendDelta(activeStreamKey, tail);
            const finishedKey = activeStreamKey;
            activeStreamKey = null;
            activeSessionId = null;
            sink.finishRunStream(finishedKey);
          } else {
            abortCurrent();
          }
          return;
        }

        default:
          // message.reasoning.delta / tool.* / approval.* / usage.* 一律忽略
          return;
      }
    },
  };
}
