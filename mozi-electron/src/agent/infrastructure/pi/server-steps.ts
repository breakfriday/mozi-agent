import type { ServerStepView } from "../../../../../shared/agent";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const types: Record<string, ServerStepView["type"]> = {
  reasoning: "reasoning", message: "message", web_search_call: "web_search", web_extractor_call: "web_extractor",
};
const encoder = new TextEncoder();

/** Only structured metadata. Never store page bodies, reasoning text, or arbitrary tool output. */
export class ServerStepsCollector {
  private readonly items = new Map<string, ServerStepView>();
  private readonly stepByteLengths = new Map<string, number>();
  private readonly completedTools = new Map<string, ServerStepView["type"]>();
  private serializedStepsBytes = 2; // `[]`
  truncated = false;

  private strings(value: unknown, urls = false): string[] | undefined {
    if (!Array.isArray(value)) return;
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) continue;
      if (item.length > 2048) { this.truncated = true; continue; }
      if (urls) {
        try {
          const url = new URL(item);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
        } catch { continue; }
      }
      if (result.includes(item)) continue;
      if (result.length >= 32) { this.truncated = true; break; }
      result.push(item);
    }
    return result;
  }

  private accept(value: unknown, observed: ServerStepView["observed"], done: boolean) {
    const item = record(value);
    if (!item || typeof item.type !== "string" || !Object.hasOwn(types, item.type)
      || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256) return;
    const type = types[item.type];
    // A completed output item implies completion for reasoning/message, whose status may be omitted.
    let status: ServerStepView["status"];
    if (item.status === "completed" || item.status === "failed" || item.status === "incomplete") status = item.status;
    else if (item.status === "in_progress" || !done) status = "running";
    else status = type === "reasoning" || type === "message" ? "completed" : "unknown";
    const previous = this.items.get(item.id);
    if (previous && previous.type !== type) return;
    if (status === "completed" && (type === "web_search" || type === "web_extractor")) this.completedTools.set(item.id, type);
    if (!previous && this.items.size >= 100) { this.truncated = true; return; }
    const step: ServerStepView = { ...previous, id: item.id, type, status, observed: previous?.observed ?? observed };
    // Replayed added events must not turn a finished item back into an in-progress one.
    if (previous && previous.status !== "running" && status === "running") step.status = previous.status;
    if (type === "web_search") {
      const action = record(item.action);
      const queries = this.strings([...(Array.isArray(action?.queries) ? action.queries : []), action?.query]);
      const sources = this.strings(Array.isArray(action?.sources) ? action.sources.map(source => record(source)?.url) : undefined, true);
      if (queries?.length) step.queries = queries;
      if (sources) step.sources = sources;
    }
    if (type === "web_extractor") {
      const urls = this.strings(item.urls, true);
      if (urls) step.urls = urls;
    }
    const stepByteLength = encoder.encode(JSON.stringify(step)).byteLength;
    const previousByteLength = this.stepByteLengths.get(step.id) ?? 0;
    const separatorByteLength = previous ? 0 : this.items.size > 0 ? 1 : 0;
    if (this.serializedStepsBytes - previousByteLength + stepByteLength + separatorByteLength > 64_000) {
      this.truncated = true;
      // Retain lifecycle progress even when large metadata does not fit.
      if (previous) this.store({ ...previous, status: step.status });
      return;
    }
    this.store(step, stepByteLength);
  }

  private store(step: ServerStepView, byteLength = encoder.encode(JSON.stringify(step)).byteLength) {
    const previousByteLength = this.stepByteLengths.get(step.id) ?? 0;
    const separatorByteLength = previousByteLength === 0 && this.items.size > 0 ? 1 : 0;
    this.serializedStepsBytes += byteLength - previousByteLength + separatorByteLength;
    this.stepByteLengths.set(step.id, byteLength);
    this.items.set(step.id, step);
  }

  collect(data: unknown) {
    const event = record(data);
    if (!event) return;
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      this.accept(event.item, "stream", event.type === "response.output_item.done");
    } else if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
      const output = record(event.response)?.output;
      if (Array.isArray(output)) for (const item of output) this.accept(item, "final", true);
    }
  }
  get steps(): ServerStepView[] { return [...this.items.values()]; }
  count(type: "web_search" | "web_extractor"): number | undefined {
    const count = [...this.completedTools.values()].filter(value => value === type).length;
    return count || undefined;
  }
}
