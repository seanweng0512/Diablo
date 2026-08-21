import path from 'node:path';

import { ApprovalManager } from './approval/manager.js';
import { loadConfig, loadDotEnv } from './config/load.js';
import { ConfigError, type BridgeConfig, type ProjectConfig } from './config/types.js';
import { BridgeCommands } from './core/commands.js';
import { EventBus } from './core/events.js';
import { AgentOrchestrator } from './core/orchestrator.js';
import { ProjectManager } from './core/project-manager.js';
import { SessionManager } from './core/session-manager.js';
import { CopilotProcessManager } from './copilot/process-manager.js';
import { DiscordBot } from './discord/bot.js';
import { CliInteractionProvider, CLI_PROVIDER_ID } from './interaction/cli-provider.js';
import { InteractionRegistry } from './interaction/provider.js';
import { MemoryManager } from './memory/manager.js';
import { MemoryMcpServer } from './memory/mcp-server.js';
import { openDatabase } from './storage/db.js';
import { createRepositories } from './storage/repositories.js';
import { createLogger } from './util/logger.js';

const log = createLogger('bridge');

interface CliArgs {
  readonly configPath: string;
  /** Run the CLI provider instead of (or as well as) Discord. */
  readonly cliProject: string | null;
  readonly useCli: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath = path.resolve('config/config.yaml');
  let cliProject: string | null = null;
  let useCli = false;

  for (const arg of argv) {
    if (arg.startsWith('--config=')) configPath = path.resolve(arg.slice('--config='.length));
    else if (arg === '--provider=cli' || arg === '--cli') useCli = true;
    else if (arg.startsWith('--project=')) {
      cliProject = arg.slice('--project='.length);
      useCli = true;
    }
  }
  return { configPath, cliProject, useCli };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.resolve('.env'));

  let config: BridgeConfig;
  try {
    const loaded = loadConfig(args.configPath);
    config = loaded.config;
    for (const warning of loaded.warnings) log.warn(warning);
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  log.info(`config loaded from ${args.configPath}`);

  // --- storage ------------------------------------------------------------
  const db = openDatabase({ databasePath: config.storage.databasePath });
  const repos = createRepositories(db);

  // --- core ---------------------------------------------------------------
  const bus = new EventBus((event, error) => log.error(`event handler for ${event} threw`, error));
  const registry = new InteractionRegistry();
  const projects = new ProjectManager(config, repos.projects, log.child('projects'));
  const sessions = new SessionManager(repos.sessions, bus, log.child('sessions'));

  // Nothing survives a restart, so say so rather than showing stale Running
  // sessions in /status (§39).
  sessions.failOrphaned();

  const processes = new CopilotProcessManager(config.copilot, config.sessions, log.child('copilot'));

  const approvals = new ApprovalManager({
    approvals: repos.approvals,
    registry,
    statusSink: { setSessionStatus: (id, status) => void sessions.setStatus(id, status) },
    timeoutMs: config.approval.timeoutMs,
    logger: log.child('approval'),
  });

  const memory = new MemoryManager({
    memories: repos.memories,
    registry,
    bus,
    approvalTimeoutMs: config.approval.timeoutMs,
    logger: log.child('memory'),
  });

  // The MCP server resolves sessions through the orchestrator, and the
  // orchestrator hands the MCP descriptor to each new Copilot session. The cycle
  // is broken by the closure below, which is not called until a tool call
  // arrives — long after both exist. The annotations are what let TypeScript
  // see that.
  const anyMemoryEnabled = config.projects.some((project) => project.memoryEnabled);
  const memoryMcp: MemoryMcpServer | null = anyMemoryEnabled
    ? new MemoryMcpServer(
        memory,
        (id: string) => orchestrator.resolveSessionForMemory(id),
        log.child('memory-mcp'),
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
    logger: log.child('orchestrator'),
  });

  const commands = new BridgeCommands({ orchestrator, projects, sessions, memory, approvals, processes });

  if (memoryMcp) await memoryMcp.start();
  processes.startReaper();

  // --- interaction providers ---------------------------------------------
  const discordProjects = projects.discordProjects();
  let bot: DiscordBot | null = null;

  if (discordProjects.length > 0 && !args.useCli) {
    bot = new DiscordBot({
      config,
      orchestrator,
      commands,
      projects,
      sessions,
      memory,
      logger: log.child('discord'),
    });
    registry.register(bot.provider);
    await bot.start();
    log.info(
      `Discord enabled for ${discordProjects.length} project(s): ` +
        discordProjects.map((project) => project.id).join(', '),
    );
  } else if (discordProjects.length === 0) {
    // §6.2 — Discord being absent is a supported configuration, not an error.
    log.info('no project has discord_enabled; running without Discord');
  }

  let cliProvider: CliInteractionProvider | null = null;
  if (args.useCli) {
    const project = pickCliProject(config, args.cliProject);
    if (!project) {
      log.error(
        args.cliProject
          ? `no project named \`${args.cliProject}\` in the config`
          : 'no projects configured',
      );
      process.exitCode = 2;
      return;
    }
    cliProvider = new CliInteractionProvider(project, orchestrator, commands, memory, log.child('cli'));
    registry.register(cliProvider);
    await cliProvider.start();
  }

  if (registry.list().length === 0) {
    log.warn(
      'no interaction provider is running, so nobody can approve anything. ' +
        'Start with --cli, or enable Discord for a project.',
    );
  }

  // --- shutdown -----------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}; shutting down`);

    processes.stopReaper();
    await cliProvider?.stop().catch(() => undefined);
    await bot?.stop().catch(() => undefined);
    await orchestrator.shutdown().catch((error: unknown) => log.warn('shutdown error', error));
    await memoryMcp?.stop().catch(() => undefined);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    log.info('goodbye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', reason));
  process.on('uncaughtException', (error) => log.error('uncaught exception', error));

  log.info('bridge ready');
}

function pickCliProject(config: BridgeConfig, requested: string | null): ProjectConfig | null {
  if (requested) return config.projects.find((project) => project.id === requested) ?? null;
  return config.projects[0] ?? null;
}

await main();
