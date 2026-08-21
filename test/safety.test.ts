import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, makeProject, waitFor, type Harness } from './harness';

/**
 * The rules the spec calls mandatory: §26 (never auto-approve) and §41
 * (expiry must not approve). These are the tests worth trusting.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const PROJECT = makeProject({ id: 'backend', name: 'Backend' });

/** A scenario whose second step must never run without approval. */
const GATED = {
  steps: [
    { type: 'tool', toolCallId: 'c1', title: 'Run tests', command: 'dotnet test', permission: 'ask', output: 'ok' },
    { type: 'message', text: 'SECOND-STEP-RAN' },
  ],
  stopReason: 'end_turn',
};

async function startGatedTurn(h: Harness) {
  const session = await h.orchestrator.handleUserMessage({
    project: PROJECT,
    providerId: 'fake',
    text: 'go',
    author: 'user-1',
    title: 'Gated',
    discordThreadId: 'thread-A',
  });
  return session;
}

describe('§26 — no interaction provider is never consent', () => {
  it('parks the session and does not approve when no provider is available', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    // Simulate Discord being down at the moment Copilot asks.
    harness.provider.isAvailable = false;

    const session = await startGatedTurn(harness);

    await waitFor(() => harness!.approvals.pendingCount(session.id) === 1, {
      label: 'approval recorded despite no provider',
    });

    // The session parks, exactly as the spec requires.
    expect(harness.sessions.findById(session.id)!.status).toBe('WaitingForApproval');

    // Nothing was rendered, and crucially nothing was approved.
    expect(harness.provider.approvals).toHaveLength(0);
    expect(harness.provider.resolutions).toHaveLength(0);

    // Give the agent ample opportunity to misbehave.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.provider.text).not.toContain('SECOND-STEP-RAN');
    expect(harness.provider.completions).toHaveLength(0);
  });

  it('lets the work resume when the provider returns and someone approves', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    harness.provider.isAvailable = false;

    const session = await startGatedTurn(harness);
    await waitFor(() => harness!.approvals.pendingCount(session.id) === 1, { label: 'parked approval' });

    // Discord comes back; the operator uses /approve on the parked request.
    harness.provider.isAvailable = true;
    const pending = harness.approvals.listPending(session.id)[0]!;
    const result = await harness.approvals.resolve(pending.id, 'approve', 'user-1');
    expect(result.ok).toBe(true);

    await waitFor(() => harness!.provider.text.includes('SECOND-STEP-RAN'), {
      label: 'turn resumed after late approval',
    });
    expect(harness.sessions.findById(session.id)!.status).toBe('Running');
  });
});

describe('§41 — expiry never approves', () => {
  it('marks the request Expired, leaves Copilot blocked, and honours a late click', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED, approvalTimeoutMs: 250 });

    const session = await startGatedTurn(harness);
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval shown' });

    // Let it lapse.
    await waitFor(() => harness!.provider.resolutions.some((r) => r.status === 'Expired'), {
      label: 'expiry',
    });

    // Expiry is bookkeeping only: the gated step must not have run.
    expect(harness.provider.text).not.toContain('SECOND-STEP-RAN');
    expect(harness.sessions.findById(session.id)!.status).toBe('WaitingForApproval');

    // §41: the session waits until the user resolves it explicitly. A late
    // click still counts.
    const approvalId = harness.provider.approvals[0]!.approval.id;
    const result = await harness.approvals.resolve(approvalId, 'approve', 'user-1');
    expect(result.ok).toBe(true);

    await waitFor(() => harness!.provider.text.includes('SECOND-STEP-RAN'), {
      label: 'late approval honoured',
    });
  });

  it('/cancel unblocks an expired request instead of leaving Copilot wedged', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED, approvalTimeoutMs: 200 });

    const session = await startGatedTurn(harness);
    await waitFor(() => harness!.provider.resolutions.some((r) => r.status === 'Expired'), {
      label: 'expiry',
    });

    const result = await harness.commands.cancel(session.id);
    expect(result.ok).toBe(true);
    expect(harness.sessions.findById(session.id)!.status).toBe('Cancelled');
    expect(harness.provider.text).not.toContain('SECOND-STEP-RAN');
  });
});

