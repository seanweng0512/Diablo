import readline from 'node:readline';

import type { ProjectConfig } from '../config/types.js';
import {
  formatMemoryList,
  formatProjectInfo,
  formatStatus,
  type BridgeCommands,
} from '../core/commands.js';
import type { AgentOrchestrator } from '../core/orchestrator.js';
import type { ConversationRef } from '../core/types.js';
import type { Logger } from '../util/logger.js';
import type {
  ApprovalPrompt,
  ApprovalResolution,
  CompletionReport,
  ErrorReport,
  IInteractionProvider,
  MemoryApprovalPrompt,
  OutboundMessage,
  StatusReport,
} from './provider.js';
import type { MemoryManager } from '../memory/manager.js';

export const CLI_PROVIDER_ID = 'cli';

/**
 * A terminal front end (spec §7).
 *
 * Its real job is to prove the architecture: the Agent Core, approvals, and
 * project memory all work with Discord entirely absent (§6.2, core principle 8).
 * It also makes the Bridge usable on a machine with no bot token.
 */
export class CliInteractionProvider implements IInteractionProvider {
  readonly id = CLI_PROVIDER_ID;
  private rl: readline.Interface | null = null;
  private sessionId: string | null = null;
  /** Approvals awaiting a keystroke, newest first. */
  private readonly openApprovals: ApprovalPrompt[] = [];
  private readonly openMemory: MemoryApprovalPrompt[] = [];

  constructor(
    private readonly project: ProjectConfig,
    private readonly orchestrator: AgentOrchestrator,
    private readonly commands: BridgeCommands,
    private readonly memory: MemoryManager,
    private readonly logger: Logger,
  ) {}

