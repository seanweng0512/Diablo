import type { ApprovalManager } from '../approval/manager.js';
import type { ApprovalDecision } from '../approval/models.js';
import type { BridgeConfig, ProjectConfig } from '../config/types.js';
import type { CopilotSessionHandlers } from '../copilot/acp-session.js';
import { CopilotStartupError } from '../copilot/acp-session.js';
import type { CopilotEvent, CopilotExitInfo } from '../copilot/events.js';
import { CopilotCapacityError, type CopilotProcessManager } from '../copilot/process-manager.js';
import type { IInteractionProvider, InteractionRegistry, StatusReport } from '../interaction/provider.js';
import type { MemoryManager } from '../memory/manager.js';
import type { MemoryMcpServer } from '../memory/mcp-server.js';
import type { MessageRepository } from '../storage/repositories.js';
import type { Logger } from '../util/logger.js';
import type { EventBus } from './events.js';
import type { ProjectManager } from './project-manager.js';
import { SessionReporter } from './reporter.js';
import type { SessionManager } from './session-manager.js';
import type { ConversationRef, Session } from './types.js';

export interface OrchestratorOptions {
  readonly config: BridgeConfig;
  readonly projects: ProjectManager;
  readonly sessions: SessionManager;
  readonly processes: CopilotProcessManager;
  readonly approvals: ApprovalManager;
  readonly memory: MemoryManager;
  readonly memoryMcp: MemoryMcpServer | null;
  readonly messages: MessageRepository;
  readonly registry: InteractionRegistry;
  readonly bus: EventBus;
  readonly logger: Logger;
}

export interface IncomingMessage {
  readonly project: ProjectConfig;
  readonly providerId: string;
  readonly text: string;
  /** Display name or id of the sender, for the audit trail. */
  readonly author: string;
  /** Title for a newly created session, e.g. the Discord thread name. */
  readonly title?: string;
  readonly discordGuildId?: string | null;
  readonly discordChannelId?: string | null;
  readonly discordThreadId?: string | null;
}

interface RuntimeState {
  readonly reporter: SessionReporter;
  /** Whether the project memory preamble has been sent on this ACP session. */
  memoryInjected: boolean;
  turnInFlight: boolean;
  /** Set when the Copilot process exits, so a failed turn can explain why. */
  lastExit: CopilotExitInfo | null;
}

/**
 * The Agent Core (spec §3, §46).
 *
 * Note what this file does *not* import: nothing from `../discord/`. Every path
 * out to a human goes through {@link InteractionRegistry}, which is what makes
 * "the Agent Core must not depend on Discord" (core principle 8) checkable
 * rather than aspirational — Discord could be deleted and this still compiles.
 */
export class AgentOrchestrator {
  private readonly runtime = new Map<string, RuntimeState>();
  /** Set by {@link shutdown}, so unwinding turns stop touching storage. */
  private disposed = false;

  constructor(private readonly options: OrchestratorOptions) {}

  /**
   * Routes an inbound user message to a session, creating one if needed
   * (§12, §13).
   *
   * Returns as soon as the turn is under way. The turn itself runs detached,
   * because a Copilot task can take minutes and a Discord gateway handler must
   * not be held open that long; progress arrives through the reporter.
   */
  async handleUserMessage(input: IncomingMessage): Promise<Session> {
    const session = this.resolveSession(input);

    this.options.messages.append(session.id, 'user', input.text);
    this.options.bus.emit('UserMessageReceived', {
      sessionId: session.id,
      projectId: session.projectId,
      text: input.text,
      author: input.author,
    });

    void this.runTurn(session, input.project, input.text).catch((error) => {
      this.options.logger.error(`turn failed for session ${session.id}`, error);
    });

    return session;
  }

  /** §32 — terminate Copilot and settle any outstanding approvals. */
  async cancelSession(sessionId: string, reason = 'cancelled by user'): Promise<boolean> {
    const session = this.options.sessions.findById(sessionId);
    if (!session) return false;

    // Answer Copilot's blocked permission request first, or the process will
    // sit waiting for a reply that is never coming.
    await this.options.approvals.cancelSession(sessionId, reason);
    await this.options.processes.cancel(sessionId);
    await this.options.processes.stop(sessionId);

    this.options.sessions.setStatus(sessionId, 'Cancelled');
    this.options.bus.emit('SessionCancelled', { sessionId, reason });

    const state = this.runtime.get(sessionId);
    if (state) {
      await state.reporter.flush();
      state.reporter.dispose();
      this.runtime.delete(sessionId);
    }
    this.options.memoryMcp?.revoke(sessionId);
    return true;
  }