describe('policy decisions', () => {
  it('rejects a deny-listed command without ever asking a human', async () => {
    const guarded = makeProject({
      id: 'backend',
      security: { denyPatterns: [/dotnet\s+test/i] } as never,
    });
    harness = await createHarness({ projects: [guarded], scenario: GATED });

    await harness.orchestrator.handleUserMessage({
      project: guarded,
      providerId: 'fake',
      text: 'go',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });

    // Copilot is told no immediately, and the turn continues past it.
    await waitFor(() => harness!.provider.text.includes('Blocked by project policy'), {
      label: 'policy block reported',
    });
    // No approval was ever put to a user.
    expect(harness.provider.approvals).toHaveLength(0);
  });

  it('auto-approves only when require_approval is explicitly false', async () => {
    const sandbox = makeProject({
      id: 'backend',
      security: { requireApproval: false } as never,
    });
    harness = await createHarness({ projects: [sandbox], scenario: GATED });

    await harness.orchestrator.handleUserMessage({
      project: sandbox,
      providerId: 'fake',
      text: 'go',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });

    await waitFor(() => harness!.provider.text.includes('SECOND-STEP-RAN'), {
      label: 'auto-approved run',
    });
    expect(harness.provider.approvals).toHaveLength(0);
  });

  it('does not offer "always allow" unless the project opts in', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    harness.provider.autoDecision = 'approve';

    await startGatedTurn(harness);
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval' });
    expect(harness.provider.approvals[0]!.offerAlwaysAllow).toBe(false);
  });

  it('offers "always allow" when the project opts in', async () => {
    const permissive = makeProject({ id: 'backend', security: { allowAlways: true } as never });
    harness = await createHarness({ projects: [permissive], scenario: GATED });
    harness.provider.autoDecision = 'approve';

    await harness.orchestrator.handleUserMessage({
      project: permissive,
      providerId: 'fake',
      text: 'go',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval' });
    // The fake agent offers allow_always, and the project permits showing it.
    expect(harness.provider.approvals[0]!.offerAlwaysAllow).toBe(true);
  });
});

describe('§25 — approvals are scoped to their project and session', () => {
  it('refuses a resolution claiming the wrong project', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    const session = await startGatedTurn(harness);
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval' });

    const approvalId = harness.provider.approvals[0]!.approval.id;
    const wrong = await harness.approvals.resolve(approvalId, 'approve', 'attacker', {
      expectProjectId: 'some-other-project',
    });
    expect(wrong).toEqual({ ok: false, reason: 'wrong-scope' });

    // Still pending, still blocked.
    expect(harness.approvals.pendingCount(session.id)).toBe(1);
    expect(harness.provider.text).not.toContain('SECOND-STEP-RAN');
  });

  it('refuses a resolution claiming the wrong session', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    await startGatedTurn(harness);
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval' });

    const approvalId = harness.provider.approvals[0]!.approval.id;
    expect(
      await harness.approvals.resolve(approvalId, 'approve', 'attacker', {
        expectSessionId: 'not-this-session',
      }),
    ).toEqual({ ok: false, reason: 'wrong-scope' });
  });

  it('resolves only once, so a double click cannot flip a decision', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: GATED });
    await startGatedTurn(harness);
    await waitFor(() => harness!.provider.approvals.length === 1, { label: 'approval' });

    const approvalId = harness.provider.approvals[0]!.approval.id;
    expect((await harness.approvals.resolve(approvalId, 'approve', 'user-1')).ok).toBe(true);
    expect(await harness.approvals.resolve(approvalId, 'reject', 'user-2')).toEqual({
      ok: false,
      reason: 'already-resolved',
    });
  });
});

