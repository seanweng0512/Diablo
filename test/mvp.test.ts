import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, makeProject, waitFor, type Harness } from './harness';

/**
 * Walks the exact scenario in spec §45, step by step.
 *
 * The step numbers in the test names refer to that list, so a failure points
 * straight at the requirement it breaks.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const BACKEND = makeProject({
  id: 'backend',
  name: 'Backend',
  discordEnabled: true,
  discordChannelId: 'chan-backend',
  security: { allowedUsers: new Set(['user-1']) } as never,
});

const FRONTEND_NO_DISCORD = makeProject({
  id: 'frontend',
  name: 'Frontend',
  discordEnabled: false,
});

/** The §45 scenario: approve `dotnet test`, then reject the next action. */
const TWO_ACTION_SCENARIO = {
  steps: [
    { type: 'message', text: 'I found the problem in RedisConnectionFactory. ' },
    {
      type: 'tool',
      toolCallId: 'call-1',
      title: 'Run tests',
      kind: 'execute',
      command: 'dotnet test',
      permission: 'ask',
      output: '42 passed, 0 failed',
    },
    {
      type: 'tool',
      toolCallId: 'call-2',
      title: 'Force push the fix',
      kind: 'execute',
      command: 'git push --force origin main',
      permission: 'ask',
      onRejectMessage: 'Understood — I will not force push. Leaving the branch as is.',
    },
    { type: 'message', text: 'Done: timeout increased and retries added.' },
  ],
  stopReason: 'end_turn',
};

