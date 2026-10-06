// Native histories live in the owning engine. These are application metadata only.
export const AGENT_SCHEMA_V3 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, engine TEXT NOT NULL, locator TEXT NOT NULL, cwd TEXT NOT NULL,
  title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE creations (
  operation_id TEXT PRIMARY KEY, title TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), user_message_id TEXT NOT NULL,
  client_id TEXT NOT NULL, content_hash TEXT NOT NULL, pending_content TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error TEXT, interruption_reason TEXT, UNIQUE(session_id, client_id)
);
CREATE INDEX runs_session ON runs(session_id, created_at);
CREATE TABLE message_links (
  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL, ordinal INTEGER NOT NULL, native_entry_id TEXT,
  UNIQUE(run_id, role, ordinal), UNIQUE(session_id, native_entry_id)
);
CREATE INDEX message_links_session ON message_links(session_id);
`;
