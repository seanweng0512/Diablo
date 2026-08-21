import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ApprovalManager } from '../src/approval/manager';
import type { ApprovalDecision } from '../src/approval/models';
import type { BridgeConfig, ProjectConfig } from '../src/config/types';
import { BridgeCommands } from '../src/core/commands';
import { EventBus } from '../src/core/events';
import { AgentOrchestrator } from '../src/core/orchestrator';
import { ProjectManager } from '../src/core/project-manager';
import { SessionManager } from '../src/core/session-manager';
import type { ConversationRef } from '../src/core/types';
import { CopilotProcessManager } from '../src/copilot/process-manager';
import type {
  ApprovalPrompt,
  ApprovalResolution,
  CompletionReport,
  ErrorReport,
  IInteractionProvider,
  MemoryApprovalPrompt,
  OutboundMessage,
  StatusReport,
} from '../src/interaction/provider';
import { InteractionRegistry } from '../src/interaction/provider';
import { MemoryManager } from '../src/memory/manager';
import { MemoryMcpServer } from '../src/memory/mcp-server';
import { openDatabase } from '../src/storage/db';
import { createRepositories } from '../src/storage/repositories';
import { createLogger } from '../src/util/logger';

export const FAKE_AGENT = path.resolve(import.meta.dirname, 'fake-acp-agent.mjs');
export const REAL_DIR = path.resolve(import.meta.dirname, '..');

/** Records everything shown to the user, and answers approvals on cue. */
export class FakeProvider implements IInteractionProvider {
  readonly id = 'fake';
  isAvailable = true;

  readonly messages: OutboundMessage[] = [];
  readonly approvals: ApprovalPrompt[] = [];
  readonly resolutions: ApprovalResolution[] = [];
  readonly memoryPrompts: MemoryApprovalPrompt[] = [];
  readonly completions: CompletionReport[] = [];
  readonly errors: ErrorReport[] = [];
  readonly statuses: StatusReport[] = [];

  /** Set to auto-answer each approval as it arrives. */
  autoDecision: ApprovalDecision | null = null;
  private manager: ApprovalManager | null = null;

  attach(manager: ApprovalManager): void {
    this.manager = manager;
  }

  get text(): string {
    return this.messages.map((m) => m.text).join('\n');
  }

  async sendMessage(_t: ConversationRef, message: OutboundMessage): Promise<void> {
    this.messages.push(message);
  }

  async requestApproval(_t: ConversationRef, prompt: ApprovalPrompt): Promise<void> {
    this.approvals.push(prompt);
    if (this.autoDecision && this.manager) {
      const decision = this.autoDecision;
      const manager = this.manager;
      // Resolve out of band, mirroring a user clicking a moment later.
      setTimeout(() => void manager.resolve(prompt.approval.id, decision, 'fake-user'), 5);
    }
  }

  async updateApproval(
    _t: ConversationRef,
    _p: ApprovalPrompt,
    resolution: ApprovalResolution,
  ): Promise<void> {
    this.resolutions.push(resolution);
  }

  async requestMemoryApproval(_t: ConversationRef, prompt: MemoryApprovalPrompt): Promise<void> {
    this.memoryPrompts.push(prompt);
  }

  async notifyStatus(_t: ConversationRef, report: StatusReport): Promise<void> {
    this.statuses.push(report);
  }

  async notifyCompletion(_t: ConversationRef, report: CompletionReport): Promise<void> {
    this.completions.push(report);
  }

  async notifyError(_t: ConversationRef, report: ErrorReport): Promise<void> {
    this.errors.push(report);
  }
}

export function makeProject(overrides: Partial<ProjectConfig> & { id: string }): ProjectConfig {
  return {
    name: overrides.id,
    path: REAL_DIR,
    discordEnabled: false,
    memoryEnabled: true,
    ...overrides,
    security: {
      requireApproval: true,
      allowedUsers: new Set<string>(),
      allowedRoles: new Set<string>(),
      allowAlways: false,
      denyPatterns: [],
      ...overrides.security,
    },
    copilot: {
      mode: 'agent',
      additionalDirectories: [],
      ...overrides.copilot,
    },
  } as ProjectConfig;
}

export interface HarnessOptions {
  readonly projects: readonly ProjectConfig[];
  /** Scenario JSON handed to the fake ACP agent. */
  readonly scenario?: unknown;
  readonly approvalTimeoutMs?: number;
  readonly maxConcurrentPerProject?: number;
  readonly showThoughts?: boolean;
  readonly startMemoryMcp?: boolean;
}

