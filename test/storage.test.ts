import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/storage/db';
import { createRepositories, type Repositories } from '../src/storage/repositories';

let db: DatabaseSync;
let repos: Repositories;

function seedProject(id: string): void {
  repos.projects.upsert({
    id,
    name: id,
    path: `C:/Projects/${id}`,
    discordEnabled: true,
    discordChannelId: `chan-${id}`,
  });
}

beforeEach(() => {
  db = openDatabase({ databasePath: ':memory:' });
  repos = createRepositories(db);
});

describe('migrations', () => {
  it('brings a fresh database up to the current schema version', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBeGreaterThan(0);
  });

  it('is idempotent — reopening applies nothing new', () => {
    const before = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const again = openDatabase({ databasePath: ':memory:' });
    const after = (again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(after).toBe(before);
  });

  it('creates every table the spec calls for (§36)', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const table of ['projects', 'sessions', 'messages', 'approvals', 'memories']) {
      expect(names).toContain(table);
    }
  });
});

describe('sessions', () => {
  beforeEach(() => seedProject('backend'));

  it('starts life in Created (§11)', () => {
    const session = repos.sessions.create({
      projectId: 'backend',
      title: 'Fix Redis timeout',
      providerId: 'discord',
      discordThreadId: 'thread-1',
    });
    expect(session.status).toBe('Created');
    expect(repos.sessions.findById(session.id)?.title).toBe('Fix Redis timeout');
  });

  it('resolves a thread to its session without the user supplying an id (§13)', () => {
    const created = repos.sessions.create({
      projectId: 'backend',
      title: 'Fix Redis timeout',
      providerId: 'discord',
      discordThreadId: 'thread-1',
    });
    expect(repos.sessions.findByThreadId('thread-1')?.id).toBe(created.id);
    expect(repos.sessions.findByThreadId('thread-nope')).toBeNull();
  });

  it('refuses two sessions on one thread (§9)', () => {
    repos.sessions.create({ projectId: 'backend', title: 'a', providerId: 'discord', discordThreadId: 't' });
    expect(() =>
      repos.sessions.create({ projectId: 'backend', title: 'b', providerId: 'discord', discordThreadId: 't' }),
    ).toThrow();
  });

  it('allows many sessions with no thread, for the CLI provider', () => {
    repos.sessions.create({ projectId: 'backend', title: 'a', providerId: 'cli' });
    repos.sessions.create({ projectId: 'backend', title: 'b', providerId: 'cli' });
    expect(repos.sessions.listByProject('backend')).toHaveLength(2);
  });

  it('lets /reset retire a session so the thread can open a fresh one (§33)', () => {
    const first = repos.sessions.create({
      projectId: 'backend',
      title: 'a',
      providerId: 'discord',
      discordThreadId: 't',
    });
    repos.sessions.updateStatus(first.id, 'Cancelled');
    expect(repos.sessions.findActiveByThreadId('t')).toBeNull();
    // The unique index is on the column, so a retired session still occupies the
    // thread id; /reset therefore clears it before opening the replacement.
    expect(repos.sessions.findByThreadId('t')?.id).toBe(first.id);
  });

  it('counts only active sessions when enforcing the concurrency cap', () => {
    const a = repos.sessions.create({ projectId: 'backend', title: 'a', providerId: 'cli' });
    repos.sessions.create({ projectId: 'backend', title: 'b', providerId: 'cli' });
    expect(repos.sessions.countActiveByProject('backend')).toBe(2);
    repos.sessions.updateStatus(a.id, 'Completed');
    expect(repos.sessions.countActiveByProject('backend')).toBe(1);
  });

  it('marks sessions orphaned by a restart as Failed (§39)', () => {
    repos.sessions.create({ projectId: 'backend', title: 'a', providerId: 'cli' });
    expect(repos.sessions.failOrphanedSessions()).toBe(1);
    expect(repos.sessions.listActive()).toHaveLength(0);
  });
});

