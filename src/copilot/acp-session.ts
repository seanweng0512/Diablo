import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';

import {
  client,
  ndJsonStream,
  type ClientConnection,
  type McpServer,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';

import type { Logger } from '../util/logger.js';
import { parsePermissionRequest, parseSessionUpdate } from './event-parser.js';
import type {
  CopilotEvent,
  CopilotExitInfo,
  CopilotPermissionRequest,
  CopilotPermissionResponse,
  PromptResult,
} from './events.js';

/** Raised when Copilot cannot be started, with a message worth showing a user. */
export class CopilotStartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CopilotStartupError';
  }
}

export interface CopilotSessionHandlers {
  onEvent(event: CopilotEvent): void;
  /**
   * Called for every `session/request_permission`. Copilot stays blocked until
   * this resolves, which is precisely what makes §26 hold: there is no code path
   * that lets an action through without an answer.
   */
  onPermissionRequest(request: CopilotPermissionRequest): Promise<CopilotPermissionResponse>;
  onExit(info: CopilotExitInfo): void;
}

/**
 * Builds the argument vector for the real Copilot CLI.
 *
 * Kept separate from {@link CopilotAcpSession} so that the session class stays a
 * plain ACP client: anything that speaks ACP over stdio can be driven by it,
 * which is what lets the test suite substitute a fake agent.
 *
 * Note what is *absent*: no `--allow-all-tools`, `--allow-all`, or `--yolo`.
 * Those flags make Copilot stop issuing `session/request_permission` entirely,
 * which would silently defeat §21 and §26. Manual permission mode is the whole
 * mechanism by which this Bridge is safe, so it is not configurable.
 */
export function buildCopilotArgs(options: {
  readonly extraArgs?: readonly string[];
  readonly model?: string | undefined;
}): string[] {
  const args = ['--acp', ...(options.extraArgs ?? [])];
  if (options.model) args.push('--model', options.model);
  return args;
}

export interface CopilotSessionOptions {
  readonly executable: string;
  /** The complete argument vector. Use {@link buildCopilotArgs} for real Copilot. */
  readonly args: readonly string[];
  /** Absolute path to the project working tree; validated before spawn (§16). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: readonly McpServer[];
  /** ACP session id to resume rather than create (§14 item 9). */
  readonly resumeSessionId?: string | undefined;
  readonly handlers: CopilotSessionHandlers;
  readonly logger: Logger;
}

const STDERR_TAIL_LIMIT = 4_000;

/**
 * One Copilot process hosting one ACP session.
 *
 * Sessions get a process each (§15) rather than sharing one agent process. That
 * costs memory, but it buys crash isolation — a Copilot that dies takes down one
 * Discord thread instead of every thread in the project — and it keeps each
 * process's working directory pinned to exactly one project (§16).
 */
