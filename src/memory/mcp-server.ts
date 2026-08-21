import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { McpServer } from '@agentclientprotocol/sdk';

import type { ProjectConfig } from '../config/types.js';
import type { Session } from '../core/types.js';
import type { Logger } from '../util/logger.js';
import type { MemoryManager } from './manager.js';

/**
 * An in-process MCP server that gives Copilot a way to *ask* to remember things.
 *
 * Spec §20 assumes Copilot can say "I want to remember X", but nothing in its
 * output does that — it has no such channel. Handing it an MCP tool creates one:
 * `remember_project_fact` becomes a normal tool call, which the Bridge answers
 * only after a human approves, and Copilot learns the outcome from the tool
 * result.
 *
 * Two properties make this safe rather than clever:
 *
 * 1. It binds to 127.0.0.1 on an ephemeral port and requires a bearer token, so
 *    only processes we handed a token to can reach it.
 * 2. The token *is* the session identity. A token minted for a session in
 *    project A can only ever write to project A's memory, so §45 step 23's
 *    isolation is enforced by the transport rather than by a check someone
 *    might forget to write.
 */

export const MEMORY_MCP_SERVER_NAME = 'diablo-memory';
export const MEMORY_TOOL_NAME = 'remember_project_fact';

/** Resolves a session id to the live session and its project. */
export type SessionResolver = (
  sessionId: string,
) => { session: Session; project: ProjectConfig } | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const MAX_BODY_BYTES = 256 * 1024;
const MCP_PROTOCOL_VERSION = '2024-11-05';

const TOOL_DEFINITION = {
  name: MEMORY_TOOL_NAME,
  description:
    'Record a durable fact about this project so that future sessions know it. ' +
    'Use it for architecture, conventions, dependencies and project-specific rules — ' +
    'not for the current task, current test results, or anything that stops being true ' +
    'once this task is done. The user must approve every fact before it is stored, and ' +
    'the tool result tells you whether it was kept.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'One durable fact, stated plainly. For example: "Tests use xUnit".',
      },
      category: {
        type: 'string',
        description: 'Optional grouping, e.g. stack, convention, constraint, dependency.',
      },
    },
    required: ['content'],
  },
} as const;

export class MemoryMcpServer {
  private server: http.Server | null = null;
  private port = 0;
  /** token -> bridge session id */
  private readonly tokens = new Map<string, string>();
  /** bridge session id -> token, so a session reuses one token */
  private readonly tokensBySession = new Map<string, string>();

  constructor(
    private readonly memory: MemoryManager,
    private readonly resolveSession: SessionResolver,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;

    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.logger.error('MCP request handler failed', error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 only — never expose this to the network.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.logger.info(`memory MCP server listening on http://127.0.0.1:${this.port}/mcp`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.tokens.clear();
    this.tokensBySession.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Mints (or returns) the MCP server descriptor for a session.
   *
   * Pass the result into `session/new`'s `mcpServers`.
   */
  descriptorFor(sessionId: string): McpServer | null {
    if (!this.server) return null;

    let token = this.tokensBySession.get(sessionId);
    if (!token) {
      token = randomBytes(32).toString('base64url');
      this.tokens.set(token, sessionId);
      this.tokensBySession.set(sessionId, token);
    }

    return {
      type: 'http',
      name: MEMORY_MCP_SERVER_NAME,
      url: `http://127.0.0.1:${this.port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
  }

  /** Revokes a session's token when its Copilot process goes away. */
  revoke(sessionId: string): void {
    const token = this.tokensBySession.get(sessionId);
    if (!token) return;
    this.tokensBySession.delete(sessionId);
    this.tokens.delete(token);
  }

  // -------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    const sessionId = this.authenticate(req);
    if (!sessionId) {
      this.logger.warn('rejected unauthenticated MCP request');
      res.writeHead(401).end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (error) {
      res.writeHead(413).end(String((error as Error).message));
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      this.sendError(res, null, -32700, 'parse error');
      return;
    }

    // Notifications get no body back.
    if (message.id === undefined || message.id === null) {
      res.writeHead(202).end();
      return;
    }

    switch (message.method) {
      case 'initialize':
        this.sendResult(res, message.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MEMORY_MCP_SERVER_NAME, version: '1.0.0' },
        });
        return;

      case 'ping':
        this.sendResult(res, message.id, {});
        return;

      case 'tools/list':
        this.sendResult(res, message.id, { tools: [TOOL_DEFINITION] });
        return;

      case 'tools/call':
        await this.handleToolCall(res, message, sessionId);
        return;

      default:
        this.sendError(res, message.id, -32601, `method not found: ${message.method}`);
    }
  }

  private async handleToolCall(
    res: http.ServerResponse,
    message: JsonRpcMessage,
    sessionId: string,
  ): Promise<void> {
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };

    if (params.name !== MEMORY_TOOL_NAME) {
      this.sendToolResult(res, message.id!, `Unknown tool: ${String(params.name)}`, true);
      return;
    }

    const args = (params.arguments ?? {}) as { content?: unknown; category?: unknown };
    const content = typeof args.content === 'string' ? args.content : '';
    const category = typeof args.category === 'string' ? args.category : 'general';

    if (!content.trim()) {
      this.sendToolResult(res, message.id!, 'The `content` argument is required.', true);
      return;
    }

    // The token decides which project this can touch — the model has no say.
    const resolved = this.resolveSession(sessionId);
    if (!resolved) {
      this.sendToolResult(
        res,
        message.id!,
        'That session is no longer active, so nothing was saved.',
        true,
      );
      return;
    }

    this.logger.info(
      `memory requested by session ${sessionId} (project ${resolved.project.id}): ${content.slice(0, 120)}`,
    );

    const outcome = await this.memory.requestPersist({
      session: resolved.session,
      project: resolved.project,
      content,
      category,
    });

    this.sendToolResult(res, message.id!, outcome.message, false);
  }

  /** Constant-time bearer token check. */
  private authenticate(req: http.IncomingMessage): string | null {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const presented = Buffer.from(header.slice('Bearer '.length));

    for (const [token, sessionId] of this.tokens) {
      const expected = Buffer.from(token);
      if (expected.length !== presented.length) continue;
      if (timingSafeEqual(expected, presented)) return sessionId;
    }
    return null;
  }

  private sendResult(res: http.ServerResponse, id: string | number, result: unknown): void {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private sendError(
    res: http.ServerResponse,
    id: string | number | null,
    code: number,
    message: string,
  ): void {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  private sendToolResult(
    res: http.ServerResponse,
    id: string | number,
    text: string,
    isError: boolean,
  ): void {
    this.sendResult(res, id, { content: [{ type: 'text', text }], isError });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