describe('§45 MVP definition of done', () => {
  it('steps 1-8: a Discord message creates a session and starts Copilot', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: { steps: [{ type: 'message', text: 'working' }] } });

    // Step 3: the channel resolves to the project.
    expect(harness.projects.byDiscordChannel('chan-backend')?.id).toBe('backend');

    // Steps 4-6: the thread becomes a session.
    const session = await harness.orchestrator.handleUserMessage({
      project: BACKEND,
      providerId: 'fake',
      text: 'Fix the Redis timeout issue.',
      author: 'user-1',
      title: 'Fix Redis timeout',
      discordGuildId: 'guild-1',
      discordChannelId: 'chan-backend',
      discordThreadId: 'thread-A',
    });

    expect(session.projectId).toBe('backend');
    expect(session.title).toBe('Fix Redis timeout');
    expect(session.discordThreadId).toBe('thread-A');

    // Steps 7-8: Copilot receives it and works.
    await waitFor(() => harness!.events.some((e) => e.name === 'CopilotStarted'), {
      label: 'CopilotStarted',
    });
    await waitFor(() => harness!.provider.text.includes('working'), { label: 'agent output' });

    const bound = harness.sessions.findById(session.id)!;
    expect(bound.copilotSessionId).toBeTruthy();
    expect(bound.copilotProcessId).toBeGreaterThan(0);
  });

  it('steps 9-12: an action request surfaces for approval and continues once approved', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: TWO_ACTION_SCENARIO });
    harness.provider.autoDecision = 'approve';

    await harness.orchestrator.handleUserMessage({
      project: BACKEND,
      providerId: 'fake',
      text: 'Fix the Redis timeout issue.',
      author: 'user-1',
      title: 'Fix Redis timeout',
      discordThreadId: 'thread-A',
    });

    // Step 10: Discord is shown the command.
    await waitFor(() => harness!.provider.approvals.length >= 1, { label: 'first approval' });
    const first = harness.provider.approvals[0]!;
    expect(first.approval.command).toBe('dotnet test');
    expect(first.approval.actionType).toBe('execute_command');

    // Steps 11-12: approving lets Copilot proceed to the next action.
    await waitFor(() => harness!.provider.approvals.length >= 2, { label: 'second approval' });
    expect(harness.provider.resolutions[0]?.status).toBe('Approved');
    expect(harness.provider.resolutions[0]?.resolvedBy).toBe('fake-user');
  });

  it('steps 13-18: a rejection reaches Copilot, which reports and completes', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: TWO_ACTION_SCENARIO });

    // Approve the first request, reject the second.
    let seen = 0;
    const provider = harness.provider;
    const approvals = harness.approvals;
    provider.autoDecision = null;

    const originalRequest = provider.requestApproval.bind(provider);
    provider.requestApproval = async (target, prompt) => {
      await originalRequest(target, prompt);
      seen += 1;
      const decision = seen === 1 ? 'approve' : 'reject';
      setTimeout(() => void approvals.resolve(prompt.approval.id, decision, 'user-1'), 5);
    };

    await harness.orchestrator.handleUserMessage({
      project: BACKEND,
      providerId: 'fake',
      text: 'Fix it and push.',
      author: 'user-1',
      title: 'Fix Redis timeout',
      discordThreadId: 'thread-A',
    });

    // Step 15-16: Copilot is told no, and says so rather than proceeding.
    await waitFor(() => provider.text.includes('I will not force push'), {
      label: 'rejection acknowledged by Copilot',
    });

    // Step 17-18: the turn completes and the result reaches the user.
    await waitFor(() => provider.completions.length >= 1, { label: 'completion report' });
    expect(provider.completions[0]!.succeeded).toBe(true);
    expect(provider.text).toContain('timeout increased');

    expect(provider.resolutions.map((r) => r.status)).toEqual(['Approved', 'Rejected']);
    // The rejected command was the dangerous one, and it was classified as such.
    const forcePush = provider.approvals.find((p) => p.approval.command?.includes('--force'))!;
    expect(forcePush.approval.riskLevel).toBe('high');
    expect(forcePush.approval.riskReason).toMatch(/overwrites remote history/);
  });

  it('steps 19-21: a second thread gets an independent, concurrent session', async () => {
    harness = await createHarness({
      projects: [BACKEND],
      scenario: {
        steps: [
          { type: 'tool', toolCallId: 'c', title: 'Work', command: 'echo hi', permission: 'ask', output: 'hi' },
          { type: 'message', text: 'finished' },
        ],
      },
    });
    harness.provider.autoDecision = 'approve';

    const a = await harness.orchestrator.handleUserMessage({
      project: BACKEND,
      providerId: 'fake',
      text: 'Task A',
      author: 'user-1',
      title: 'Thread A',
      discordThreadId: 'thread-A',
    });
    const b = await harness.orchestrator.handleUserMessage({
      project: BACKEND,
      providerId: 'fake',
      text: 'Task B',
      author: 'user-1',
      title: 'Thread B',
      discordThreadId: 'thread-B',
    });

    // Step 20: distinct sessions.
    expect(a.id).not.toBe(b.id);
    expect(harness.sessions.findActiveByThread('thread-A')!.id).toBe(a.id);
    expect(harness.sessions.findActiveByThread('thread-B')!.id).toBe(b.id);

    // Step 21: both run at once, in separate Copilot processes.
    await waitFor(() => harness!.processes.countActive('backend') >= 2, {
      label: 'two live Copilot processes',
    });
    await waitFor(() => harness!.provider.completions.length >= 2, { label: 'both turns complete' });

    // Each approval names its own session — no cross-talk (§9).
    const sessionIds = new Set(harness.provider.approvals.map((p) => p.approval.sessionId));
    expect(sessionIds).toEqual(new Set([a.id, b.id]));
  });

  it('step 22: project memory is shared across sessions in the same project', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: { steps: [] } });

    harness.memory.addDirect('backend', 'Project uses .NET 8', 'stack', 'user-1');
    harness.memory.addDirect('backend', 'Tests use xUnit', 'stack', 'user-1');

    const preamble = harness.memory.preambleFor(BACKEND)!;
    expect(preamble).toContain('Project uses .NET 8');
    expect(preamble).toContain('Tests use xUnit');

    // Both sessions of this project read the same store.
    expect(harness.commands.memoryList('backend')).toHaveLength(2);
  });

  it('step 23: one project cannot reach another project’s memory', async () => {
    harness = await createHarness({ projects: [BACKEND, FRONTEND_NO_DISCORD], scenario: { steps: [] } });

    harness.memory.addDirect('backend', 'Backend uses Dapper', 'stack', 'user-1');

    expect(harness.memory.list('frontend')).toHaveLength(0);
    expect(harness.memory.preambleFor(FRONTEND_NO_DISCORD)).toBeNull();
    expect(harness.memory.search('frontend', 'Dapper')).toHaveLength(0);
  });

  it('steps 24-25: a project with Discord disabled still works end to end', async () => {
    harness = await createHarness({
      projects: [FRONTEND_NO_DISCORD],
      scenario: { steps: [{ type: 'message', text: 'frontend work done' }] },
    });

    // Step 24: no Discord mapping at all.
    expect(FRONTEND_NO_DISCORD.discordEnabled).toBe(false);
    expect(harness.projects.discordProjects()).toHaveLength(0);

    // Step 25: it functions anyway, through a non-Discord provider.
    const session = await harness.orchestrator.handleUserMessage({
      project: FRONTEND_NO_DISCORD,
      providerId: 'fake',
      text: 'Do the frontend work',
      author: 'cli',
    });

    expect(session.discordThreadId).toBeNull();
    await waitFor(() => harness!.provider.text.includes('frontend work done'), {
      label: 'output without Discord',
    });
  });
});

