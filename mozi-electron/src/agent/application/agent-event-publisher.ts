import { AGENT_PROTOCOL_VERSION } from "../../../../shared/agent";
import type { AgentEvent, EventPayload } from "../../../../shared/agent";
import type { SessionState } from "./state/session-state";

/** Sequence ownership lasts for the process, independently of projection caches. */
export class AgentEventPublisher {
  private readonly sequences = new Map<string, number>();
  constructor(private readonly emit: (event: AgentEvent) => void) {}
  sequence(sessionId: string): number { return this.sequences.get(sessionId) ?? 0; }
  publish(state: SessionState, runId: string, payload: EventPayload): void {
    const snapshot = state.record.snapshot;
    const sessionId = snapshot.session.sessionId;
    const seq = this.sequence(sessionId) + 1;
    this.sequences.set(sessionId, seq);
    snapshot.session.updatedAt = new Date().toISOString();
    snapshot.lastSeq = seq;
    this.emit(structuredClone({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "event", sessionId, runId, seq, ...payload }) as AgentEvent);
  }
}
