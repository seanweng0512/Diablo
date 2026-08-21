import { randomUUID } from 'node:crypto';

import type { ProjectConfig } from '../config/types.js';
import type { EventBus } from '../core/events.js';
import type { ConversationRef, MemoryEntry, Session } from '../core/types.js';
import type { InteractionRegistry } from '../interaction/provider.js';
import type { MemoryRepository } from '../storage/repositories.js';
import { createDeferred, type Deferred } from '../util/deferred.js';
import type { Logger } from '../util/logger.js';

export interface MemoryManagerOptions {
  readonly memories: MemoryRepository;
  readonly registry: InteractionRegistry;
  readonly bus: EventBus;
  readonly approvalTimeoutMs: number;
  readonly logger: Logger;
}

export interface PersistOutcome {
  readonly approved: boolean;
  /** Text handed back to Copilot as the tool result. */
  readonly message: string;
}

interface PendingMemory {
  readonly requestId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly category: string;
  readonly deferred: Deferred<PersistOutcome>;
  readonly ref: ConversationRef;
  timer: NodeJS.Timeout | null;
}

const MAX_MEMORY_CHARS = 1_000;
const MAX_PREAMBLE_ENTRIES = 80;

/**
 * Project Memory (spec §17–§20).
 *
 * Memory belongs to a Project, not a thread, so every session in a project sees
 * the same set and no session can see another project's (§45 steps 22–23). It
 * lives in SQLite and is injected into Copilot as a prompt preamble; the Bridge
 * deliberately never writes it into the user's repository, because a tool that
 * silently edits `AGENTS.md` in a working tree it does not own is a surprise
 * nobody asked for.
 */
export class MemoryManager {
  private readonly pending = new Map<string, PendingMemory>();

  constructor(private readonly options: MemoryManagerOptions) {}

  list(projectId: string): MemoryEntry[] {
    return this.options.memories.listByProject(projectId);
  }

  search(projectId: string, query: string): MemoryEntry[] {
    return this.options.memories.search(projectId, query);
  }

  /** Adds a fact directly — used by `/memory add`, where the human *is* the approval. */
  addDirect(projectId: string, content: string, category: string, by: string): MemoryEntry | null {
    const normalized = normalizeContent(content);
    if (!normalized) return null;
    if (this.options.memories.findDuplicate(projectId, normalized)) return null;
    const entry = this.options.memories.add(projectId, normalized, normalizeCategory(category), by);
    this.options.bus.emit('MemoryApproved', { entry, approvedBy: by });
    return entry;
  }

  remove(projectId: string, id: string): boolean {
    return this.options.memories.remove(projectId, id);
  }

  /**
   * Builds the preamble injected ahead of a session's first prompt.
   *
   * Returns null when the project has memory disabled or nothing stored, so the
   * caller sends the user's message untouched.
   */
  preambleFor(project: ProjectConfig): string | null {
    if (!project.memoryEnabled) return null;
    const entries = this.options.memories.listByProject(project.id, MAX_PREAMBLE_ENTRIES);
    if (entries.length === 0) return null;

    const lines = entries.map((entry) => `- ${entry.content}`);
    return (
      `Project memory for "${project.name}" — durable facts established in earlier sessions. ` +
      `Treat these as authoritative context about this codebase:\n${lines.join('\n')}`
    );
  }

  /**
   * Asks the user whether to persist a new fact (§20).
   *
   * Called from the memory MCP tool, so the returned message becomes Copilot's
   * tool result and it learns whether the fact was kept.
   */
  async requestPersist(context: {
    session: Session;
    project: ProjectConfig;
    content: string;
    category: string;
  }): Promise<PersistOutcome> {
    const { session, project } = context;
    const content = normalizeContent(context.content);

    if (!content) {
      return { approved: false, message: 'Nothing to remember: the fact was empty.' };
    }
    if (!project.memoryEnabled) {
      return {
        approved: false,
        message: `Project memory is disabled for "${project.name}", so nothing was saved.`,
      };
    }
    if (content.length > MAX_MEMORY_CHARS) {
      return {
        approved: false,
        message: `That fact is ${content.length} characters; keep durable memory under ${MAX_MEMORY_CHARS}.`,
      };
    }
    if (this.options.memories.findDuplicate(project.id, content)) {
      return { approved: true, message: 'Already in project memory; nothing to do.' };
    }

    const category = normalizeCategory(context.category);
    const requestId = randomUUID();
    const ref: ConversationRef = {
      providerId: session.providerId,
      sessionId: session.id,
      projectId: project.id,
      guildId: session.discordGuildId,
      channelId: session.discordChannelId,
      threadId: session.discordThreadId,
    };

    const entry: PendingMemory = {
      requestId,
      projectId: project.id,
      sessionId: session.id,
      content,
      category,
      deferred: createDeferred<PersistOutcome>(),
      ref,
      timer: null,
    };
    this.pending.set(requestId, entry);

    this.options.bus.emit('MemoryRequested', {
      requestId,
      projectId: project.id,
      sessionId: session.id,
      content,
    });

    const provider = this.options.registry.available(session.providerId);
    if (!provider) {
      this.pending.delete(requestId);
      this.options.logger.warn(
        `memory request from session ${session.id} could not be shown (no provider available); not saving`,
      );
      return {
        approved: false,
        message: 'Could not ask the user for approval right now, so the fact was not saved.',
      };
    }

    try {
      await provider.requestMemoryApproval(ref, {
        requestId,
        projectId: project.id,
        projectName: project.name,
        sessionTitle: session.title,
        content,
        category,
      });
    } catch (error) {
      this.pending.delete(requestId);
      this.options.logger.warn('failed to render memory approval', error);
      return { approved: false, message: 'Could not show the approval prompt; the fact was not saved.' };
    }

    // Unlike an action approval, a memory request that nobody answers resolves
    // as "not saved" rather than blocking forever. Refusing to persist a note is
    // safe; leaving Copilot wedged mid-task over one is not.
    entry.timer = setTimeout(() => {
      const stale = this.pending.get(requestId);
      if (!stale) return;
      this.pending.delete(requestId);
      this.options.logger.info(`memory request ${requestId} expired without an answer; not saved`);
      stale.deferred.resolve({
        approved: false,
        message: 'The approval request timed out, so the fact was not saved to project memory.',
      });
    }, this.options.approvalTimeoutMs);
    entry.timer.unref();

    return entry.deferred.promise;
  }

  /** Called by an interaction provider when the user answers a memory prompt. */
  resolveMemoryRequest(requestId: string, approved: boolean, by: string): MemoryEntry | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;

    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);

    if (!approved) {
      this.options.bus.emit('MemoryRejected', {
        requestId,
        projectId: entry.projectId,
        content: entry.content,
        rejectedBy: by,
      });
      entry.deferred.resolve({
        approved: false,
        message: 'The user declined to save that to project memory.',
      });
      return null;
    }

    const saved = this.options.memories.add(entry.projectId, entry.content, entry.category, by);
    this.options.bus.emit('MemoryApproved', { entry: saved, approvedBy: by });
    entry.deferred.resolve({ approved: true, message: 'Saved to project memory.' });
    return saved;
  }

  getPending(requestId: string): { projectId: string; sessionId: string; content: string } | null {
    const entry = this.pending.get(requestId);
    return entry
      ? { projectId: entry.projectId, sessionId: entry.sessionId, content: entry.content }
      : null;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.deferred.resolve({ approved: false, message: 'The Bridge shut down before saving.' });
    }
    this.pending.clear();
  }
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function normalizeCategory(category: string): string {
  const cleaned = category.replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  return cleaned.length > 0 ? cleaned : 'general';
}
