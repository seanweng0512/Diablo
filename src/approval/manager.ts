import type { ProjectConfig } from '../config/types.js';
import type { CopilotPermissionRequest, CopilotPermissionResponse } from '../copilot/events.js';
import type { ConversationRef, Session, SessionStatus } from '../core/types.js';
import type { ApprovalPrompt, IInteractionProvider, InteractionRegistry } from '../interaction/provider.js';
import type { ApprovalRepository } from '../storage/repositories.js';
import { createDeferred, type Deferred } from '../util/deferred.js';
import type { Logger } from '../util/logger.js';
import type { ApprovalDecision, ApprovalRequest } from './models.js';
import { assessRisk } from './risk.js';

/** Emitted so the Session Manager can move a session in and out of WaitingForApproval. */
export interface ApprovalStatusSink {
  setSessionStatus(sessionId: string, status: SessionStatus): void;
}

export interface ApprovalManagerOptions {
  readonly approvals: ApprovalRepository;
  readonly registry: InteractionRegistry;
  readonly statusSink: ApprovalStatusSink;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

interface PendingApproval {
  approval: ApprovalRequest;
  readonly request: CopilotPermissionRequest;
  readonly deferred: Deferred<CopilotPermissionResponse>;
  readonly ref: ConversationRef;
  prompt: ApprovalPrompt;
  timer: NodeJS.Timeout | null;
}

export interface RequestPermissionContext {
  readonly session: Session;
  readonly project: ProjectConfig;
  readonly request: CopilotPermissionRequest;
}

export interface ResolveOptions {
  /** Rejects the resolution unless the approval belongs to this project (§25). */
  readonly expectProjectId?: string;
  /** Rejects the resolution unless the approval belongs to this session (§25). */
  readonly expectSessionId?: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly approval: ApprovalRequest }
  | { readonly ok: false; readonly reason: 'not-found' | 'already-resolved' | 'wrong-scope' | 'no-option' };

/**
 * The single rendezvous point between Copilot and a human (§21–§26).
 *
 * Copilot's `session/request_permission` is a blocking JSON-RPC request, so the
 * promise this class returns *is* the thing holding Copilot still. That is what
 * makes §26 structural rather than aspirational: there is no code path from
 * "action requested" to "action performed" that does not pass through a resolved
 * promise, and the only things that resolve it are an explicit human decision, a
 * project policy decision, or an explicit cancellation.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: ApprovalManagerOptions) {}

  /** Handles one permission request, blocking until it is decided. */
  async requestPermission(context: RequestPermissionContext): Promise<CopilotPermissionResponse> {
    const { session, project, request } = context;
    const { logger } = this.options;
    const assessment = assessRisk(request, project);

    // A project's deny list is policy, not a question. Reject without asking.
    if (assessment.riskLevel === 'blocked') {
      const approval = this.options.approvals.create({
        sessionId: session.id,
        projectId: project.id,
        actionType: assessment.actionType,
        description: request.title,
        command: request.command,
        target: request.paths[0] ?? null,
        riskLevel: 'blocked',
        riskReason: assessment.reason,
        toolCallId: request.toolCallId,
      });
      this.options.approvals.resolve(approval.id, 'Rejected', 'bridge-policy');
      logger.warn(`blocked by policy: ${request.command ?? request.title} — ${assessment.reason}`);

      await this.notifyBlocked(session, project, request, assessment.reason);
      return this.rejectResponse(request);
    }

    // Explicitly configured sandbox mode. The config loader warns about this at
    // startup; it is never the default and never inferred.
    if (!project.security.requireApproval) {
      const approval = this.options.approvals.create({
        sessionId: session.id,
        projectId: project.id,
        actionType: assessment.actionType,
        description: request.title,
        command: request.command,
        target: request.paths[0] ?? null,
        riskLevel: assessment.riskLevel,
        riskReason: assessment.reason,
        toolCallId: request.toolCallId,
      });
      this.options.approvals.resolve(approval.id, 'Approved', 'auto:require_approval=false');
      logger.info(`auto-approved (require_approval=false): ${request.command ?? request.title}`);
      return this.approveResponse(request, 'approve');
    }

    const approval = this.options.approvals.create({
      sessionId: session.id,
      projectId: project.id,
      actionType: assessment.actionType,
      description: request.title,
      command: request.command,
      target: request.paths[0] ?? null,
      riskLevel: assessment.riskLevel,
      riskReason: assessment.reason,
      toolCallId: request.toolCallId,
    });

    const ref: ConversationRef = {
      providerId: session.providerId,
      sessionId: session.id,
      projectId: project.id,
      guildId: session.discordGuildId,
      channelId: session.discordChannelId,
      threadId: session.discordThreadId,
    };

    const prompt: ApprovalPrompt = {
      approval,
      projectName: project.name,
      sessionTitle: session.title,
      offerAlwaysAllow:
        project.security.allowAlways && request.options.some((o) => o.kind === 'allow_always'),
      expiresAt: new Date(Date.now() + this.options.timeoutMs).toISOString(),
    };

    const entry: PendingApproval = {
      approval,
      request,
      deferred: createDeferred<CopilotPermissionResponse>(),
      ref,
      prompt,
      timer: null,
    };
    this.pending.set(approval.id, entry);

    this.options.statusSink.setSessionStatus(session.id, 'WaitingForApproval');

    const provider = this.options.registry.available(session.providerId);
    if (!provider) {
      // §26 — mandatory. No interaction provider is NOT consent. The session
      // parks here and the promise stays unresolved, so Copilot stays blocked
      // until a human cancels or the provider comes back and /approve is used.
      logger.error(
        `Agent is waiting for approval, but no interaction provider is available ` +
          `(provider=${session.providerId}, session=${session.id}, action=${request.command ?? request.title}). ` +
          `The action will NOT be approved automatically.`,
      );
    } else {
      try {
        await provider.requestApproval(ref, prompt);
      } catch (error) {
        // Failing to render must not silently approve either.
        logger.error('failed to render approval request; leaving it pending', error);
      }
    }

    entry.timer = setTimeout(() => this.expire(approval.id), this.options.timeoutMs);
    entry.timer.unref();

    return entry.deferred.promise;
  }

