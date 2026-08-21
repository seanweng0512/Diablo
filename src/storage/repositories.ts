import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ActionType, ApprovalRequest, ApprovalStatus, RiskLevel } from '../approval/models.js';
import type {
  MemoryEntry,
  MessageRole,
  Session,
  SessionStatus,
  StoredMessage,
} from '../core/types.js';
import { nowIso } from '../core/types.js';

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  discordEnabled: boolean;
  discordChannelId: string | null;
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Mirrors the configured projects into the database, preserving created_at. */
  upsert(record: ProjectRecord): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, discord_enabled, discord_channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           discord_enabled = excluded.discord_enabled,
           discord_channel_id = excluded.discord_channel_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.name,
        record.path,
        record.discordEnabled ? 1 : 0,
        record.discordChannelId,
        now,
        now,
      );
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function toSession(row: Row): Session {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    title: str(row['title']),
    providerId: str(row['provider_id']),
    discordGuildId: nullableStr(row['discord_guild_id']),
    discordChannelId: nullableStr(row['discord_channel_id']),
    discordThreadId: nullableStr(row['discord_thread_id']),
    copilotSessionId: nullableStr(row['copilot_session_id']),
    copilotProcessId: nullableInt(row['copilot_process_id']),
    status: str(row['status']) as SessionStatus,
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
  };
}

