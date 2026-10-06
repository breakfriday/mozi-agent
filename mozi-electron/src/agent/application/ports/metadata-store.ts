import type { RunView } from "../../../../../shared/agent";
import type { MessageLink, RunMetadata, SessionMetadata, SessionMetadataDetails, SubmissionRecord } from "../models";

/** Mozi metadata only: no history, UI snapshots or SDK context.
 * Mutations synchronously commit before acceptance/events. An async implementation
 * must also serialize acceptance in RunService.
 */
export interface MetadataStore {
  listSessions(): SessionMetadata[];
  deletedSessionIds(): string[];
  deleteSession(sessionId: string, deletedAt: string): void;
  saveSession(metadata: SessionMetadata): void;
  readSession(sessionId: string): SessionMetadataDetails;
  unfinishedRuns(): RunView[];
  findRun(sessionId: string, runId: string): RunView | undefined;
  findCreation(operationId: string): { title: string; sessionId: string } | undefined;
  create(operationId: string, metadata: SessionMetadata): void;
  findSubmission(sessionId: string, clientMessageId: string): SubmissionRecord | undefined;
  accept(metadata: RunMetadata, link: MessageLink): void;
  updateRun(run: RunView): void;
  /** Native user links acknowledge delivery and clear pending input atomically. */
  saveLinks(sessionId: string, links: MessageLink[]): void;
  close(): void;
}