  /**
   * Records a human decision and unblocks Copilot.
   *
   * Called by interaction providers. Authorization is the provider's
   * responsibility — it is the layer that knows who the user is — but the scope
   * checks here ensure an approval can only ever be resolved from within the
   * project and session it belongs to (§25).
   */
  async resolve(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: string,
    options: ResolveOptions = {},
  ): Promise<ResolveResult> {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      const stored = this.options.approvals.findById(approvalId);
      return { ok: false, reason: stored ? 'already-resolved' : 'not-found' };
    }

    if (options.expectProjectId && entry.approval.projectId !== options.expectProjectId) {
      return { ok: false, reason: 'wrong-scope' };
    }
    if (options.expectSessionId && entry.approval.sessionId !== options.expectSessionId) {
      return { ok: false, reason: 'wrong-scope' };
    }

    const optionId = this.optionIdFor(entry.request, decision);
    if (!optionId) {
      this.options.logger.error(
        `Copilot offered no option matching decision \`${decision}\`; cannot answer safely`,
        entry.request.options,
      );
      return { ok: false, reason: 'no-option' };
    }

    const status = decision === 'reject' ? 'Rejected' : 'Approved';
    if (!this.options.approvals.resolve(approvalId, status, resolvedBy)) {
      return { ok: false, reason: 'already-resolved' };
    }

    this.finish(entry, { type: 'selected', optionId });

    // Copilot is moving again; leave WaitingForApproval unless something else in
    // this session is still blocked.
    if (this.pendingCount(entry.approval.sessionId) === 0) {
      this.options.statusSink.setSessionStatus(entry.approval.sessionId, 'Running');
    }

    const resolved = this.options.approvals.findById(approvalId) ?? entry.approval;
    entry.approval = resolved;
    await this.updateRenderedApproval(entry, { status, decision, resolvedBy });

