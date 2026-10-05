import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, StartRunInput } from "../../../shared/agent";
import { isApiResultFor } from "../../../shared/agent";
import type { RuntimeSessionDescriptor } from "./runtime";

export interface SessionRecord {
  descriptor: RuntimeSessionDescriptor;
  snapshot: SessionSnapshot;
  messageLinks: { messageId: string; runId: string; role: "user" | "assistant"; ordinal: number; nativeEntryId?: string }[];
}
export interface SubmissionRecord {
  input: StartRunInput;
  runId: string;
  messageId: string;
}

/** A single writer in the utility process; acceptance and IDs share one transaction. */
export class AgentRepository {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error("Unsupported Agent database version.");
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creations (operation_id TEXT PRIMARY KEY, title TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (session_id TEXT NOT NULL, client_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(session_id, client_id));
      PRAGMA user_version=1;`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  load(): SessionRecord[] {
    return this.db.prepare("SELECT record FROM sessions").all().map((row) => {
      const record = JSON.parse(String(row.record)) as SessionRecord;
      if (!isApiResultFor("session.snapshot", { ok: true, result: record.snapshot })
        || record.descriptor.sessionId !== record.snapshot.session.sessionId || !Array.isArray(record.messageLinks)) {
        throw new Error("Invalid persisted Agent session; refusing to discard history.");
      }
      return record;
    });
  }
  findCreation(operationId: string): { title: string; sessionId: string } | undefined {
    const row = this.db.prepare("SELECT title, session_id FROM creations WHERE operation_id=?").get(operationId);
    return row ? { title: String(row.title), sessionId: String(row.session_id) } : undefined;
  }
  create(operationId: string, title: string, record: SessionRecord): void {
    this.transaction(() => {
      this.save(record);
      this.db.prepare("INSERT INTO creations VALUES (?, ?, ?)").run(operationId, title, record.descriptor.sessionId);
    });
  }
  findSubmission(sessionId: string, clientMessageId: string): SubmissionRecord | undefined {
    const row = this.db.prepare("SELECT record FROM submissions WHERE session_id=? AND client_id=?").get(sessionId, clientMessageId);
    return row ? JSON.parse(String(row.record)) as SubmissionRecord : undefined;
  }
  accept(record: SessionRecord, submission: SubmissionRecord): void {
    this.transaction(() => {
      this.save(record);
      this.db.prepare("INSERT INTO submissions VALUES (?, ?, ?)")
        .run(record.descriptor.sessionId, submission.input.clientMessageId, JSON.stringify(submission));
    });
  }
  save(record: SessionRecord): void {
    this.db.prepare("INSERT INTO sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(record.descriptor.sessionId, JSON.stringify(record));
  }
  close(): void { this.db.close(); }
}
