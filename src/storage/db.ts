import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../util/logger.js';

const log = createLogger('storage');

/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 *
 * Append only — never edit a shipped entry, or existing databases will diverge
 * from new ones.
 */
const MIGRATIONS: readonly string[] = [
  // 1 — initial schema (spec §36)
  `
  CREATE TABLE projects (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    path               TEXT NOT NULL,
    discord_enabled    INTEGER NOT NULL DEFAULT 0,
    discord_channel_id TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title              TEXT NOT NULL DEFAULT '',
    provider_id        TEXT NOT NULL,
    discord_guild_id   TEXT,
    discord_channel_id TEXT,
    discord_thread_id  TEXT,
    copilot_session_id TEXT,
    copilot_process_id INTEGER,
    status             TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  -- One thread is exactly one session (§9). SQLite permits many NULLs in a
  -- unique index, so CLI sessions without a thread coexist happily.
  CREATE UNIQUE INDEX idx_sessions_thread ON sessions(discord_thread_id);
  CREATE INDEX idx_sessions_project_status ON sessions(project_id, status);

  CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_messages_session ON messages(session_id, created_at);

  CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL,
    action_type  TEXT NOT NULL,
    description  TEXT NOT NULL,
    command      TEXT,
    target       TEXT,
    risk_level   TEXT NOT NULL DEFAULT 'medium',
    risk_reason  TEXT,
    tool_call_id TEXT,
    status       TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    resolved_at  TEXT,
    resolved_by  TEXT
  );

  CREATE INDEX idx_approvals_session_status ON approvals(session_id, status);
  CREATE INDEX idx_approvals_status ON approvals(status);

  CREATE TABLE memories (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    content     TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'general',
    created_at  TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX idx_memories_project ON memories(project_id, created_at);
  `,
];

export interface OpenDatabaseOptions {
  /** Path to the SQLite file, or ':memory:' for tests. */
  readonly databasePath: string;
}

export function openDatabase({ databasePath }: OpenDatabaseOptions): DatabaseSync {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);

  db.exec('PRAGMA foreign_keys = ON');
  if (databasePath !== ':memory:') {
    // WAL keeps readers from blocking the writer, which matters because several
    // sessions write progress concurrently (§38).
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db, databasePath);
  return db;
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function migrate(db: DatabaseSync, label: string): void {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    throw new Error(
      `database ${label} is at schema version ${from}, but this build only knows ${MIGRATIONS.length}. ` +
        `Downgrading is not supported.`,
    );
  }
  if (from === MIGRATIONS.length) return;

  for (let version = from; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    log.info(`applying migration ${version + 1}/${MIGRATIONS.length} to ${label}`);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      // user_version does not accept a bound parameter.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${version + 1} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}
