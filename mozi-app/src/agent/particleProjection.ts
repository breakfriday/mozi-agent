import type { AgentEvent } from "../../../shared/agent";
import type { ParticleProjection } from "../../../shared/particles";
import type { AgentState, PendingSubmission } from "./types";

export interface ChatProjection {
  user(pending: PendingSubmission): void;
  receive(event: AgentEvent, state: AgentState): void;
  failed(pending: PendingSubmission, message: string): void;
  sync(state: AgentState): void;
  reset(): void;
}

// Transport ceiling only; visible capacity and wrapping belong to the particle renderer.
export const PROJECTION_TEXT_LIMITS = { maxChars: 131072, updateMs: 300 };

/** One pending update, one trailing timer. Actions own this module's lifetime. */
export function createParticleProjection(send: (content: ParticleProjection | null) => void): ChatProjection {
  let current: ParticleProjection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { clearTimeout(timer); timer = undefined; send(current); };
  const show = (key: string, text: string, role: ParticleProjection["role"], streaming: boolean) => {
    const visible = text.slice(-PROJECTION_TEXT_LIMITS.maxChars);
    if (!visible) return;
    const next = { key, text: visible, role, streaming };
    if (current && Object.keys(next).every(k => next[k as keyof ParticleProjection] === current![k as keyof ParticleProjection])) return;
    const immediate = current?.key !== key || !streaming;
    if (current?.key !== key && timer) flush();
    current = next;
    if (immediate) flush();
    else timer ??= setTimeout(flush, PROJECTION_TEXT_LIMITS.updateMs);
  };
  return {
    user(pending) { show(pending.clientMessageId, pending.content.filter(p => p.type === "text").map(p => p.text).join("\n"), "user", false); },
    failed(pending, message) { show(pending.clientMessageId, `发送失败：${message}`, "activity", false); },
    receive(event, state) {
      switch (event.type) {
        case "message.text.delta":
        case "message.reasoning.delta":
        case "message.completed": {
          const message = state.messages.find(m => m.id === event.data.messageId);
          if (!message || message.role !== "assistant") return;
          const kind = event.type === "message.reasoning.delta" ? "reasoning" : "text";
          const text = message.content.filter(p => p.type === kind).map(p => p.text).join("\n");
          show(`${event.sessionId}:${message.id}`, text, "assistant", event.type !== "message.completed");
          break;
        }
        case "tool.started": show(`${event.sessionId}:${event.data.toolCallId}`, `执行 ${event.data.toolName}`, "activity", true); break;
        case "tool.output.delta": {
          const tool = state.tools.find(t => t.toolCallId === event.data.toolCallId);
          show(`${event.sessionId}:${event.data.toolCallId}`, `${tool?.toolName ?? "工具"}：${tool?.outputText ?? event.data.delta}`, "activity", true);
          break;
        }
        case "tool.completed": show(`${event.sessionId}:${event.data.toolCallId}`, `${event.data.tool.toolName} · ${event.data.outcome}`, "activity", false); break;
        case "approval.requested": show(`${event.sessionId}:approval`, "等待你确认执行", "activity", true); break;
        case "run.finished":
          if (event.data.status !== "completed") show(`${event.sessionId}:result`, event.data.status === "failed" ? event.data.error.message : "任务已停止", "activity", false);
          else if (current) { current = { ...current, streaming: false }; flush(); }
          break;
      }
    },
    sync(state) {
      const message = [...state.messages].reverse().find(m => m.role === "assistant" && (m.status === "streaming" || current?.key === `${state.sessionId}:${m.id}`));
      if (message) show(`${state.sessionId}:${message.id}`, message.content.filter(p => p.type === "text").map(p => p.text).join("\n"), "assistant", message.status === "streaming");
    },
    reset() { clearTimeout(timer); timer = undefined; current = null; send(null); },
  };
}