    this.options.logger.info(
      `approval ${approvalId} ${status.toLowerCase()} by ${resolvedBy}: ${entry.request.command ?? entry.request.title}`,
    );
    return { ok: true, approval: resolved };
  }

  /**
   * Cancels every outstanding approval for a session.
   *
   * ACP requires that a cancelled turn's in-flight permission request be
   * answered with `cancelled`, so this is what stops `/cancel` from leaving
   * Copilot blocked forever.
   */
  async cancelSession(sessionId: string, reason = 'session cancelled'): Promise<number> {
    const entries = [...this.pending.values()].filter((e) => e.approval.sessionId === sessionId);
    for (const entry of entries) {
      this.options.approvals.resolve(entry.approval.id, 'Cancelled', reason);
      this.finish(entry, { type: 'cancelled' });
      await this.updateRenderedApproval(entry, {
        status: 'Cancelled',
        decision: null,
        resolvedBy: reason,
      });
    }
    // Also sweep rows this process is not tracking (e.g. after a restart).
    this.options.approvals.cancelBySession(sessionId);
    return entries.length;
  }

  listPending(sessionId?: string): ApprovalRequest[] {
    const all = [...this.pending.values()].map((e) => e.approval);
    return sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
  }

  pendingCount(sessionId: string): number {
    return this.listPending(sessionId).length;
  }

  /** Drops in-memory state without answering, for shutdown. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------

  /**
   * Marks an approval Expired.
   *
   * Deliberately does not resolve the deferred: §41 requires that expiry never
   * approve, and answering `cancelled` would abort work the user may still want.
   * The session stays in WaitingForApproval until someone approves, rejects, or
   * cancels it.
   */
  private expire(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;

    if (!this.options.approvals.resolve(approvalId, 'Expired', null, ['Pending'])) return;

    const expired = this.options.approvals.findById(approvalId);
    if (expired) entry.approval = expired;

    this.options.logger.warn(
      `approval ${approvalId} expired after ${this.options.timeoutMs}ms and was NOT approved; ` +
        `session ${entry.approval.sessionId} remains WaitingForApproval`,
    );

    void this.updateRenderedApproval(entry, { status: 'Expired', decision: null, resolvedBy: null });
  }

  private finish(entry: PendingApproval, response: CopilotPermissionResponse): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.pending.delete(entry.approval.id);
    entry.deferred.resolve(response);
  }

  private async updateRenderedApproval(
    entry: PendingApproval,
    resolution: Parameters<IInteractionProvider['updateApproval']>[2],
  ): Promise<void> {
    const provider = this.options.registry.available(entry.ref.providerId);
    if (!provider) return;
    const prompt: ApprovalPrompt = { ...entry.prompt, approval: entry.approval };
    try {
      await provider.updateApproval(entry.ref, prompt, resolution);
    } catch (error) {
      this.options.logger.warn('failed to update rendered approval', error);
    }
  }

  private async notifyBlocked(
    session: Session,
    project: ProjectConfig,
    request: CopilotPermissionRequest,
    reason: string | null,
  ): Promise<void> {
    const provider = this.options.registry.available(session.providerId);
    if (!provider) return;
    const ref: ConversationRef = {
      providerId: session.providerId,
      sessionId: session.id,
      projectId: project.id,
      guildId: session.discordGuildId,
      channelId: session.discordChannelId,
      threadId: session.discordThreadId,
    };
    try {
      await provider.sendMessage(ref, {
        kind: 'system',
        text:
          `⛔ Blocked by project policy — not asking for approval.\n` +
          `\`\`\`\n${request.command ?? request.title}\n\`\`\`\n` +
          (reason ? `Reason: ${reason}` : ''),
      });
    } catch (error) {
      this.options.logger.warn('failed to report blocked action', error);
    }
  }

  private optionIdFor(request: CopilotPermissionRequest, decision: ApprovalDecision): string | null {
    const byKind = (kind: string): string | null =>
      request.options.find((option) => option.kind === kind)?.optionId ?? null;

    switch (decision) {
      case 'approve':
        return byKind('allow_once') ?? byKind('allow_always');
      case 'approve_always':
        return byKind('allow_always') ?? byKind('allow_once');
      case 'reject':
        return byKind('reject_once') ?? byKind('reject_always');
      default:
        return null;
    }
  }

  private approveResponse(
    request: CopilotPermissionRequest,
    decision: ApprovalDecision,
  ): CopilotPermissionResponse {
    const optionId = this.optionIdFor(request, decision);
    return optionId ? { type: 'selected', optionId } : { type: 'cancelled' };
  }

  private rejectResponse(request: CopilotPermissionRequest): CopilotPermissionResponse {
    const optionId = this.optionIdFor(request, 'reject');
    return optionId ? { type: 'selected', optionId } : { type: 'cancelled' };
  }
}