  /**
   * §33 — retire a session and free its thread so the next message starts fresh.
   *
   * Project Memory is untouched: it belongs to the project, not the session.
   */
  async resetSession(sessionId: string): Promise<boolean> {
    const session = this.options.sessions.findById(sessionId);
    if (!session) return false;

    await this.options.approvals.cancelSession(sessionId, 'session reset');
    await this.options.processes.stop(sessionId);

    this.options.sessions.setStatus(sessionId, 'Completed');
    // The unique index means the old row must let go of the thread before a
    // replacement can claim it.
    this.options.sessions.detachThread(sessionId);
    this.options.bus.emit('SessionReset', { oldSessionId: sessionId, newSessionId: null });

    const state = this.runtime.get(sessionId);
    if (state) {
      state.reporter.dispose();
      this.runtime.delete(sessionId);
    }
    this.options.memoryMcp?.revoke(sessionId);
    return true;
  }

  /** §31 — assembles a status report without touching any provider directly. */
  statusFor(sessionId: string): StatusReport | null {
    const session = this.options.sessions.findById(sessionId);
    if (!session) return null;
    const project = this.options.projects.get(session.projectId);
    const state = this.runtime.get(sessionId);

    return {
      status: session.status,
      projectName: project?.name ?? session.projectId,
      sessionTitle: session.title,
      currentAction: state?.reporter.action ?? null,
      pendingApprovals: this.options.approvals.pendingCount(sessionId),
    };
  }

  /** Used by the memory MCP server to map a token's session to its project. */
  resolveSessionForMemory(sessionId: string): { session: Session; project: ProjectConfig } | null {
    const session = this.options.sessions.findById(sessionId);
    if (!session) return null;
    const project = this.options.projects.get(session.projectId);
    if (!project) return null;
    return { session, project };
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    scope: { expectProjectId?: string; expectSessionId?: string } = {},
  ) {
    return this.options.approvals.resolve(approvalId, decision, resolvedBy, scope);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    for (const state of this.runtime.values()) {
      await state.reporter.flush().catch(() => undefined);
      state.reporter.dispose();
    }
    this.runtime.clear();
    this.options.approvals.dispose();
    this.options.memory.dispose();
    await this.options.processes.stopAll();
  }

  // -------------------------------------------------------------------------

  private resolveSession(input: IncomingMessage): Session {
    if (input.discordThreadId) {
      const existing = this.options.sessions.findActiveByThread(input.discordThreadId);
      if (existing) return existing;

      // A thread whose previous session was retired: release the stale claim so
      // the new session can take the thread id.
      const stale = this.options.sessions.findAnyByThread(input.discordThreadId);
      if (stale) this.options.sessions.detachThread(stale.id);
    }

    return this.options.sessions.create({
      project: input.project,
      providerId: input.providerId,
      title: input.title ?? deriveTitle(input.text),
      discordGuildId: input.discordGuildId ?? null,
      discordChannelId: input.discordChannelId ?? null,
      discordThreadId: input.discordThreadId ?? null,
    });
  }

  private refFor(session: Session): ConversationRef {
    return {
      providerId: session.providerId,
      sessionId: session.id,
      projectId: session.projectId,
      guildId: session.discordGuildId,
      channelId: session.discordChannelId,
      threadId: session.discordThreadId,
    };
  }

  private stateFor(session: Session): RuntimeState {
    const existing = this.runtime.get(session.id);
    if (existing) return existing;

    const state: RuntimeState = {
      reporter: new SessionReporter({
        ref: this.refFor(session),
        output: this.options.config.output,
        logger: this.options.logger.child('report'),
        getProvider: () => this.options.registry.available(session.providerId),
      }),
      memoryInjected: false,
      turnInFlight: false,
      lastExit: null,
    };
    this.runtime.set(session.id, state);
    return state;
  }

