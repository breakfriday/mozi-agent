import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelSelection, RunView } from "../../../../../shared/agent";
import type { MessageLink, RunMetadata, SessionMetadata, SessionMetadataDetails, SubmissionRecord } from "../../application/models";
import { AGENT_SCHEMA_V3 } from "./schema";
import type { MetadataStore } from "../../application/ports/metadata-store";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const parse = <T>(value: Row[string]): T => JSON.parse(String(value)) as T;
const runView = (row: Row): RunView => ({
  id: String(row.id), sessionId: String(row.session_id), userMessageId: String(row.user_message_id),
  status: row.status as RunView["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  ...(row.model ? { model: parse<ModelSelection>(row.model) } : {}),
  ...(row.model_config_version ? { modelConfigVersion: String(row.model_config_version) } : {}),
  ...(row.error !== null ? { error: parse<NonNullable<RunView["error"]>>(row.error) } : {}),
  ...(row.interruption_reason !== null ? { interruptionReason: String(row.interruption_reason) } : {}),
});

/** Single writer for Mozi metadata. Message bodies belong to the native runtime. */
export class SqliteMetadataRepository implements MetadataStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 3 && version !== 4 && version !== 5 && version !== 6) {
        if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported Agent database version.");
        this.db.exec("PRAGMA foreign_keys=OFF;");
        // Authorized development reset; native session files are never deleted.
        // FKs stay off during the transaction to remove v2's cyclic message/Run graph.
        this.transaction(() => {
          if (version !== 0) this.db.exec(`DROP TABLE IF EXISTS approvals; DROP TABLE IF EXISTS tools;
            DROP TABLE IF EXISTS message_links; DROP TABLE IF EXISTS submissions; DROP TABLE IF EXISTS creations;
            DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS sessions;`);
          this.db.exec(AGENT_SCHEMA_V3);
          this.db.exec("PRAGMA user_version=3;");
        });
      }
      if (version !== 4 && version !== 5 && version !== 6) this.transaction(() => {
        this.db.exec("ALTER TABLE sessions ADD COLUMN deleted_at TEXT; PRAGMA user_version=4;");
      });
      if (version !== 5 && version !== 6) this.transaction(() => {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT;
          ALTER TABLE runs ADD COLUMN model TEXT;
          ALTER TABLE runs ADD COLUMN model_config_version TEXT;
          ALTER TABLE creations ADD COLUMN model TEXT;
          CREATE TABLE model_settings (id INTEGER PRIMARY KEY CHECK(id=1), selection TEXT NOT NULL);
          PRAGMA user_version=5;`);
      });
      if (version !== 6) this.transaction(() => {
        this.db.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT CHECK(title_source IN ('automatic', 'explicit')); PRAGMA user_version=6;");
      });
      this.db.exec("PRAGMA foreign_keys=ON;");
    } catch (error) { this.db.close(); throw error; }
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getDefaultModel(): ModelSelection | undefined {
    const row = this.statement("SELECT selection FROM model_settings WHERE id=1").get();
    return row ? parse<ModelSelection>(row.selection) : undefined;
  }
  setDefaultModel(model: ModelSelection): void {
    this.statement("INSERT INTO model_settings (id, selection) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET selection=excluded.selection").run(JSON.stringify(model));
  }
  listSessions(): SessionMetadata[] {
    return this.statement("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY created_at, id").all().map(row => ({
      ...(row.title_source ? { titleSource: row.title_source as SessionMetadata["titleSource"] } : {}),
      descriptor: { sessionId: String(row.id), engine: String(row.engine), locator: String(row.locator), cwd: String(row.cwd) },
      session: { ...(row.model ? { model: parse<ModelSelection>(row.model) } : {}), sessionId: String(row.id), title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at) },
    }));
  }
  deletedSessionIds(): string[] {
    return this.statement("SELECT id FROM sessions WHERE deleted_at IS NOT NULL").all().map(row => String(row.id));
  }
  // Retain native history and deduplication records; tombstones prevent rediscovery.
  deleteSession(sessionId: string, deletedAt: string): void {
    this.statement("UPDATE sessions SET deleted_at=? WHERE id=?").run(deletedAt, sessionId);
  }
  saveSession({ descriptor, session, titleSource }: SessionMetadata): void {
    this.statement(`INSERT INTO sessions (id, engine, locator, cwd, title, created_at, updated_at, model, title_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET engine=excluded.engine, locator=excluded.locator, cwd=excluded.cwd,
      title=excluded.title, updated_at=excluded.updated_at, model=excluded.model, title_source=excluded.title_source`)
      .run(session.sessionId, descriptor.engine, descriptor.locator, descriptor.cwd, session.title, session.createdAt, session.updatedAt, session.model ? JSON.stringify(session.model) : null, titleSource ?? null);
  }
  readSession(sessionId: string): SessionMetadataDetails {
    return {
      runs: this.statement("SELECT * FROM runs WHERE session_id=? ORDER BY created_at, rowid").all(sessionId).map(row => ({
        run: runView(row), clientMessageId: String(row.client_id), contentHash: String(row.content_hash),
        ...(row.pending_content !== null ? { pendingContent: parse<NonNullable<RunMetadata["pendingContent"]>>(row.pending_content) } : {}),
      })),
      links: this.statement("SELECT * FROM message_links WHERE session_id=? ORDER BY rowid").all(sessionId).map(row => ({
        messageId: String(row.message_id), runId: String(row.run_id), role: row.role as MessageLink["role"], ordinal: Number(row.ordinal),
        ...(row.native_entry_id !== null ? { nativeEntryId: String(row.native_entry_id) } : {}),
      })),
    };
  }
  unfinishedRuns(): RunView[] {
    return this.statement("SELECT * FROM runs WHERE status IN ('accepted', 'running', 'waiting_approval', 'cancelling')").all().map(runView);
  }
  findRun(sessionId: string, runId: string): RunView | undefined {
    const row = this.statement("SELECT * FROM runs WHERE session_id=? AND id=?").get(sessionId, runId);
    return row ? runView(row) : undefined;
  }
  findCreation(operationId: string): { title: string; sessionId: string; model?: ModelSelection } | undefined {
    const row = this.statement("SELECT title, session_id, model FROM creations WHERE operation_id=?").get(operationId);
    return row ? { title: String(row.title), sessionId: String(row.session_id), ...(row.model ? { model: parse<ModelSelection>(row.model) } : {}) } : undefined;
  }
  create(operationId: string, metadata: SessionMetadata, model?: ModelSelection): void {
    this.transaction(() => {
      this.saveSession(metadata);
      this.statement("INSERT INTO creations (operation_id, title, session_id, model) VALUES (?, ?, ?, ?)").run(operationId, metadata.session.title, metadata.descriptor.sessionId, model ? JSON.stringify(model) : null);
    });
  }
  findSubmission(sessionId: string, clientMessageId: string): SubmissionRecord | undefined {
    const row = this.statement("SELECT id, content_hash, user_message_id FROM runs WHERE session_id=? AND client_id=?").get(sessionId, clientMessageId);
    return row ? { sessionId, clientMessageId, contentHash: String(row.content_hash), runId: String(row.id), messageId: String(row.user_message_id) } : undefined;
  }
  accept({ run, clientMessageId, contentHash, pendingContent }: RunMetadata, link: MessageLink): void {
    this.transaction(() => {
      this.statement(`INSERT INTO runs (id, session_id, user_message_id, client_id, content_hash, pending_content,
        status, created_at, updated_at, model, model_config_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.sessionId, run.userMessageId, clientMessageId, contentHash, JSON.stringify(pendingContent), run.status, run.createdAt, run.updatedAt, run.model ? JSON.stringify(run.model) : null, run.modelConfigVersion ?? null);
      this.writeLinks(run.sessionId, [link]);
      this.touch(run);
    });
  }
  private touch(run: RunView): void {
    this.statement("UPDATE sessions SET updated_at=? WHERE id=?").run(run.updatedAt, run.sessionId);
  }
  updateRun(run: RunView): void {
    this.transaction(() => {
      this.statement("UPDATE runs SET status=?, updated_at=?, error=?, interruption_reason=? WHERE id=?")
        .run(run.status, run.updatedAt, run.error ? JSON.stringify(run.error) : null, run.interruptionReason ?? null, run.id);
      this.touch(run);
    });
  }
  private writeLinks(sessionId: string, links: MessageLink[]): void {
    for (const link of links) {
      this.statement(`INSERT INTO message_links (message_id, session_id, run_id, role, ordinal, native_entry_id)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET native_entry_id=excluded.native_entry_id`)
        .run(link.messageId, sessionId, link.runId, link.role, link.ordinal, link.nativeEntryId ?? null);
      if (link.role === "user" && link.nativeEntryId) {
        this.statement("UPDATE runs SET pending_content=NULL WHERE id=? AND session_id=? AND pending_content IS NOT NULL").run(link.runId, sessionId);
      }
    }
  }
  saveLinks(sessionId: string, links: MessageLink[]): void {
    if (links.length) this.transaction(() => this.writeLinks(sessionId, links));
  }
  close(): void { this.statements.clear(); this.db.close(); }
}
