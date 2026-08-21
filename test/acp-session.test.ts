import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CopilotAcpSession, CopilotStartupError } from '../src/copilot/acp-session';
import type { CopilotEvent, CopilotPermissionRequest, CopilotPermissionResponse } from '../src/copilot/events';
import { createLogger } from '../src/util/logger';

const FAKE_AGENT = path.resolve(import.meta.dirname, 'fake-acp-agent.mjs');
const PROJECT_DIR = path.resolve(import.meta.dirname, '..');

interface Harness {
  session: CopilotAcpSession;
  events: CopilotEvent[];
  permissions: CopilotPermissionRequest[];
}

function makeSession(
  scenario: unknown,
  respond: (request: CopilotPermissionRequest) => Promise<CopilotPermissionResponse>,
  overrides: { cwd?: string } = {},
): Harness {
  const events: CopilotEvent[] = [];
  const permissions: CopilotPermissionRequest[] = [];

  const session = new CopilotAcpSession({
    executable: process.execPath,
    args: [FAKE_AGENT],
    cwd: overrides.cwd ?? PROJECT_DIR,
    env: { FAKE_ACP_SCENARIO: JSON.stringify(scenario) },
    startupTimeoutMs: 10_000,
    additionalDirectories: [],
    mcpServers: [],
    logger: createLogger('test'),
    handlers: {
      onEvent: (event) => events.push(event),
      onPermissionRequest: async (request) => {
        permissions.push(request);
        return respond(request);
      },
      onExit: () => undefined,
    },
  });

  return { session, events, permissions };
}

const allowOnce = async (r: CopilotPermissionRequest): Promise<CopilotPermissionResponse> => ({
  type: 'selected',
  optionId: r.options.find((o) => o.kind === 'allow_once')!.optionId,
});

const rejectOnce = async (r: CopilotPermissionRequest): Promise<CopilotPermissionResponse> => ({
  type: 'selected',
  optionId: r.options.find((o) => o.kind === 'reject_once')!.optionId,
});