  /** stdout is always there; the CLI can always reach the operator. */
  get isAvailable(): boolean {
    return true;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.print(
      [
        `Diablo Agent Bridge — CLI provider`,
        `Project: ${this.project.name} (${this.project.path})`,
        ``,
        `Type a task to send it to Copilot. Commands:`,
        `  /status  /cancel  /reset  /project`,
        `  /memory [add <fact> | remove <id> | search <term>]`,
        `  /approve [id]  /reject [id]   (or just  a  /  r  for the newest)`,
        `  /quit`,
      ].join('\n'),
    );
    this.prompt();

    this.rl.on('line', (line) => {
      void this.onLine(line.trim()).catch((error) => this.logger.error('CLI command failed', error));
    });
    this.rl.on('close', () => {
      process.emit('SIGINT');
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async sendMessage(_target: ConversationRef, message: OutboundMessage): Promise<void> {
    const prefix = message.kind === 'agent' ? '\n🤖 ' : '\n';
    this.print(prefix + message.text);
  }

  async requestApproval(_target: ConversationRef, prompt: ApprovalPrompt): Promise<void> {
    this.openApprovals.unshift(prompt);
    const { approval } = prompt;
    const risk = approval.riskLevel === 'high' ? '🚨 HIGH RISK' : '⚠️';

    this.print(
      [
        ``,
        `${risk} Copilot wants approval`,
        `  action:  ${approval.actionType}`,
        approval.command ? `  command: ${approval.command}` : `  target:  ${approval.target ?? '(none)'}`,
        approval.riskReason ? `  why:     ${approval.riskReason}` : '',
        `  id:      ${approval.id.slice(0, 8)}`,
        ``,
        `  Approve with  a  (or /approve), reject with  r  (or /reject).`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  async updateApproval(
    _target: ConversationRef,
    prompt: ApprovalPrompt,
    resolution: ApprovalResolution,
  ): Promise<void> {
    const index = this.openApprovals.findIndex((p) => p.approval.id === prompt.approval.id);
    if (index >= 0) this.openApprovals.splice(index, 1);

    const icon =
      resolution.status === 'Approved' ? '✅' : resolution.status === 'Rejected' ? '❌' : '⏱️';
    this.print(
      `${icon} ${resolution.status}${resolution.resolvedBy ? ` by ${resolution.resolvedBy}` : ''}: ` +
        `${prompt.approval.command ?? prompt.approval.description}`,
    );

    if (resolution.status === 'Expired') {
      this.print('   (expired — nothing was approved; approve, reject or /cancel to move on)');
    }
  }

  async requestMemoryApproval(
    _target: ConversationRef,
    prompt: MemoryApprovalPrompt,
  ): Promise<void> {
    this.openMemory.unshift(prompt);
    this.print(
      [
        ``,
        `🧠 Copilot wants to remember something about ${prompt.projectName}:`,
        `   "${prompt.content}"   [${prompt.category}]`,
        ``,
        `   Save it with  m  , decline with  n  .`,
      ].join('\n'),
    );
  }

  async notifyStatus(_target: ConversationRef, report: StatusReport): Promise<void> {
    this.print(formatStatus(report));
  }

  async notifyCompletion(_target: ConversationRef, report: CompletionReport): Promise<void> {
    const icon = report.succeeded ? '🎉' : '⚠️';
    this.print(`\n${icon} ${report.summary} (${report.toolCallCount} action(s))`);
  }

  async notifyError(_target: ConversationRef, report: ErrorReport): Promise<void> {
    this.print(`\n❌ ${report.title}\n   ${report.reason}`);
  }

  async requestInput(_target: ConversationRef, question: string): Promise<string | null> {
    if (!this.rl) return null;
    const rl = this.rl;
    return new Promise((resolve) => rl.question(`\n❓ ${question}\n> `, (answer) => resolve(answer)));
  }

  // -------------------------------------------------------------------------

  private async onLine(line: string): Promise<void> {
    if (!line) {
      this.prompt();
      return;
    }

    const [head, ...rest] = line.split(/\s+/);
    const argument = rest.join(' ');
    const command = (head ?? '').toLowerCase();

    switch (command) {
      case '/quit':
      case '/exit':
        await this.stop();
        process.emit('SIGINT');
        return;

      case 'a':
      case '/approve':
        await this.decide('approve', argument);
        break;

      case 'r':
      case '/reject':
        await this.decide('reject', argument);
        break;

      case 'm':
        this.resolveMemory(true);
        break;

      case 'n':
        this.resolveMemory(false);
        break;

      case '/status': {
        const report = this.sessionId ? this.commands.status(this.sessionId) : null;
        this.print(report ? formatStatus(report) : 'No session yet — send a task first.');
        break;
      }

      case '/cancel': {
        const result = await this.commands.cancel(this.sessionId);
        this.print(result.message);
        break;
      }

      case '/reset': {
        const result = await this.commands.reset(this.sessionId);
        if (result.ok) this.sessionId = null;
        this.print(result.message);
        break;
      }

      case '/project':
        this.print(formatProjectInfo(this.commands.projectInfo(this.project)));
        break;

      case '/memory':
        this.print(this.handleMemory(argument));
        break;

      default:
        if (command.startsWith('/')) {
          this.print(`Unknown command ${command}.`);
          break;
        }
        await this.sendToCopilot(line);
        return; // sendToCopilot re-prompts once the turn is under way
    }

    this.prompt();
  }

  private handleMemory(argument: string): string {
    const [sub, ...rest] = argument.split(/\s+/);
    const value = rest.join(' ');

    switch ((sub ?? '').toLowerCase()) {
      case '':
        return formatMemoryList(this.commands.memoryList(this.project.id), this.project.name);
      case 'add':
        return this.commands.memoryAdd(this.project, value, 'cli').message;
      case 'remove':
      case 'rm':
        return this.commands.memoryRemove(this.project, value).message;
      case 'search':
        return formatMemoryList(
          this.commands.memorySearch(this.project.id, value),
          `${this.project.name} — matching "${value}"`,
        );
      default:
        return 'Usage: /memory [add <fact> | remove <id> | search <term>]';
    }
  }

  private async decide(decision: 'approve' | 'reject', argument: string): Promise<void> {
    const result = await this.commands.decide(
      this.sessionId,
      this.project.id,
      decision,
      'cli',
      argument || undefined,
    );
    this.print(result.message);
  }

  private resolveMemory(approved: boolean): void {
    const prompt = this.openMemory.shift();
    if (!prompt) {
      this.print('Nothing waiting to be remembered.');
      return;
    }
    this.memory.resolveMemoryRequest(prompt.requestId, approved, 'cli');
    this.print(approved ? '🧠 Saved to project memory.' : 'Declined; not saved.');
  }

  private async sendToCopilot(text: string): Promise<void> {
    try {
      const session = await this.orchestrator.handleUserMessage({
        project: this.project,
        providerId: this.id,
        text,
        author: 'cli',
      });
      this.sessionId = session.id;
      this.print(`\n… sent to Copilot (session ${session.id.slice(0, 8)})`);
    } catch (error) {
      this.print(`\n❌ ${(error as Error).message}`);
    }
    this.prompt();
  }

  private print(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  private prompt(): void {
    process.stdout.write('> ');
  }
}
