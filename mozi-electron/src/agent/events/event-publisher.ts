import { AGENT_PROTOCOL_VERSION } from "../../../../shared/agent";
import type { AgentEvent, EventPayload } from "../../../../shared/agent";

/** Sequence ownership lasts for the process, independently of projection caches. */
export class AgentEventPublisher {
  private readonly sequences = new Map<string, number>();
  constructor(private readonly emit: (event: AgentEvent) => void) {}
  sequence(sessionId: string): number { return this.sequences.get(sessionId) ?? 0; }
  prepare(sessionId: string, runId: string, payloads: EventPayload[]): AgentEvent[] {
    const start = this.sequence(sessionId);
    const events = payloads.map((payload, index) => structuredClone({
      protocolVersion: AGENT_PROTOCOL_VERSION, kind: "event", sessionId, runId, seq: start + index + 1, ...payload,
    }) as AgentEvent);
    this.sequences.set(sessionId, start + events.length);
    return events;
  }
  publish(events: AgentEvent[]): void { for (const event of events) this.emit(event); }
}
