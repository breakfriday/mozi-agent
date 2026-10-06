import type { RunStatus, RunView } from "../../../../../shared/agent";

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  accepted: ["running", "cancelling", "cancelled", "failed", "interrupted"],
  running: ["waiting_approval", "cancelling", "completed", "cancelled", "failed", "interrupted"],
  waiting_approval: ["running", "cancelling", "completed", "cancelled", "failed", "interrupted"],
  cancelling: ["cancelled", "failed", "interrupted"],
  completed: [], cancelled: [], failed: [], interrupted: [],
};
export const isTerminalRun = (run: Pick<RunView, "status">): boolean => transitions[run.status].length === 0;

/** One terminal decision per Run. No I/O, scheduling or Pi execution here. */
export function transitionRun(run: RunView, next: RunStatus, at: string): boolean {
  if (run.status === next || isTerminalRun(run)) return false;
  if (!transitions[run.status].includes(next)) throw new Error(`Invalid Run transition: ${run.status} -> ${next}`);
  run.status = next;
  run.updatedAt = at;
  return true;
}