export interface CreateSessionInput {
  projectId: string;
  title: string;
  providerId: string;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  discordThreadId?: string | null;
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateSessionInput): Session {
    const now = nowIso();
    const session: Session = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      providerId: input.providerId,
      discordGuildId: input.discordGuildId ?? null,
      discordChannelId: input.discordChannelId ?? null,
      discordThreadId: input.discordThreadId ?? null,
      copilotSessionId: null,
      copilotProcessId: null,
      status: 'Created',
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (
           id, project_id, title, provider_id, discord_guild_id, discord_channel_id,
           discord_thread_id, copilot_session_id, copilot_process_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.title,
        session.providerId,
        session.discordGuildId,
        session.discordChannelId,
        session.discordThreadId,
        session.copilotSessionId,
        session.copilotProcessId,
        session.status,
        session.createdAt,
        session.updatedAt,
      );

    return session;
  }

  findById(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? toSession(row) : null;
  }

  /** §13 — the only lookup a Discord user should ever need. */
  findByThreadId(threadId: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE discord_thread_id = ?')
      .get(threadId) as Row | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * The session a thread should route to, ignoring ones that have been reset or
   * finished. Used by /reset, which retires a session and lets the next message
   * open a fresh one for the same thread (§33).
   */
  findActiveByThreadId(threadId: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE discord_thread_id = ?
           AND status IN ('Created', 'Running', 'WaitingForApproval')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as Row | undefined;
    return row ? toSession(row) : null;
  }

  listByProject(projectId: string): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Row[];
    return rows.map(toSession);
  }

  listActive(): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status IN ('Created', 'Running', 'WaitingForApproval')
         ORDER BY created_at ASC`,
      )
      .all() as Row[];
    return rows.map(toSession);
  }

  countActiveByProject(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions
         WHERE project_id = ? AND status IN ('Created', 'Running', 'WaitingForApproval')`,
      )
      .get(projectId) as Row | undefined;
    return Number(row?.['n'] ?? 0);
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  /**
   * Records the ACP session id and OS pid so a restart can resume the
   * conversation via `session/load` (§14 item 9).
   */
  updateCopilotBinding(id: string, copilotSessionId: string | null, pid: number | null): void {
    this.db
      .prepare(
        'UPDATE sessions SET copilot_session_id = ?, copilot_process_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(copilotSessionId, pid, nowIso(), id);
  }

  /**
   * Releases a session's claim on its Discord thread.
   *
   * `/reset` needs this: the unique index means a retired session still owns its
   * thread id, so the replacement session cannot be created until the old one
   * lets go (§33).
   */
  detachThread(id: string): void {
    this.db
      .prepare('UPDATE sessions SET discord_thread_id = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), id);
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), id);
  }

  /**
   * Marks sessions left running by a previous process as Failed. Copilot
   * processes die with the Bridge, so any session still "active" at startup is
   * an orphan; saying so is better than pretending it is alive (§39).
   */
  failOrphanedSessions(): number {
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = 'Failed', updated_at = ?
         WHERE status IN ('Created', 'Running', 'WaitingForApproval')`,
      )
      .run(nowIso());
    return Number(result.changes ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export class MessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(sessionId: string, role: MessageRole, content: string): StoredMessage {
    const message: StoredMessage = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: nowIso(),
    };
    this.db
      .prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt);
    return message;
  }

  listBySession(sessionId: string, limit = 200): StoredMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
      )
      .all(sessionId, limit) as Row[];
    return rows.map((row) => ({
      id: str(row['id']),
      sessionId: str(row['session_id']),
      role: str(row['role']) as MessageRole,
      content: str(row['content']),
      createdAt: str(row['created_at']),
    }));
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function toApproval(row: Row): ApprovalRequest {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    projectId: str(row['project_id']),
    actionType: str(row['action_type']) as ActionType,
    description: str(row['description']),
    command: nullableStr(row['command']),
    target: nullableStr(row['target']),
    riskLevel: str(row['risk_level']) as RiskLevel,
    riskReason: nullableStr(row['risk_reason']),
    toolCallId: nullableStr(row['tool_call_id']),
    status: str(row['status']) as ApprovalStatus,
    requestedAt: str(row['requested_at']),
    resolvedAt: nullableStr(row['resolved_at']),
    resolvedBy: nullableStr(row['resolved_by']),
  };
}

export interface CreateApprovalInput {
  sessionId: string;
  projectId: string;
  actionType: ActionType;
  description: string;
  command: string | null;
  target: string | null;
  riskLevel: RiskLevel;
  riskReason: string | null;
  toolCallId: string | null;
}

export class ApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateApprovalInput): ApprovalRequest {
    const approval: ApprovalRequest = {
      id: randomUUID(),
      ...input,
      status: 'Pending',
      requestedAt: nowIso(),
      resolvedAt: null,
      resolvedBy: null,
    };

    this.db
      .prepare(
        `INSERT INTO approvals (
           id, session_id, project_id, action_type, description, command, target,
           risk_level, risk_reason, tool_call_id, status, requested_at, resolved_at, resolved_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.projectId,
        approval.actionType,
        approval.description,
        approval.command,
        approval.target,
        approval.riskLevel,
        approval.riskReason,
        approval.toolCallId,
        approval.status,
        approval.requestedAt,
        approval.resolvedAt,
        approval.resolvedBy,
      );

    return approval;
  }

  findById(id: string): ApprovalRequest | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  /**
   * Resolves an approval, returning false if it was not in an expected state.
   *
   * The `from` guard makes this a compare-and-set, which is what stops two
   * Discord users from both "winning" the same button press. Expired is an
   * allowed source state by default so that a late click still lands — §41 says
   * expiry must not approve anything, not that the user loses their say.
   */
  resolve(
    id: string,
    status: ApprovalStatus,
    resolvedBy: string | null,
    from: readonly ApprovalStatus[] = ['Pending', 'Expired'],
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(status, nowIso(), resolvedBy, id, ...from);
    return Number(result.changes ?? 0) > 0;
  }

  listPendingBySession(sessionId: string): ApprovalRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? AND status = 'Pending' ORDER BY requested_at ASC`,
      )
      .all(sessionId) as Row[];
    return rows.map(toApproval);
  }

  listPending(): ApprovalRequest[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'Pending' ORDER BY requested_at ASC`)
      .all() as Row[];
    return rows.map(toApproval);
  }

  /**
   * Marks approvals still pending past their deadline as Expired.
   *
   * Expiry is bookkeeping only — it never answers Copilot, which is what makes
   * §41's "must not automatically approve an expired request" hold.
   */
  markExpiredBefore(cutoffIso: string): ApprovalRequest[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'Pending' AND requested_at < ?`)
      .all(cutoffIso) as Row[];
    const expired = rows.map(toApproval);
    for (const approval of expired) {
      this.resolve(approval.id, 'Expired', null, ['Pending']);
    }
    return expired;
  }

  /** Cancels every outstanding approval for a session, e.g. on /cancel or /reset. */
  cancelBySession(sessionId: string): ApprovalRequest[] {
    const outstanding = this.db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? AND status IN ('Pending', 'Expired')
         ORDER BY requested_at ASC`,
      )
      .all(sessionId) as Row[];
    const approvals = outstanding.map(toApproval);
    for (const approval of approvals) {
      this.resolve(approval.id, 'Cancelled', null);
    }
    return approvals;
  }
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export class MemoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(projectId: string, content: string, category: string, approvedBy: string): MemoryEntry {
    const entry: MemoryEntry = {
      id: randomUUID(),
      projectId,
      content,
      category,
      createdAt: nowIso(),
      approvedBy,
    };
    this.db
      .prepare(
        'INSERT INTO memories (id, project_id, content, category, created_at, approved_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.projectId, entry.content, entry.category, entry.createdAt, entry.approvedBy);
    return entry;
  }

  /** Every query is scoped by project_id — this is what makes §45 step 23 hold. */
  listByProject(projectId: string, limit = 200): MemoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(projectId, limit) as Row[];
    return rows.map(toMemory);
  }

  search(projectId: string, query: string, limit = 50): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE project_id = ? AND content LIKE ? ESCAPE '\\'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(projectId, `%${escapeLike(query)}%`, limit) as Row[];
    return rows.map(toMemory);
  }

  /** Deletes by id, but only within the given project, so ids cannot cross boundaries. */
  remove(projectId: string, id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM memories WHERE id = ? AND project_id = ?')
      .run(id, projectId);
    return Number(result.changes ?? 0) > 0;
  }

  findDuplicate(projectId: string, content: string): MemoryEntry | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE project_id = ? AND content = ? LIMIT 1')
      .get(projectId, content) as Row | undefined;
    return row ? toMemory(row) : null;
  }
}

function toMemory(row: Row): MemoryEntry {
  return {
    id: str(row['id']),
    projectId: str(row['project_id']),
    content: str(row['content']),
    category: str(row['category']),
    createdAt: str(row['created_at']),
    approvedBy: str(row['approved_by']),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// ---------------------------------------------------------------------------

export interface Repositories {
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly messages: MessageRepository;
  readonly approvals: ApprovalRepository;
  readonly memories: MemoryRepository;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    projects: new ProjectRepository(db),
    sessions: new SessionRepository(db),
    messages: new MessageRepository(db),
    approvals: new ApprovalRepository(db),
    memories: new MemoryRepository(db),
  };
}
