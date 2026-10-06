const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-ts.cjs')();
const { SqliteMetadataRepository } = load(path.resolve(__dirname, '../../src/agent/infrastructure/sqlite/metadata-repository.ts'));
const { contentHash } = load(path.resolve(__dirname, '../../src/agent/application/models.ts'));
function file(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mozi-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'agent.sqlite');
}
const metadata = () => ({ descriptor: { sessionId: 's', engine: 'pi', locator: '/pi/session.jsonl', cwd: '/tmp' },
  session: { sessionId: 's', title: 'keep', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' } });
for (const version of [1, 2]) test(`authorized development reset replaces v${version} with metadata tables`, t => {
  const filename = file(t);
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE creations (operation_id TEXT PRIMARY KEY, title TEXT NOT NULL, session_id TEXT NOT NULL);
    CREATE TABLE submissions (session_id TEXT NOT NULL, client_id TEXT NOT NULL, record TEXT NOT NULL);
    INSERT INTO sessions VALUES ('old', '{"old":"development-data"}'); PRAGMA user_version=${version};`);
  if (version === 2) old.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id));
    INSERT INTO messages VALUES ('message', 'run'); INSERT INTO runs VALUES ('run', 'message');
    CREATE TABLE message_links (message_id TEXT REFERENCES messages(id));
    CREATE TABLE tools (id TEXT); CREATE TABLE approvals (id TEXT);`);
  old.close();
  const repository = new SqliteMetadataRepository(filename);
  assert.equal(repository.listSessions().length, 0); repository.close();
  const db = new DatabaseSync(filename);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name),
    ['creations', 'message_links', 'model_settings', 'runs', 'sessions']);
  assert.equal(db.prepare('PRAGMA table_info(sessions)').all().some(column => ['record', 'last_seq', 'file_path'].includes(column.name)), false);
  db.close();
});
test('v5 reopens without resetting metadata; unknown versions are never discarded', t => {
  const filename = file(t), repository = new SqliteMetadataRepository(filename);
  repository.create('create', metadata()); repository.close();
  const reopened = new SqliteMetadataRepository(filename);
  assert.equal(reopened.listSessions()[0].session.title, 'keep'); reopened.close();
  const db = new DatabaseSync(filename); db.exec('PRAGMA user_version=99');
  assert.throws(() => new SqliteMetadataRepository(filename), /Unsupported/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(db.prepare('SELECT title FROM sessions').get().title, 'keep'); db.close();
});
test('native acknowledgement clears only the confirmed input and preserves deduplication', t => {
  const filename = file(t), repository = new SqliteMetadataRepository(filename);
  repository.create('create', metadata());
  const run = { id: 'r', sessionId: 's', userMessageId: 'm', status: 'accepted', createdAt: metadata().session.createdAt, updatedAt: metadata().session.updatedAt };
  const pendingContent = [{ type: 'text', text: 'pending input' }];
  const link = { messageId: 'm', runId: 'r', role: 'user', ordinal: 0 };
  repository.accept({ run, clientMessageId: 'c', contentHash: contentHash(pendingContent), pendingContent }, link);
  assert.equal(repository.readSession('s').runs[0].pendingContent[0].text, 'pending input');
  repository.saveLinks('s', [{ ...link, nativeEntryId: 'native-user' }]);
  assert.equal(repository.readSession('s').runs[0].pendingContent, undefined);
  assert.equal(repository.findSubmission('s', 'c').messageId, 'm');
  assert.equal(repository.findSubmission('s', 'c').contentHash, contentHash(pendingContent));
  repository.close();
});
test('submission digest preserves content order but ignores object property order', () => {
  assert.equal(contentHash([{ type: 'text', text: 'a' }]), contentHash([{ text: 'a', type: 'text' }]));
  assert.notEqual(contentHash([{ type: 'text', text: 'a' }]), contentHash([{ type: 'text', text: 'b' }]));
  assert.notEqual(contentHash([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), contentHash([{ type: 'text', text: 'ab' }]));
});

test('v3 migration preserves sessions and creation deduplication; deletions survive reopening', t => {
  const filename = file(t);
  const { AGENT_SCHEMA_V3 } = load(path.resolve(__dirname, '../../src/agent/infrastructure/sqlite/schema.ts'));
  const old = new DatabaseSync(filename);
  old.exec(AGENT_SCHEMA_V3);
  old.exec("INSERT INTO sessions VALUES ('s', 'pi', '/native', '/tmp', 'original', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); INSERT INTO creations VALUES ('operation', 'original', 's'); PRAGMA user_version=3;");
  old.close();
  const repository = new SqliteMetadataRepository(filename);
  assert.equal(repository.listSessions()[0].session.title, 'original');
  assert.equal(repository.findCreation('operation').sessionId, 's');
  repository.saveSession({ ...metadata(), session: { ...metadata().session, title: 'renamed' } });
  repository.deleteSession('s', new Date().toISOString());
  repository.close();
  const reopened = new SqliteMetadataRepository(filename);
  assert.equal(reopened.listSessions().length, 0);
  assert.deepEqual(Array.from(reopened.deletedSessionIds()), ['s']);
  assert.equal(reopened.findCreation('operation').sessionId, 's');
  reopened.close();
});


test('v4 upgrades in place and model choices survive reopening', t => {
  const filename = file(t);
  const { AGENT_SCHEMA_V3 } = load(path.resolve(__dirname, '../../src/agent/infrastructure/sqlite/schema.ts'));
  const old = new DatabaseSync(filename);
  old.exec(AGENT_SCHEMA_V3);
  old.exec("ALTER TABLE sessions ADD COLUMN deleted_at TEXT; INSERT INTO sessions (id, engine, locator, cwd, title, created_at, updated_at) VALUES ('s', 'pi', '/native', '/tmp', 'original', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); PRAGMA user_version=4;");
  old.close();
  const repository = new SqliteMetadataRepository(filename);
  const model = { providerId: 'bailian-tp', modelId: 'model' };
  assert.equal(repository.listSessions()[0].session.title, 'original');
  repository.setDefaultModel(model);
  repository.saveSession({ ...metadata(), session: { ...metadata().session, model } });
  repository.close();
  const reopened = new SqliteMetadataRepository(filename);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.getDefaultModel())), model);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.listSessions()[0].session.model)), model);
  reopened.close();
});
