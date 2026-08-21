/** Approval domain model (spec §21–§27). */

export const APPROVAL_STATUSES = ['Pending', 'Approved', 'Rejected', 'Expired', 'Cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * How dangerous an action looks.
 *
 * ACP treats `git status` and `git push --force` as the same kind of permission
 * request, so the Bridge classifies them itself in order to satisfy §27's
 * requirement that destructive operations get *explicit* approval.
 */
export const RISK_LEVELS = ['low', 'medium', 'high', 'blocked'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Coarse categories mirroring the examples in §21. */
export type ActionType =
  | 'execute_command'
  | 'file_edit'
  | 'file_delete'
  | 'file_read'
  | 'git_operation'
  | 'package_install'
  | 'network'
  | 'memory_write'
  | 'mcp_tool'
  | 'other';

/** What the user chose. `approve_always` is only reachable when a project opts in. */
export type ApprovalDecision = 'approve' | 'approve_always' | 'reject';

export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly actionType: ActionType;
  /** Short human-readable summary, e.g. "Run tests". */
  readonly description: string;
  /** The literal command, when the action is a shell invocation. */
  readonly command: string | null;
  /** The file or resource acted upon, when applicable. */
  readonly target: string | null;
  readonly riskLevel: RiskLevel;
  /** Why the classifier assigned this risk level; shown to the user for high risk. */
  readonly riskReason: string | null;
  /** ACP `toolCallId`, so the request can be tied back to Copilot's tool call. */
  readonly toolCallId: string | null;
  status: ApprovalStatus;
  readonly requestedAt: string;
  resolvedAt: string | null;
  /** Identity of the approver (e.g. a Discord user id), for the audit trail (§25). */
  resolvedBy: string | null;
}

export function isResolved(status: ApprovalStatus): boolean {
  return status !== 'Pending';
}
