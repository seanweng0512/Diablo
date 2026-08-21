import type { McpServer } from '@agentclientprotocol/sdk';

import type { CopilotLaunchConfig, ProjectConfig, SessionsConfig } from '../config/types.js';
import type { Logger } from '../util/logger.js';
import { CopilotAcpSession, buildCopilotArgs, type CopilotSessionHandlers } from './acp-session.js';
import { resolveExecutable } from './executable.js';
import type { PromptResult } from './events.js';

/** Raised when a project already has as many live Copilot processes as it may. */
export class CopilotCapacityError extends Error {
  constructor(readonly projectId: string, readonly limit: number) {
    super(
      `project \`${projectId}\` already has ${limit} Copilot session(s) running, ` +
        `which is its configured maximum. Finish or /cancel one first.`,
    );
    this.name = 'CopilotCapacityError';
  }
}

interface ManagedSession {
  readonly bridgeSessionId: string;
  readonly projectId: string;
  readonly acp: CopilotAcpSession;
  lastActivityAt: number;
  /** Serializes turns: ACP allows one prompt in flight per session. */
  queue: Promise<unknown>;
}

export interface EnsureSessionRequest {
  readonly bridgeSessionId: string;
  readonly project: ProjectConfig;
  readonly handlers: CopilotSessionHandlers;
  readonly mcpServers?: readonly McpServer[];
  /** ACP session id to resume rather than open fresh. */
  readonly resumeSessionId?: string | undefined;
}

/**
 * Owns the lifetime of every Copilot process (§15).
 *
 * One process per Bridge session, lazily started, reaped when idle, and capped
 * per project so that a busy Discord channel cannot exhaust the machine.
 */
/** Builds the argument vector for a Copilot launch. Injectable for testing. */
export type CopilotArgsBuilder = (options: {
  readonly extraArgs: readonly string[];
  readonly model: string | undefined;
}) => string[];

