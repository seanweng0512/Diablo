import type { ApprovalManager } from '../approval/manager.js';
import type { ProjectConfig } from '../config/types.js';
import type { CopilotProcessManager } from '../copilot/process-manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { StatusReport } from '../interaction/provider.js';
import type { MemoryEntry } from './types.js';
import type { AgentOrchestrator } from './orchestrator.js';
import type { ProjectManager } from './project-manager.js';
import type { SessionManager } from './session-manager.js';

export interface CommandResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly discordEnabled: boolean;
  readonly memoryEnabled: boolean;
  readonly requireApproval: boolean;
  readonly memoryCount: number;
  readonly activeSessions: number;
  readonly liveCopilotProcesses: number;
}

/**
 * The behaviour behind the slash commands of §30–§35, shared by every
 * interaction provider.
 *
 * Providers render; this decides. Keeping it here means `/memory` cannot mean
 * one thing in Discord and another on the CLI, and a future Slack provider gets
 * the same semantics for free.
 */
export class BridgeCommands {
  constructor(
    private readonly deps: {
      readonly orchestrator: AgentOrchestrator;
      readonly projects: ProjectManager;
      readonly sessions: SessionManager;
      readonly memory: MemoryManager;
      readonly approvals: ApprovalManager;
      readonly processes: CopilotProcessManager;
    },
  ) {}

  /** §31 */
  status(sessionId: string): StatusReport | null {
    return this.deps.orchestrator.statusFor(sessionId);
  }

  /** §32 */
  async cancel(sessionId: string | null): Promise<CommandResult> {
    if (!sessionId) {
      return { ok: false, message: 'No active session here — nothing to cancel.' };
    }
    const session = this.deps.sessions.findById(sessionId);
    if (!session) return { ok: false, message: 'That session no longer exists.' };
    if (!this.deps.sessions.isActive(session)) {
      return { ok: false, message: `Session is already ${session.status}; nothing to cancel.` };
    }
    await this.deps.orchestrator.cancelSession(sessionId, 'cancelled via /cancel');
    return { ok: true, message: '🛑 Session cancelled and Copilot stopped.' };
  }

  /** §33 — the replacement session is created lazily by the next message. */
  async reset(sessionId: string | null): Promise<CommandResult> {
    if (!sessionId) {
      return { ok: false, message: 'No active session here — nothing to reset.' };
    }
    const ok = await this.deps.orchestrator.resetSession(sessionId);
    if (!ok) return { ok: false, message: 'That session no longer exists.' };
    return {
      ok: true,
      message:
        '🔄 Session reset. Copilot has been stopped and its conversation cleared.\n' +
        'Your next message starts a fresh session. Project memory was left intact.',
    };
  }

  /** §34 */
  memoryList(projectId: string): MemoryEntry[] {
    return this.deps.memory.list(projectId);
  }

  memorySearch(projectId: string, query: string): MemoryEntry[] {
    return this.deps.memory.search(projectId, query);
  }

  memoryAdd(project: ProjectConfig, content: string, by: string): CommandResult {
    if (!project.memoryEnabled) {
      return { ok: false, message: `Memory is disabled for project \`${project.id}\`.` };
    }
    if (!content.trim()) {
      return { ok: false, message: 'Give me something to remember, e.g. `/memory add Tests use xUnit`.' };
    }
    const entry = this.deps.memory.addDirect(project.id, content, 'general', by);
    if (!entry) {
      return { ok: false, message: 'That is already in project memory (or was empty).' };
    }
    return { ok: true, message: `🧠 Remembered: ${entry.content}` };
  }

  memoryRemove(project: ProjectConfig, id: string): CommandResult {
    // Scoped by project id, so an id from another project simply is not found.
    const removed = this.deps.memory.remove(project.id, id);
    return removed
      ? { ok: true, message: '🗑️ Removed from project memory.' }
      : { ok: false, message: 'No memory with that id in this project.' };
  }

  /** §35 */
  projectInfo(project: ProjectConfig): ProjectInfo {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      discordEnabled: project.discordEnabled,
      memoryEnabled: project.memoryEnabled,
      requireApproval: project.security.requireApproval,
      memoryCount: this.deps.memory.list(project.id).length,
      activeSessions: this.deps.sessions.countActive(project.id),
      liveCopilotProcesses: this.deps.processes.countActive(project.id),
    };
  }

  /** Backs the optional `/approve` and `/reject` of §30. */
  async decide(
    sessionId: string | null,
    projectId: string,
    decision: 'approve' | 'reject',
    by: string,
    approvalId?: string,
  ): Promise<CommandResult> {
    const pending = this.deps.approvals.listPending(sessionId ?? undefined);
    if (pending.length === 0) {
      return { ok: false, message: 'There is nothing waiting for approval here.' };
    }

    const target = approvalId
      ? pending.find((a) => a.id === approvalId || a.id.startsWith(approvalId))
      : pending[0];

    if (!target) {
      return { ok: false, message: `No pending approval matching \`${approvalId}\`.` };
    }

    const result = await this.deps.orchestrator.resolveApproval(target.id, decision, by, {
      expectProjectId: projectId,
      ...(sessionId ? { expectSessionId: sessionId } : {}),
    });

    if (result.ok) {
      const verb = decision === 'approve' ? 'Approved' : 'Rejected';
      return { ok: true, message: `${verb}: ${target.command ?? target.description}` };
    }

    switch (result.reason) {
      case 'already-resolved':
        return { ok: false, message: 'That approval was already resolved.' };
      case 'wrong-scope':
        return { ok: false, message: 'That approval belongs to a different project or session.' };
      case 'no-option':
        return { ok: false, message: 'Copilot offered no matching option; cannot answer safely.' };
      default:
        return { ok: false, message: 'No such approval.' };
    }
  }
}

/** Renders memory entries as a readable list, with ids short enough to retype. */
export function formatMemoryList(entries: readonly MemoryEntry[], projectName: string): string {
  if (entries.length === 0) {
    return `🧠 No project memory stored for **${projectName}** yet.`;
  }
  const lines = entries.map((entry) => `\`${entry.id.slice(0, 8)}\` [${entry.category}] ${entry.content}`);
  return `🧠 **${projectName}** — project memory (${entries.length}):\n${lines.join('\n')}`;
}

export function formatProjectInfo(info: ProjectInfo): string {
  return [
    `**Project:** ${info.name} (\`${info.id}\`)`,
    `**Path:** \`${info.path}\``,
    `**Discord:** ${info.discordEnabled ? 'Enabled' : 'Disabled'}`,
    `**Memory:** ${info.memoryEnabled ? `Enabled (${info.memoryCount} entries)` : 'Disabled'}`,
    `**Approval required:** ${info.requireApproval ? 'Yes' : 'No — auto-approving'}`,
    `**Active sessions:** ${info.activeSessions} (${info.liveCopilotProcesses} Copilot process(es) live)`,
  ].join('\n');
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    '🤖 **Agent Status**',
    '',
    `**Project:** ${report.projectName}`,
    `**Session:** ${report.sessionTitle}`,
    '',
    `**Status:** ${report.status}`,
    `**Current action:** ${report.currentAction ?? 'idle — waiting for your next message'}`,
  ];
  if (report.pendingApprovals > 0) {
    lines.push(`**Awaiting approval:** ${report.pendingApprovals} request(s)`);
  }
  return lines.join('\n');
}