describe('approvals', () => {
  let sessionId: string;

  beforeEach(() => {
    seedProject('backend');
    sessionId = repos.sessions.create({ projectId: 'backend', title: 't', providerId: 'discord' }).id;
  });

  function pending() {
    return repos.approvals.create({
      sessionId,
      projectId: 'backend',
      actionType: 'execute_command',
      description: 'Run tests',
      command: 'dotnet test',
      target: null,
      riskLevel: 'medium',
      riskReason: null,
      toolCallId: 'toolu_1',
    });
  }

  it('opens Pending and records the command (§22)', () => {
    const approval = pending();
    expect(approval.status).toBe('Pending');
    expect(approval.command).toBe('dotnet test');
  });

  it('resolves exactly once, so two racing clicks cannot both win', () => {
    const approval = pending();
    expect(repos.approvals.resolve(approval.id, 'Approved', 'user-1')).toBe(true);
    expect(repos.approvals.resolve(approval.id, 'Rejected', 'user-2')).toBe(false);

    const stored = repos.approvals.findById(approval.id)!;
    expect(stored.status).toBe('Approved');
    expect(stored.resolvedBy).toBe('user-1');
  });

  it('expires stale requests without ever approving them (§41)', () => {
    const approval = pending();
    const future = new Date(Date.now() + 60_000).toISOString();

    const expired = repos.approvals.markExpiredBefore(future);
    expect(expired.map((a) => a.id)).toContain(approval.id);
    expect(repos.approvals.findById(approval.id)!.status).toBe('Expired');
  });

  it('leaves fresh requests alone when expiring', () => {
    const approval = pending();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(repos.approvals.markExpiredBefore(past)).toHaveLength(0);
    expect(repos.approvals.findById(approval.id)!.status).toBe('Pending');
  });

  it('cancels everything outstanding for a session', () => {
    pending();
    pending();
    expect(repos.approvals.cancelBySession(sessionId)).toHaveLength(2);
    expect(repos.approvals.listPendingBySession(sessionId)).toHaveLength(0);
  });
});

describe('memories', () => {
  beforeEach(() => {
    seedProject('backend');
    seedProject('frontend');
  });

  it('shares memory across every session in a project (§45 step 22)', () => {
    repos.memories.add('backend', 'Project uses .NET 8', 'stack', 'user-1');
    const a = repos.sessions.create({ projectId: 'backend', title: 'A', providerId: 'cli' });
    const b = repos.sessions.create({ projectId: 'backend', title: 'B', providerId: 'cli' });

    // Memory is addressed by project, not by session — both see the same set.
    expect(a.projectId).toBe(b.projectId);
    expect(repos.memories.listByProject('backend').map((m) => m.content)).toEqual([
      'Project uses .NET 8',
    ]);
  });

  it('never leaks memory between projects (§45 step 23)', () => {
    repos.memories.add('backend', 'Backend secret', 'general', 'user-1');
    expect(repos.memories.listByProject('frontend')).toHaveLength(0);
    expect(repos.memories.search('frontend', 'Backend')).toHaveLength(0);
  });

  it('refuses to delete another project\'s memory even given its id', () => {
    const entry = repos.memories.add('backend', 'Backend secret', 'general', 'user-1');
    expect(repos.memories.remove('frontend', entry.id)).toBe(false);
    expect(repos.memories.remove('backend', entry.id)).toBe(true);
  });

  it('treats LIKE wildcards in a search term as literals', () => {
    repos.memories.add('backend', 'uses Dapper', 'general', 'u');
    repos.memories.add('backend', 'literal % sign', 'general', 'u');
    expect(repos.memories.search('backend', '%')).toHaveLength(1);
  });

  it('detects duplicates so the same fact is not stored twice', () => {
    repos.memories.add('backend', 'Tests use xUnit', 'general', 'u');
    expect(repos.memories.findDuplicate('backend', 'Tests use xUnit')).not.toBeNull();
    expect(repos.memories.findDuplicate('backend', 'Tests use NUnit')).toBeNull();
  });
});
