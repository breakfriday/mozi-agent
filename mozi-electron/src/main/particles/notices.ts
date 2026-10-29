import type { AgentEvent } from "../../../../shared/agent";
import type { ParticleNotice } from "../../../../shared/particles";

/** Receives the already validated Agent contract; no output streams or arguments. */
export function toParticleNotice(event: AgentEvent): ParticleNotice | undefined {
  const key = `${event.sessionId}:${event.runId}`;
  switch (event.type) {
    case "run.started":
      return { key, text: "开始处理任务", tone: "activity" };
    case "tool.started":
      return { key, text: `正在执行 · ${event.data.toolName}`, tone: "activity" };
    case "approval.requested":
      return { key, text: `等待确认 · ${event.data.approval.title}`, tone: "attention" };
    case "tool.completed":
      if (event.data.outcome === "failed") return { key, text: `工具失败 · ${event.data.tool.toolName}`, tone: "attention" };
      return undefined;
    case "run.finished": {
      const { status } = event.data;
      const text = { completed: "任务已完成", cancelled: "任务已取消", failed: "任务执行失败", interrupted: "任务已中断" }[status];
      return { key, text, tone: status === "completed" ? "success" : "attention" };
    }
    default: return undefined;
  }
}
