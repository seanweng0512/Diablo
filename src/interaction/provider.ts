import type { ApprovalDecision, ApprovalRequest, ApprovalStatus } from '../approval/models.js';
import type { ConversationRef, SessionStatus } from '../core/types.js';

/**
 * The Agent Core's only channel to a human (spec §7).
 *
 * Nothing in here mentions Discord. The Core depends on this interface alone, so
 * Discord can be absent (§6.2), replaced, or joined by other front ends without
 * the Core changing.
 */

export interface OutboundMessage {
  /** `agent` is Copilot speaking; `progress` and `system` are the Bridge. */
  readonly kind: 'agent' | 'progress' | 'system';
  readonly text: string;
  /**
   * When set, long content should be delivered as a file with this name rather
   * than truncated into the channel (§28).
   */
  readonly attachmentName?: string;
}

export interface ApprovalPrompt {
  readonly approval: ApprovalRequest;
  readonly projectName: string;
  readonly sessionTitle: string;
  /**
   * Whether to offer ACP's "always allow". Off unless the project opts in,
   * because it removes future actions from the approval path entirely.
   */
  readonly offerAlwaysAllow: boolean;
  /** Absolute deadline after which the request expires (§41). */
  readonly expiresAt: string;
}

export interface MemoryApprovalPrompt {
  readonly requestId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly sessionTitle: string;
  readonly content: string;
  readonly category: string;
}

/** How an approval ended, for updating the already-rendered UI (§24). */
export interface ApprovalResolution {
  readonly status: ApprovalStatus;
  readonly decision: ApprovalDecision | null;
  /** Display name or id of whoever resolved it, for the audit line. */
  readonly resolvedBy: string | null;
}

export interface StatusReport {
  readonly status: SessionStatus;
  readonly projectName: string;
  readonly sessionTitle: string;
  readonly currentAction: string | null;
  readonly pendingApprovals: number;
  readonly contextUsed?: number | undefined;
  readonly contextSize?: number | undefined;
}

export interface CompletionReport {
  readonly sessionTitle: string;
  readonly summary: string;
  readonly toolCallCount: number;
  readonly succeeded: boolean;
}

export interface ErrorReport {
  readonly title: string;
  readonly reason: string;
  readonly sessionTitle: string;
  readonly recoverable: boolean;
}

export interface IInteractionProvider {
  readonly id: string;

  /**
   * Whether the provider can currently reach a human.
   *
   * The Approval Manager checks this, and an unavailable provider is never
   * treated as consent — the session parks in WaitingForApproval instead (§26).
   */
  readonly isAvailable: boolean;

  sendMessage(target: ConversationRef, message: OutboundMessage): Promise<void>;

  /**
   * Renders an approval request. Returns once shown, *not* once answered:
   * the answer arrives when the provider calls back into the Approval Manager.
   *
   * Splitting it this way is what lets an approval outlive a Discord
   * disconnect, a Bridge restart, or a `/approve` typed instead of clicked.
   */
  requestApproval(target: ConversationRef, prompt: ApprovalPrompt): Promise<void>;

  /** Updates a rendered approval once resolved, disabling its controls (§24). */
  updateApproval(
    target: ConversationRef,
    prompt: ApprovalPrompt,
    resolution: ApprovalResolution,
  ): Promise<void>;

  /** Memory approval is a separate flow from action approval (§20). */
  requestMemoryApproval(target: ConversationRef, prompt: MemoryApprovalPrompt): Promise<void>;

  notifyStatus(target: ConversationRef, report: StatusReport): Promise<void>;
  notifyCompletion(target: ConversationRef, report: CompletionReport): Promise<void>;
  notifyError(target: ConversationRef, report: ErrorReport): Promise<void>;

  /** Optional free-text question. Providers that cannot ask return null. */
  requestInput?(target: ConversationRef, question: string): Promise<string | null>;

  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** Looks up providers by id and reports whether any human is reachable at all. */
export class InteractionRegistry {
  private readonly providers = new Map<string, IInteractionProvider>();

  register(provider: IInteractionProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): IInteractionProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** The provider for a session, but only if it can actually reach someone. */
  available(id: string): IInteractionProvider | null {
    const provider = this.providers.get(id);
    return provider && provider.isAvailable ? provider : null;
  }

  list(): IInteractionProvider[] {
    return [...this.providers.values()];
  }

  async startAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.start?.();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((p) => p.stop?.()));
  }
}