  private async runTurn(session: Session, project: ProjectConfig, text: string): Promise<void> {
    const state = this.stateFor(session);
    const provider = () => this.options.registry.available(session.providerId);

    try {
      this.options.projects.assertUsable(project);
    } catch (error) {
      await this.failSession(session, (error as Error).message, provider());
      return;
    }

    let copilotStarted = false;
    try {
      const acp = await this.options.processes.ensure({
        bridgeSessionId: session.id,
        project,
        handlers: this.handlersFor(session, project),
        mcpServers: this.mcpServersFor(session, project),
      });
      copilotStarted = true;
      this.options.sessions.bindCopilot(session.id, acp.copilotSessionId, acp.pid);
    } catch (error) {
      const message =
        error instanceof CopilotCapacityError || error instanceof CopilotStartupError
          ? error.message
          : `could not start Copilot: ${(error as Error).message}`;
      await this.failSession(session, message, provider());
      return;
    }

    this.options.sessions.setStatus(session.id, 'Running');
    this.options.processes.markBusy(session.id, true);
    state.turnInFlight = true;

    // Project memory rides in ahead of the first prompt of this ACP session
    // (§17). Later turns need no preamble: Copilot still has it in context.
    let prompt = text;
    if (!state.memoryInjected) {
      state.memoryInjected = true;
      const preamble = this.options.memory.preambleFor(project);
      if (preamble) prompt = `${preamble}\n\n---\n\n${text}`;
    }

    try {
      const result = await this.options.processes.prompt(session.id, prompt);
      await state.reporter.flush();
      state.reporter.clearAction();

      this.options.bus.emit('CopilotCompleted', {
        sessionId: session.id,
        stopReason: result.stopReason,
      });

      if (result.stopReason === 'cancelled') {
        this.options.logger.info(`turn cancelled for session ${session.id}`);
      } else {
        // Deliberately not moving the session to Completed. §11 makes Completed
        // terminal, but §13 requires a follow-up message in the same thread to
        // reach the same session with its context intact. Turn completion is
        // reported here; the session record stays live until /reset, /cancel or
        // a failure retires it.
        const active = this.options.registry.available(session.providerId);
        await active?.notifyCompletion(this.refFor(session), {
          sessionTitle: session.title,
          summary: describeStopReason(result.stopReason),
          toolCallCount: state.reporter.toolCallCount,
          succeeded: result.stopReason === 'end_turn',
        });
      }
    } catch (error) {
      await state.reporter.flush();

      // A dead process shows up here as a closed transport, which tells the user
      // nothing. Give the exit event a moment to land so the report can name the
      // exit code and stderr instead (§39).
      const exit = await this.awaitExitInfo(state);
      const reason = exit
        ? describeExit(exit)
        : `Copilot turn failed: ${(error as Error).message}`;
      await this.failSession(session, reason, provider());
    } finally {
      state.turnInFlight = false;
      this.options.processes.markBusy(session.id, false);

      // Shutdown can land while a turn is still unwinding, and the database may
      // already be closed by the time we get here. Skip the bookkeeping rather
      // than throwing out of a `finally`.
      if (copilotStarted && !this.disposed) {
        try {
          const acp = this.options.processes.get(session.id);
          this.options.sessions.bindCopilot(
            session.id,
            acp?.copilotSessionId ?? null,
            acp?.pid ?? null,
          );
        } catch (error) {
          this.options.logger.debug('could not update Copilot binding after turn', error);
        }
      }
    }
  }