export interface Harness {
  readonly db: DatabaseSync;
  readonly config: BridgeConfig;
  readonly bus: EventBus;
  readonly registry: InteractionRegistry;
  readonly provider: FakeProvider;
  readonly projects: ProjectManager;
  readonly sessions: SessionManager;
  readonly processes: CopilotProcessManager;
  readonly approvals: ApprovalManager;
  readonly memory: MemoryManager;
  readonly memoryMcp: MemoryMcpServer | null;
  readonly orchestrator: AgentOrchestrator;
  readonly commands: BridgeCommands;
  readonly events: Array<{ name: string; payload: unknown }>;
  dispose(): Promise<void>;
}

/**
 * Builds the whole Bridge around a fake ACP agent and a recording provider.
 *
 * Every layer is the real one except the two ends: Copilot is replaced by a
 * scripted agent, and Discord by a recorder. That keeps the approval path, the
 * session lifecycle and the isolation guarantees under test without a network,
 * a bot token, or AI credits.
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const logger = createLogger('test');

  const config: BridgeConfig = {
    discord: { token: '', allowedGuilds: new Set() },
    projects: [...options.projects],
    copilot: {
      executable: process.execPath,
      args: [FAKE_AGENT],
      startupTimeoutMs: 15_000,
      env: { FAKE_ACP_SCENARIO: JSON.stringify(options.scenario ?? { steps: [] }) },
    },
    approval: { timeoutMs: options.approvalTimeoutMs ?? 30 * 60 * 1000 },
    sessions: {
      maxConcurrentPerProject: options.maxConcurrentPerProject ?? 4,
      idleTimeoutMs: 0,
    },
    output: {
      showThoughts: options.showThoughts ?? false,
      // Flush promptly so assertions do not have to wait a second.
      flushIntervalMs: 20,
      maxMessageChars: 1_900,
      attachThresholdChars: 6_000,
    },
    storage: { databasePath: ':memory:' },
  };

  const db = openDatabase({ databasePath: ':memory:' });
  const repos = createRepositories(db);

  const events: Array<{ name: string; payload: unknown }> = [];
  const bus = new EventBus((event, error) => logger.error(`handler for ${event} threw`, error));
  for (const name of [
    'SessionCreated',
    'UserMessageReceived',
    'CopilotStarted',
    'CopilotMessageReceived',
    'CopilotActionRequested',
    'CopilotActionCompleted',
    'CopilotCompleted',
    'CopilotFailed',
    'SessionCancelled',
    'SessionStatusChanged',
    'MemoryRequested',
    'MemoryApproved',
    'MemoryRejected',
  ] as const) {
    bus.on(name, (payload) => events.push({ name, payload }));
  }

  const registry = new InteractionRegistry();
  const provider = new FakeProvider();
  registry.register(provider);

  const projects = new ProjectManager(config, repos.projects, logger.child('projects'));
  const sessions = new SessionManager(repos.sessions, bus, logger.child('sessions'));

  // The fake agent is a plain node script, so `--acp` must not be injected.
  const processes = new CopilotProcessManager(
    config.copilot,
    config.sessions,
    logger.child('copilot'),
    ({ extraArgs }) => [...extraArgs],
  );

  const approvals = new ApprovalManager({
    approvals: repos.approvals,
    registry,
    statusSink: { setSessionStatus: (id, status) => void sessions.setStatus(id, status) },
    timeoutMs: config.approval.timeoutMs,
    logger: logger.child('approval'),
  });
  provider.attach(approvals);

  const memory = new MemoryManager({
    memories: repos.memories,
    registry,
    bus,
    approvalTimeoutMs: config.approval.timeoutMs,
    logger: logger.child('memory'),
  });

  const memoryMcp: MemoryMcpServer | null = options.startMemoryMcp
    ? new MemoryMcpServer(
        memory,
        (id: string) => orchestrator.resolveSessionForMemory(id),
        logger.child('memory-mcp'),
      )
    : null;

  const orchestrator: AgentOrchestrator = new AgentOrchestrator({
    config,
    projects,
    sessions,
    processes,
    approvals,
    memory,
    memoryMcp,
    messages: repos.messages,
    registry,
    bus,
    logger: logger.child('orchestrator'),
  });

  const commands = new BridgeCommands({ orchestrator, projects, sessions, memory, approvals, processes });

  if (memoryMcp) await memoryMcp.start();

  return {
    db,
    config,
    bus,
    registry,
    provider,
    projects,
    sessions,
    processes,
    approvals,
    memory,
    memoryMcp,
    orchestrator,
    commands,
    events,
    async dispose() {
      await orchestrator.shutdown().catch(() => undefined);
      await memoryMcp?.stop().catch(() => undefined);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Polls until `predicate` holds, so tests need no arbitrary sleeps. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 15_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}