export class CopilotAcpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private acpSessionId: string | null = null;
  private stderrTail = '';
  private stopping = false;
  private exited = false;
  private readonly exitPromise: Promise<CopilotExitInfo>;
  private resolveExit!: (info: CopilotExitInfo) => void;

  constructor(private readonly options: CopilotSessionOptions) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  get copilotSessionId(): string | null {
    return this.acpSessionId;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Resolves when the underlying process exits, for whatever reason. */
  get closed(): Promise<CopilotExitInfo> {
    return this.exitPromise;
  }

  /**
   * Validates the working directory, starts Copilot, performs the ACP handshake
   * and opens (or resumes) a session.
   */
  async start(): Promise<void> {
    const { cwd, logger } = this.options;

    // §16 — never let Copilot loose in the wrong directory, or in none at all.
    if (!existsSync(cwd)) {
      throw new CopilotStartupError(`project working directory does not exist: ${cwd}`);
    }
    if (!statSync(cwd).isDirectory()) {
      throw new CopilotStartupError(`project working directory is not a directory: ${cwd}`);
    }

    const args = [...this.options.args];

    logger.info(`starting Copilot: ${this.options.executable} ${args.join(' ')} (cwd=${cwd})`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable, args, {
        cwd,
        // shell: false — never interpolate into a command line from a process
        // whose whole job is running other people's repositories.
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new CopilotStartupError(
        `failed to spawn ${this.options.executable}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    this.child = child;

    child.once('error', (error) => {
      logger.error('Copilot process error', error);
      this.finishExit(null, null);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      logger.debug(`copilot stderr: ${chunk.trimEnd()}`);
    });
    child.once('exit', (code, signal) => {
      logger.info(`Copilot exited code=${code} signal=${signal}`);
      this.finishExit(code, signal);
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const app = client({ name: 'diablo-agent-bridge' })
      .onNotification('session/update', ({ params }) => {
        this.handleSessionUpdate(params.update);
      })
      .onRequest('session/request_permission', async ({ params }) => {
        const request = parsePermissionRequest(params);
        logger.info(`permission requested: ${request.title}`, { command: request.command });

        const decision = await this.options.handlers.onPermissionRequest(request);
        if (decision.type === 'cancelled') {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: decision.optionId } };
      });

    this.connection = app.connect(stream);

    await this.withStartupTimeout(async () => {
      const init = await this.connection!.agent.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          // Deliberately false. Advertising filesystem or terminal capabilities
          // would let Copilot ask the Bridge to read/write files and run
          // commands directly via `fs/*` and `terminal/*`, which do not go
          // through `session/request_permission`. Declining them keeps every
          // dangerous action inside Copilot's own tools, where the permission
          // request is guaranteed — one approval funnel instead of two, and no
          // silent bypass of §21.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      logger.debug('ACP initialize complete', {
        agent: init.agentInfo?.name,
        version: init.agentInfo?.version,
        loadSession: init.agentCapabilities?.loadSession,
      });

      if (this.options.resumeSessionId) {
        if (init.agentCapabilities?.loadSession) {
          await this.connection!.agent.request('session/load', {
            sessionId: this.options.resumeSessionId,
            cwd: this.options.cwd,
            mcpServers: [...this.options.mcpServers],
          });
          this.acpSessionId = this.options.resumeSessionId;
          logger.info(`resumed Copilot session ${this.acpSessionId}`);
          return;
        }
        logger.warn('agent does not advertise loadSession; opening a fresh session instead');
      }

      const created = await this.connection!.agent.request('session/new', {
        cwd: this.options.cwd,
        mcpServers: [...this.options.mcpServers],
        ...(this.options.additionalDirectories.length > 0
          ? { additionalDirectories: [...this.options.additionalDirectories] }
          : {}),
      });
      this.acpSessionId = created.sessionId;
      logger.info(`opened Copilot session ${this.acpSessionId}`);
    });
  }

  /** Sends a prompt and resolves when the turn ends. */
  async prompt(text: string): Promise<PromptResult> {
    if (!this.connection || !this.acpSessionId) {
      throw new Error('Copilot session is not started');
    }
    const response = await this.connection.agent.request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    });
    return { stopReason: response.stopReason };
  }

  /**
   * Interrupts the current turn.
   *
   * ACP requires that any in-flight permission request be answered with
   * `cancelled` after this, which the caller does by resolving its pending
   * approvals; otherwise the agent waits forever.
   */
  async cancel(): Promise<void> {
    if (!this.connection || !this.acpSessionId) return;
    try {
      await this.connection.agent.notify('session/cancel', { sessionId: this.acpSessionId });
    } catch (error) {
      this.options.logger.warn('session/cancel failed', error);
    }
  }

  /** Closes the ACP session and terminates the process. */
  async dispose(): Promise<void> {
    if (this.stopping) {
      await this.exitPromise;
      return;
    }
    this.stopping = true;

    if (this.connection && this.acpSessionId) {
      try {
        await this.connection.agent.request('session/close', { sessionId: this.acpSessionId });
      } catch (error) {
        this.options.logger.debug('session/close failed (continuing to terminate)', error);
      }
    }
    try {
      this.connection?.close();
    } catch {
      // Closing a already-dead connection is not interesting.
    }

    const child = this.child;
    if (child && !this.exited) {
      child.kill();
      // Escalate if it ignores the polite request.
      const killTimer = setTimeout(() => {
        if (!this.exited) {
          this.options.logger.warn(`Copilot pid ${child.pid} did not exit; sending SIGKILL`);
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 5_000);
      killTimer.unref();
      await this.exitPromise;
      clearTimeout(killTimer);
    }
  }

  private handleSessionUpdate(update: SessionUpdate): void {
    let event: CopilotEvent;
    try {
      event = parseSessionUpdate(update);
    } catch (error) {
      this.options.logger.warn('failed to parse session update', error);
      return;
    }
    if (event.kind === 'ignored') {
      this.options.logger.debug(`ignoring session update: ${event.sessionUpdate}`);
      return;
    }
    try {
      this.options.handlers.onEvent(event);
    } catch (error) {
      // A misbehaving consumer must not take down the ACP read loop.
      this.options.logger.error('event handler threw', error);
    }
  }

  private async withStartupTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CopilotStartupError(
              `Copilot did not complete the ACP handshake within ${this.options.startupTimeoutMs}ms. ` +
                `Is it logged in? Try \`${this.options.executable} login\`.` +
                (this.stderrTail ? `\nstderr: ${this.stderrTail.trim()}` : ''),
            ),
          ),
        this.options.startupTimeoutMs,
      );
    });

    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      await this.dispose().catch(() => undefined);
      if (error instanceof CopilotStartupError) throw error;
      throw new CopilotStartupError(
        `Copilot startup failed: ${(error as Error).message}` +
          (this.stderrTail ? `\nstderr: ${this.stderrTail.trim()}` : ''),
        { cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    const info: CopilotExitInfo = {
      code,
      signal,
      expected: this.stopping,
      stderrTail: this.stderrTail.trim(),
    };
    this.resolveExit(info);
    try {
      this.options.handlers.onExit(info);
    } catch (error) {
      this.options.logger.error('exit handler threw', error);
    }
  }
}