  /**
   * Briefly waits for an unexpected-exit notification.
   *
   * The prompt rejection and the process `exit` event are two independent
   * signals for the same underlying event and can arrive in either order; this
   * closes that window without making the happy path wait.
   */
  private async awaitExitInfo(state: RuntimeState, timeoutMs = 500): Promise<CopilotExitInfo | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.lastExit) return state.lastExit.expected ? null : state.lastExit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  private mcpServersFor(session: Session, project: ProjectConfig) {
    if (!project.memoryEnabled || !this.options.memoryMcp) return [];
    const descriptor = this.options.memoryMcp.descriptorFor(session.id);
    return descriptor ? [descriptor] : [];
  }

  private handlersFor(session: Session, project: ProjectConfig): CopilotSessionHandlers {
    const sessionId = session.id;

    return {
      onEvent: (event) => this.onCopilotEvent(sessionId, event),

      onPermissionRequest: async (request) => {
        // Re-read the session so the approval carries its current title/status.
        const current = this.options.sessions.findById(sessionId) ?? session;
        this.options.bus.emit('CopilotActionRequested', {
          sessionId,
          call: {
            toolCallId: request.toolCallId ?? '',
            title: request.title,
            toolKind: request.toolKind ?? 'other',
            status: 'pending',
            command: request.command,
            paths: request.paths,
            rawInput: request.rawInput,
          },
        });
        return this.options.approvals.requestPermission({ session: current, project, request });
      },

      onExit: (info) => {
        this.options.memoryMcp?.revoke(sessionId);

        const state = this.runtime.get(sessionId);
        if (state) state.lastExit = info;
        if (info.expected) return;

        this.options.logger.error(`session ${sessionId}: ${describeExit(info)}`);

        // If a turn is running, its own failure path reports this — and does so
        // with better context than we have here. Reporting from both would
        // either duplicate the message or, worse, let the vaguer "connection
        // closed" wording win the race.
        if (state?.turnInFlight) return;

        const failed = this.options.sessions.findById(sessionId);
        if (failed) {
          void this.failSession(
            failed,
            describeExit(info),
            this.options.registry.available(failed.providerId),
          ).catch(() => undefined);
        }
      },
    };
  }

  private onCopilotEvent(sessionId: string, event: CopilotEvent): void {
    const state = this.runtime.get(sessionId);
    if (!state) return;

    switch (event.kind) {
      case 'message':
        state.reporter.appendAgentText(event.text);
        this.options.messages.append(sessionId, 'agent', event.text);
        this.options.bus.emit('CopilotMessageReceived', { sessionId, text: event.text });
        break;

      case 'thought':
        state.reporter.appendThought(event.text);
        this.options.bus.emit('CopilotThoughtReceived', { sessionId, text: event.text });
        break;

      case 'tool-started':
        state.reporter.toolStarted(event.call);
        this.options.messages.append(sessionId, 'tool', renderToolForLog(event.call.title, event.call.command));
        break;

      case 'tool-updated':
        if (event.status === 'failed') {
          state.reporter.toolFailed(event.title ?? 'Action', event.output);
        }
        if (event.status === 'completed' || event.status === 'failed') {
          this.options.bus.emit('CopilotActionCompleted', {
            sessionId,
            toolCallId: event.toolCallId,
            status: event.status,
            output: event.output,
          });
        }
        break;

      case 'title': {
        // Copilot names the session; keep ours in step so /status reads well.
        this.options.sessions.rename(sessionId, event.title);
        break;
      }

      case 'echo':
      case 'plan':
      case 'usage':
      case 'mode-changed':
      case 'ignored':
        // Not surfaced: §29 warns against spamming, and none of these change
        // what the user needs to know.
        break;

      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  private async failSession(
    session: Session,
    reason: string,
    provider: IInteractionProvider | null,
  ): Promise<void> {
    // Shutting down kills every Copilot process, which rejects any in-flight
    // prompt and lands here — by which point storage and the providers are gone.
    // A shutdown is not a session failure, so record it and stop.
    if (this.disposed) {
      this.options.logger.debug(`ignoring failure during shutdown for ${session.id}: ${reason}`);
      return;
    }

    this.options.sessions.setStatus(session.id, 'Failed');
    this.options.bus.emit('CopilotFailed', { sessionId: session.id, reason });

    // Do not leave Copilot blocked on an approval for a session that is over.
    await this.options.approvals.cancelSession(session.id, 'session failed');

    try {
      await provider?.notifyError(this.refFor(session), {
        title: 'Copilot failed',
        reason,
        sessionTitle: session.title,
        recoverable: true,
      });
    } catch (error) {
      this.options.logger.warn('failed to report session failure', error);
    }
  }
}

function describeExit(info: CopilotExitInfo): string {
  return (
    `Copilot process exited unexpectedly (code=${info.code}, signal=${info.signal}).` +
    (info.stderrTail ? `\n\`\`\`\n${info.stderrTail.slice(-800)}\n\`\`\`` : '')
  );
}

function describeStopReason(stopReason: string): string {
  switch (stopReason) {
    case 'end_turn':
      return 'Task complete.';
    case 'max_tokens':
      return 'Stopped: the context window filled up.';
    case 'max_turn_requests':
      return 'Stopped: too many tool calls in one turn.';
    case 'refusal':
      return 'Copilot declined to continue.';
    case 'cancelled':
      return 'Cancelled.';
    default:
      return `Stopped (${stopReason}).`;
  }
}

function renderToolForLog(title: string, command: string | null): string {
  return command ? `${title}: ${command}` : title;
}

/** Derives a session title from the first message, for providers without threads. */
function deriveTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? 'Session';
  const trimmed = firstLine.trim();
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 59)}…`;
}