describe('§39 — failures are reported, not hidden', () => {
  it('reports a Copilot crash and fails the session', async () => {
    harness = await createHarness({
      projects: [PROJECT],
      scenario: { steps: [{ type: 'crash', code: 7 }] },
    });

    const session = await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'go',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });

    await waitFor(() => harness!.provider.errors.length >= 1, { label: 'error report' });
    expect(harness.provider.errors[0]!.reason).toMatch(/exited unexpectedly/);
    expect(harness.sessions.findById(session.id)!.status).toBe('Failed');
  });

  it('reports an invalid project path instead of launching Copilot anyway', async () => {
    const broken = makeProject({ id: 'backend', path: 'D:/definitely/not/here' });
    harness = await createHarness({ projects: [broken], scenario: { steps: [] } });

    await harness.orchestrator.handleUserMessage({
      project: broken,
      providerId: 'fake',
      text: 'go',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });

    await waitFor(() => harness!.provider.errors.length >= 1, { label: 'path error' });
    expect(harness.provider.errors[0]!.reason).toMatch(/does not exist/);
    expect(harness.processes.countActive('backend')).toBe(0);
  });

  it('refuses to exceed the per-project concurrency cap', async () => {
    harness = await createHarness({
      projects: [PROJECT],
      scenario: { steps: [{ type: 'message', text: 'hi', delayMs: 400 }] },
      maxConcurrentPerProject: 1,
    });

    await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'first',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });
    await waitFor(() => harness!.processes.countActive('backend') === 1, { label: 'first process' });

    await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'second',
      author: 'user-1',
      discordThreadId: 'thread-B',
    });

    await waitFor(() => harness!.provider.errors.some((e) => /maximum/.test(e.reason)), {
      label: 'capacity refusal',
    });
    expect(harness.processes.countActive('backend')).toBe(1);
  });
});

describe('session lifecycle (§11, §33)', () => {
  it('refuses to resurrect a cancelled session', async () => {
    harness = await createHarness({ projects: [PROJECT], scenario: { steps: [] } });
    const session = harness.sessions.create({ project: PROJECT, providerId: 'fake', title: 'T' });

    expect(harness.sessions.setStatus(session.id, 'Cancelled')).toBe(true);
    expect(harness.sessions.setStatus(session.id, 'Running')).toBe(false);
    expect(harness.sessions.findById(session.id)!.status).toBe('Cancelled');
  });

  it('/reset retires the session and lets the thread start a fresh one, keeping memory', async () => {
    harness = await createHarness({
      projects: [PROJECT],
      scenario: { steps: [{ type: 'message', text: 'done' }] },
    });
    harness.memory.addDirect('backend', 'Tests use xUnit', 'stack', 'user-1');

    const first = await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'task one',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });
    await waitFor(() => harness!.provider.completions.length >= 1, { label: 'first turn' });

    expect((await harness.commands.reset(first.id)).ok).toBe(true);
    expect(harness.sessions.findById(first.id)!.status).toBe('Completed');
    expect(harness.sessions.findActiveByThread('thread-A')).toBeNull();

    // The next message in the same thread opens a new session.
    const second = await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'task two',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });
    expect(second.id).not.toBe(first.id);

    // §33 — project memory survives a reset.
    expect(harness.memory.list('backend')).toHaveLength(1);
  });

  it('routes a follow-up message to the same session (§13)', async () => {
    harness = await createHarness({
      projects: [PROJECT],
      scenario: { steps: [{ type: 'message', text: 'ok' }] },
    });

    const first = await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'Fix the Redis timeout issue.',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });
    await waitFor(() => harness!.provider.completions.length >= 1, { label: 'first turn' });

    const second = await harness.orchestrator.handleUserMessage({
      project: PROJECT,
      providerId: 'fake',
      text: 'What did you find?',
      author: 'user-1',
      discordThreadId: 'thread-A',
    });

    // Same session, and the user never supplied an id.
    expect(second.id).toBe(first.id);
    await waitFor(() => harness!.provider.completions.length >= 2, { label: 'second turn' });
    // One Copilot process served both turns, so context is preserved.
    expect(harness.processes.countActive('backend')).toBe(1);
  });
});