describe('CopilotAcpSession', () => {
  it('completes the handshake and opens a session', async () => {
    const { session } = makeSession({ steps: [] }, allowOnce);
    await session.start();
    try {
      expect(session.copilotSessionId).toBe('fake-session-0001');
      expect(session.pid).toBeGreaterThan(0);
      expect(session.isAlive).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it('refuses to start outside a real directory before spawning anything (§16)', async () => {
    const { session } = makeSession({ steps: [] }, allowOnce, {
      cwd: path.join(PROJECT_DIR, 'definitely-not-here'),
    });
    await expect(session.start()).rejects.toThrow(CopilotStartupError);
    expect(session.pid).toBeNull(); // never spawned
  });

  it('streams messages and reports the stop reason', async () => {
    const { session, events } = makeSession(
      { steps: [{ type: 'message', text: 'Found the bug' }], stopReason: 'end_turn' },
      allowOnce,
    );
    await session.start();
    try {
      const result = await session.prompt('Fix the Redis timeout issue.');
      expect(result.stopReason).toBe('end_turn');
      expect(events).toEqual(
        expect.arrayContaining([{ kind: 'message', text: 'Found the bug' }]),
      );
    } finally {
      await session.dispose();
    }
  });

  it('surfaces a tool call, its command, and lets an approval through', async () => {
    const { session, events, permissions } = makeSession(
      {
        steps: [
          {
            type: 'tool',
            toolCallId: 'call-1',
            title: 'Run tests',
            kind: 'execute',
            command: 'dotnet test',
            permission: 'ask',
            output: '42 passed',
          },
        ],
      },
      allowOnce,
    );
    await session.start();
    try {
      await session.prompt('run the tests');

      expect(permissions).toHaveLength(1);
      expect(permissions[0]!.command).toBe('dotnet test');
      expect(permissions[0]!.title).toBe('Run tests');
      expect(permissions[0]!.options.map((o) => o.kind)).toContain('allow_once');

      const started = events.find((e) => e.kind === 'tool-started');
      expect(started).toMatchObject({ kind: 'tool-started', call: { command: 'dotnet test' } });

      const updated = events.filter((e) => e.kind === 'tool-updated');
      expect(updated.at(-1)).toMatchObject({ status: 'completed', output: '42 passed' });
    } finally {
      await session.dispose();
    }
  });

  it('propagates a rejection to Copilot, which then reports it (§45 steps 14-16)', async () => {
    const { session, events } = makeSession(
      {
        steps: [
          {
            type: 'tool',
            toolCallId: 'call-1',
            title: 'Force push',
            kind: 'execute',
            command: 'git push --force',
            permission: 'ask',
            onRejectMessage: 'Understood, I will not force push.',
          },
        ],
      },
      rejectOnce,
    );
    await session.start();
    try {
      const result = await session.prompt('push it');
      expect(result.stopReason).toBe('end_turn');

      const updated = events.filter((e) => e.kind === 'tool-updated');
      expect(updated.at(-1)).toMatchObject({ status: 'failed' });
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: 'message', text: 'Understood, I will not force push.' },
        ]),
      );
    } finally {
      await session.dispose();
    }
  });

  it('never proceeds while an approval is unanswered (§26)', async () => {
    let asked = false;
    const { session } = makeSession(
      {
        steps: [
          { type: 'tool', toolCallId: 'c', title: 'Dangerous', command: 'rm -rf /', permission: 'ask' },
          { type: 'message', text: 'THIS MUST NOT APPEAR' },
        ],
      },
      // Never answer.
      () =>
        new Promise<CopilotPermissionResponse>(() => {
          asked = true;
        }),
    );
    await session.start();
    try {
      const settled = await Promise.race([
        session.prompt('go').then(() => 'prompt-resolved' as const),
        new Promise<'still-blocked'>((r) => setTimeout(() => r('still-blocked'), 1_500)),
      ]);
      expect(settled).toBe('still-blocked');
      expect(asked).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it('cancel unblocks a turn waiting on permission', async () => {
    const { session } = makeSession(
      { steps: [{ type: 'tool', toolCallId: 'c', title: 'Wait', command: 'sleep 999', permission: 'ask' }] },
      // Mirror the real Approval Manager: answer `cancelled` once cancel lands.
      () => new Promise<CopilotPermissionResponse>((resolve) => setTimeout(() => resolve({ type: 'cancelled' }), 300)),
    );
    await session.start();
    try {
      const promptPromise = session.prompt('go');
      await new Promise((r) => setTimeout(r, 200));
      await session.cancel();
      const result = await promptPromise;
      expect(result.stopReason).toBe('cancelled');
    } finally {
      await session.dispose();
    }
  });

  it('ignores unknown update variants instead of dying', async () => {
    const { session, events } = makeSession(
      { steps: [{ type: 'unknown_update' }, { type: 'message', text: 'still alive' }] },
      allowOnce,
    );
    await session.start();
    try {
      await session.prompt('go');
      expect(events).toEqual(expect.arrayContaining([{ kind: 'message', text: 'still alive' }]));
    } finally {
      await session.dispose();
    }
  });

  it('parses plan, usage and title updates', async () => {
    const { session, events } = makeSession(
      {
        steps: [
          { type: 'plan', entries: [{ content: 'Inspect factory', status: 'pending', priority: 'high' }] },
          { type: 'usage', used: 21_668, size: 200_000 },
          { type: 'title', title: 'Fix Redis timeout' },
        ],
      },
      allowOnce,
    );
    await session.start();
    try {
      await session.prompt('go');
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: 'plan', entries: [{ content: 'Inspect factory', status: 'pending', priority: 'high' }] },
          { kind: 'usage', used: 21_668, size: 200_000 },
          { kind: 'title', title: 'Fix Redis timeout' },
        ]),
      );
    } finally {
      await session.dispose();
    }
  });

  it('reports an unexpected process exit as a crash (§39)', async () => {
    const { session } = makeSession({ steps: [{ type: 'crash', code: 3 }] }, allowOnce);
    await session.start();
    const closed = session.closed;
    void session.prompt('go').catch(() => undefined);

    const info = await closed;
    expect(info.expected).toBe(false);
    expect(info.code).toBe(3);
  });

  it('marks a Bridge-initiated shutdown as expected', async () => {
    const { session } = makeSession({ steps: [] }, allowOnce);
    await session.start();
    const closed = session.closed;
    await session.dispose();
    expect((await closed).expected).toBe(true);
  });

  it('times out a handshake that never completes, with an actionable message', async () => {
    const events: CopilotEvent[] = [];
    const session = new CopilotAcpSession({
      executable: process.execPath,
      args: [FAKE_AGENT],
      cwd: PROJECT_DIR,
      env: { FAKE_ACP_SCENARIO: JSON.stringify({ hangHandshake: true }) },
      startupTimeoutMs: 800,
      additionalDirectories: [],
      mcpServers: [],
      logger: createLogger('test'),
      handlers: {
        onEvent: (e) => events.push(e),
        onPermissionRequest: allowOnce,
        onExit: () => undefined,
      },
    });

    await expect(session.start()).rejects.toThrow(/did not complete the ACP handshake/);
  });

  it('surfaces a session/new failure as a startup error', async () => {
    const { session } = makeSession({ failNewSession: true }, allowOnce);
    await expect(session.start()).rejects.toThrow(CopilotStartupError);
  });

  it('keeps two concurrent sessions' + ' output separate (§38, §9)', async () => {
    const a = makeSession({ steps: [{ type: 'message', text: 'from A' }], sessionId: 'sess-A' }, allowOnce);
    const b = makeSession({ steps: [{ type: 'message', text: 'from B' }], sessionId: 'sess-B' }, allowOnce);

    await Promise.all([a.session.start(), b.session.start()]);
    try {
      expect(a.session.copilotSessionId).toBe('sess-A');
      expect(b.session.copilotSessionId).toBe('sess-B');

      await Promise.all([a.session.prompt('go'), b.session.prompt('go')]);

      const textsA = a.events.filter((e) => e.kind === 'message').map((e) => e.text);
      const textsB = b.events.filter((e) => e.kind === 'message').map((e) => e.text);
      expect(textsA).toEqual(['from A']);
      expect(textsB).toEqual(['from B']);
    } finally {
      await Promise.all([a.session.dispose(), b.session.dispose()]);
    }
  });
});
