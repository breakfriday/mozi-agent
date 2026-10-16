import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isModelCallView, type ModelCallView } from "../../../../../../shared/agent";
import { validResponseModel } from "../model-call/response-model-collector";

// Persisted names are part of the existing JSONL format; changing them requires migration.
export const RUN_ENTRY = "mozi.run";
export const USAGE_ENTRY = "mozi.model-call-usage";
export const RESPONSE_MODEL_ENTRY = "mozi.provider-response-model";

export interface RunEntryData {
  runId: string;
  clientMessageId: string;
}
export type UsageEntryData = ModelCallView;
export interface ResponseModelEntryData {
  nativeEntryId: string;
  responseModelId: string;
}

// These builders supply only the custom payload; Pi owns IDs, timestamps and parent links.
export function createRunEntry(data: RunEntryData) {
  return { customType: RUN_ENTRY, data: { runId: data.runId, clientMessageId: data.clientMessageId } };
}
export function createUsageEntry(data: UsageEntryData) {
  return { customType: USAGE_ENTRY, data };
}
export function createResponseModelEntry(data: ResponseModelEntryData) {
  return { customType: RESPONSE_MODEL_ENTRY, data: { nativeEntryId: data.nativeEntryId, responseModelId: data.responseModelId } };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A malformed run payload still marks a boundary and clears the previous run's identity. */
export function parseRunEntry(entry: SessionEntry): Partial<RunEntryData> | undefined {
  if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) return;
  const data = record(entry.data);
  return {
    ...(typeof data?.runId === "string" ? { runId: data.runId } : {}),
    ...(typeof data?.clientMessageId === "string" ? { clientMessageId: data.clientMessageId } : {}),
  };
}

export function parseUsageEntry(entry: SessionEntry): UsageEntryData | undefined {
  if (entry.type !== "custom" || entry.customType !== USAGE_ENTRY || !isModelCallView(entry.data)) return;
  return entry.data;
}

export function parseResponseModelEntry(entry: SessionEntry): ResponseModelEntryData | undefined {
  if (entry.type !== "custom" || entry.customType !== RESPONSE_MODEL_ENTRY) return;
  const data = record(entry.data);
  if (typeof data?.nativeEntryId !== "string" || !validResponseModel(data.responseModelId)) return;
  return { nativeEntryId: data.nativeEntryId, responseModelId: data.responseModelId };
}