describe('memory approval over MCP (§20)', () => {
  it('asks before persisting, and saves only on approval', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: { steps: [] }, startMemoryMcp: true });

    const session = harness.sessions.create({
      project: BACKEND,
      providerId: 'fake',
      title: 'Memory test',
    });

    const pending = harness.memory.requestPersist({
      session,
      project: BACKEND,
      content: 'Redis connections are managed by RedisConnectionFactory',
      category: 'architecture',
    });

    await waitFor(() => harness!.provider.memoryPrompts.length === 1, { label: 'memory prompt' });
    const prompt = harness.provider.memoryPrompts[0]!;
    expect(prompt.content).toContain('RedisConnectionFactory');

    // Nothing is stored until a human says yes.
    expect(harness.memory.list('backend')).toHaveLength(0);

    harness.memory.resolveMemoryRequest(prompt.requestId, true, 'user-1');
    const outcome = await pending;

    expect(outcome.approved).toBe(true);
    const stored = harness.memory.list('backend');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.approvedBy).toBe('user-1');
  });

  it('does not persist a rejected fact, and tells Copilot so', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: { steps: [] } });

    const session = harness.sessions.create({
      project: BACKEND,
      providerId: 'fake',
      title: 'Memory test',
    });
    const pending = harness.memory.requestPersist({
      session,
      project: BACKEND,
      content: 'Something wrong',
      category: 'general',
    });

    await waitFor(() => harness!.provider.memoryPrompts.length === 1, { label: 'memory prompt' });
    harness.memory.resolveMemoryRequest(harness.provider.memoryPrompts[0]!.requestId, false, 'user-1');

    const outcome = await pending;
    expect(outcome.approved).toBe(false);
    expect(outcome.message).toMatch(/declined/i);
    expect(harness.memory.list('backend')).toHaveLength(0);
  });

  it('the MCP transport pins a session to its own project', async () => {
    harness = await createHarness({
      projects: [BACKEND, FRONTEND_NO_DISCORD],
      scenario: { steps: [] },
      startMemoryMcp: true,
    });

    const backendSession = harness.sessions.create({
      project: BACKEND,
      providerId: 'fake',
      title: 'Backend',
    });

    const descriptor = harness.memoryMcp!.descriptorFor(backendSession.id)!;
    expect(descriptor.type).toBe('http');

    // The token identifies the session, and therefore the project; the model
    // never names a project and so cannot choose a different one.
    const resolved = harness.orchestrator.resolveSessionForMemory(backendSession.id)!;
    expect(resolved.project.id).toBe('backend');

    // A rejected token yields nothing at all.
    const url = (descriptor as { url: string }).url;
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('serves the tool definition to an authenticated caller', async () => {
    harness = await createHarness({ projects: [BACKEND], scenario: { steps: [] }, startMemoryMcp: true });

    const session = harness.sessions.create({ project: BACKEND, providerId: 'fake', title: 'T' });
    const descriptor = harness.memoryMcp!.descriptorFor(session.id)! as unknown as {
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    const auth = descriptor.headers.find((h) => h.name === 'Authorization')!.value;

    const response = await fetch(descriptor.url, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };

    expect(response.status).toBe(200);
    expect(body.result.tools.map((t) => t.name)).toEqual(['remember_project_fact']);
  });
});