export class CopilotProcessManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private reaper: NodeJS.Timeout | null = null;
  private readonly resolvedExecutable: string;
  private readonly argsBuilder: CopilotArgsBuilder;

  constructor(
    private readonly copilotConfig: CopilotLaunchConfig,
    private readonly sessionsConfig: SessionsConfig,
    private readonly logger: Logger,
    /**
     * Overrides how the command line is assembled. The default targets the real
     * Copilot CLI; tests substitute a builder that launches a fake ACP agent, so
     * the whole stack can be exercised without a Copilot login or AI credits.
     */
    argsBuilder: CopilotArgsBuilder = buildCopilotArgs,
  ) {
    this.argsBuilder = argsBuilder;
    this.resolvedExecutable = resolveExecutable(copilotConfig.executable);
    if (this.resolvedExecutable === copilotConfig.executable) {
      this.logger.debug(
        `could not resolve \`${copilotConfig.executable}\` on PATH; will let spawn report it`,
      );
    }
  }

  /** Starts a Copilot process for a session, or returns the running one. */
  async ensure(request: EnsureSessionRequest): Promise<CopilotAcpSession> {
    const existing = this.sessions.get(request.bridgeSessionId);
    if (existing && existing.acp.isAlive) {
      existing.lastActivityAt = Date.now();
      return existing.acp;
    }
    if (existing) {
      // Dead process still in the map — clear it before replacing.
      this.sessions.delete(request.bridgeSessionId);
    }

    this.reapIdle();

    const live = this.countActive(request.project.id);
    if (live >= this.sessionsConfig.maxConcurrentPerProject) {
      throw new CopilotCapacityError(request.project.id, this.sessionsConfig.maxConcurrentPerProject);
    }

    const acp = new CopilotAcpSession({
      executable: this.resolvedExecutable,
      args: this.argsBuilder({
        extraArgs: this.copilotConfig.args,
        model: request.project.copilot.model,
      }),
      cwd: request.project.path,
      env: this.copilotConfig.env,
      startupTimeoutMs: this.copilotConfig.startupTimeoutMs,
      additionalDirectories: request.project.copilot.additionalDirectories,
      mcpServers: request.mcpServers ?? [],
      resumeSessionId: request.resumeSessionId,
      logger: this.logger.child(request.bridgeSessionId.slice(0, 8)),
      handlers: request.handlers,
    });

    const managed: ManagedSession = {
      bridgeSessionId: request.bridgeSessionId,
      projectId: request.project.id,
      acp,
      lastActivityAt: Date.now(),
      queue: Promise.resolve(),
    };
    this.sessions.set(request.bridgeSessionId, managed);

    try {
      await acp.start();
    } catch (error) {
      this.sessions.delete(request.bridgeSessionId);
      throw error;
    }

    // Drop the entry once the process is gone, so capacity frees up even when
    // Copilot dies on its own.
    void acp.closed.then(() => {
      const current = this.sessions.get(request.bridgeSessionId);
      if (current && current.acp === acp) this.sessions.delete(request.bridgeSessionId);
    });

    return acp;
  }

  get(bridgeSessionId: string): CopilotAcpSession | null {
    const managed = this.sessions.get(bridgeSessionId);
    return managed && managed.acp.isAlive ? managed.acp : null;
  }

  has(bridgeSessionId: string): boolean {
    return this.get(bridgeSessionId) !== null;
  }

  /**
   * Sends a prompt, serialized per session.
   *
   * Two Discord messages arriving in the same thread within a second must not
   * become two concurrent `session/prompt` calls — ACP has one turn in flight
   * per session, and interleaving them would scramble the conversation.
   */
  async prompt(bridgeSessionId: string, text: string): Promise<PromptResult> {
    const managed = this.sessions.get(bridgeSessionId);
    if (!managed || !managed.acp.isAlive) {
      throw new Error(`no live Copilot session for ${bridgeSessionId}`);
    }

    const run = managed.queue.then(
      () => managed.acp.prompt(text),
      () => managed.acp.prompt(text), // a previous turn's failure must not block this one
    );
    // Keep the chain alive regardless of outcome.
    managed.queue = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      managed.lastActivityAt = Date.now();
    }
  }

  async cancel(bridgeSessionId: string): Promise<void> {
    const managed = this.sessions.get(bridgeSessionId);
    if (!managed) return;
    await managed.acp.cancel();
    managed.lastActivityAt = Date.now();
  }

  async stop(bridgeSessionId: string): Promise<void> {
    const managed = this.sessions.get(bridgeSessionId);
    if (!managed) return;
    this.sessions.delete(bridgeSessionId);
    await managed.acp.dispose();
  }

  async stopAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((managed) => managed.acp.dispose()));
  }

  countActive(projectId?: string): number {
    let count = 0;
    for (const managed of this.sessions.values()) {
      if (!managed.acp.isAlive) continue;
      if (projectId === undefined || managed.projectId === projectId) count += 1;
    }
    return count;
  }

  listActiveSessionIds(): string[] {
    return [...this.sessions.values()].filter((m) => m.acp.isAlive).map((m) => m.bridgeSessionId);
  }

  /** Begins periodic reaping of idle processes. */
  startReaper(): void {
    if (this.reaper || this.sessionsConfig.idleTimeoutMs <= 0) return;
    const interval = Math.max(30_000, Math.floor(this.sessionsConfig.idleTimeoutMs / 4));
    this.reaper = setInterval(() => this.reapIdle(), interval);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (!this.reaper) return;
    clearInterval(this.reaper);
    this.reaper = null;
  }

  /**
   * Disposes processes idle beyond the timeout.
   *
   * Only truly idle ones: a session parked in WaitingForApproval is *blocked*,
   * not idle, and killing it would discard work the user is about to approve.
   * The caller signals that by leaving `busy` sessions out of reaping via
   * {@link markBusy}.
   */
  reapIdle(): void {
    const timeout = this.sessionsConfig.idleTimeoutMs;
    if (timeout <= 0) return;

    const cutoff = Date.now() - timeout;
    for (const managed of [...this.sessions.values()]) {
      if (this.busy.has(managed.bridgeSessionId)) continue;
      if (managed.lastActivityAt > cutoff) continue;

      this.logger.info(
        `reaping idle Copilot process for session ${managed.bridgeSessionId} (pid ${managed.acp.pid})`,
      );
      this.sessions.delete(managed.bridgeSessionId);
      void managed.acp.dispose().catch((error) => this.logger.warn('reap failed', error));
    }
  }

  private readonly busy = new Set<string>();

  /** Protects a session from idle reaping while it is mid-turn or awaiting approval. */
  markBusy(bridgeSessionId: string, busy: boolean): void {
    if (busy) this.busy.add(bridgeSessionId);
    else this.busy.delete(bridgeSessionId);
    const managed = this.sessions.get(bridgeSessionId);
    if (managed) managed.lastActivityAt = Date.now();
  }
}
