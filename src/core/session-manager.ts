import type { ProjectConfig } from '../config/types.js';
import type { SessionRepository } from '../storage/repositories.js';
import type { Logger } from '../util/logger.js';
import type { EventBus } from './events.js';
import { isActiveStatus, type Session, type SessionStatus } from './types.js';

/**
 * Legal state transitions (spec §11).
 *
 * Terminal states are absorbing: once a session is Completed, Failed or
 * Cancelled it can never come back, which is what stops a late ACP event from
 * resurrecting a session the user already cancelled.
 */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  Created: ['Running', 'Failed', 'Cancelled'],
  Running: ['WaitingForApproval', 'Completed', 'Failed', 'Cancelled'],
  WaitingForApproval: ['Running', 'Completed', 'Failed', 'Cancelled'],
  Completed: [],
  Failed: [],
  Cancelled: [],
};

export interface CreateSessionRequest {
  readonly project: ProjectConfig;
  readonly providerId: string;
  readonly title: string;
  readonly discordGuildId?: string | null;
  readonly discordChannelId?: string | null;
  readonly discordThreadId?: string | null;
}

/** Owns session identity and lifecycle (§9, §10, §11). */
export class SessionManager {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  create(request: CreateSessionRequest): Session {
    const session = this.sessions.create({
      projectId: request.project.id,
      title: request.title,
      providerId: request.providerId,
      discordGuildId: request.discordGuildId ?? null,
      discordChannelId: request.discordChannelId ?? null,
      discordThreadId: request.discordThreadId ?? null,
    });
    this.logger.info(`created session ${session.id} for project ${session.projectId} (${session.title})`);
    this.bus.emit('SessionCreated', { session });
    return session;
  }

  findById(sessionId: string): Session | null {
    return this.sessions.findById(sessionId);
  }

  /** §13 — resolves a thread to its live session; the user never supplies an id. */
  findActiveByThread(threadId: string): Session | null {
    return this.sessions.findActiveByThreadId(threadId);
  }

  findAnyByThread(threadId: string): Session | null {
    return this.sessions.findByThreadId(threadId);
  }

  listActive(): Session[] {
    return this.sessions.listActive();
  }

  listByProject(projectId: string): Session[] {
    return this.sessions.listByProject(projectId);
  }

  countActive(projectId: string): number {
    return this.sessions.countActiveByProject(projectId);
  }

  /**
   * Moves a session to a new state, enforcing §11.
   *
   * Returns false for an illegal transition rather than throwing: this is called
   * from the ACP read path, and an unexpected ordering of events must degrade to
   * a logged anomaly, not a crashed bridge.
   */
  setStatus(sessionId: string, to: SessionStatus): boolean {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      this.logger.warn(`cannot set status of unknown session ${sessionId}`);
      return false;
    }
    if (session.status === to) return true;

    const allowed = TRANSITIONS[session.status];
    if (!allowed.includes(to)) {
      this.logger.warn(
        `ignoring illegal session transition ${session.status} -> ${to} for ${sessionId}`,
      );
      return false;
    }

    this.sessions.updateStatus(sessionId, to);
    this.bus.emit('SessionStatusChanged', { sessionId, from: session.status, to });
    return true;
  }

  bindCopilot(sessionId: string, copilotSessionId: string | null, pid: number | null): void {
    this.sessions.updateCopilotBinding(sessionId, copilotSessionId, pid);
    if (copilotSessionId) {
      this.bus.emit('CopilotStarted', { sessionId, copilotSessionId, pid });
    }
  }

  rename(sessionId: string, title: string): void {
    this.sessions.updateTitle(sessionId, title);
  }

  /** Frees a session's thread id so a replacement can claim it (§33). */
  detachThread(sessionId: string): void {
    this.sessions.detachThread(sessionId);
  }

  isActive(session: Session): boolean {
    return isActiveStatus(session.status);
  }

  /**
   * Marks sessions left behind by a previous run as Failed.
   *
   * Copilot processes are children of the Bridge, so nothing survives a
   * restart; reporting these as Failed is honest, whereas leaving them Running
   * would make /status lie (§39).
   */
  failOrphaned(): number {
    const count = this.sessions.failOrphanedSessions();
    if (count > 0) this.logger.warn(`marked ${count} orphaned session(s) from a previous run as Failed`);
    return count;
  }
}
