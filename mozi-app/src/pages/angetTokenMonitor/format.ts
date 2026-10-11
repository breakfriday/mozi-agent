import { useEffect, useState } from "react";
import { isTerminalRun } from "@/agent/agentState";
import type { RunView } from "../../../../shared/agent";
export const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
export const seconds = (ms?: number) => ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;

export function useElapsed(run?: RunView) {
  const active = !!run && !isTerminalRun(run.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return run ? Math.max(0, (active ? now : Date.parse(run.updatedAt)) - Date.parse(run.createdAt)) : undefined;
}

