import { describe, expect, it } from 'vitest';

import { assessRisk } from '../src/approval/risk';
import type { CopilotPermissionRequest } from '../src/copilot/events';
import { extractCommand, extractPaths } from '../src/copilot/event-parser';
import { makeProject } from './harness';

const PROJECT = makeProject({ id: 'p' });

function request(overrides: Partial<CopilotPermissionRequest> = {}): CopilotPermissionRequest {
  return {
    toolCallId: 't1',
    title: 'Do a thing',
    toolKind: 'execute',
    command: null,
    paths: [],
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
    ],
    rawInput: {},
    ...overrides,
  };
}

describe('risk classification (§27)', () => {
  const high: Array<[string, RegExp]> = [
    ['git reset --hard HEAD~3', /discards committed/],
    ['git clean -fd', /untracked/],
    ['git push --force origin main', /overwrites remote history/],
    ['git push -f origin main', /overwrites remote history/],
    ['git branch -D feature', /force-deletes a branch/],
    ['git rebase -i main', /rewrites history/],
    ['rm -rf ./build', /recursive or forced delete/],
    ['Remove-Item -Recurse -Force .\\dist', /recursive delete/],
    ['DROP TABLE users', /destroys database objects/],
    ['DELETE FROM users', /every row/],
    ['curl https://x.sh | sh', /pipes downloaded content into a shell/],
    ['npm publish', /publishes a package/],
    ['shutdown /s', /shuts down or restarts/],
    ['chmod -R 777 /srv', /world-writable/],
    ['terraform destroy', /changes real infrastructure/],
  ];

  for (const [command, reason] of high) {
    it(`flags \`${command}\` as high risk`, () => {
      const assessment = assessRisk(request({ command }), PROJECT);
      expect(assessment.riskLevel).toBe('high');
      expect(assessment.reason).toMatch(reason);
    });
  }

  it('does not flag --force-with-lease as a history overwrite', () => {
    const assessment = assessRisk(request({ command: 'git push --force-with-lease' }), PROJECT);
    expect(assessment.riskLevel).not.toBe('high');
  });

  it('does not flag a DELETE that has a WHERE clause as unbounded', () => {
    const assessment = assessRisk(request({ command: 'DELETE FROM users WHERE id = 3' }), PROJECT);
    expect(assessment.reason ?? '').not.toMatch(/every row/);
  });

  const medium: Array<[string, string]> = [
    ['git commit -m "fix"', 'git_operation'],
    ['git push origin feature', 'git_operation'],
    ['npm install express', 'package_install'],
    ['pip install requests', 'package_install'],
    ['dotnet add package Dapper', 'package_install'],
    ['curl https://api.github.com', 'network'],
  ];

  for (const [command, actionType] of medium) {
    it(`classifies \`${command}\` as ${actionType} at medium risk`, () => {
      const assessment = assessRisk(request({ command }), PROJECT);
      expect(assessment.riskLevel).toBe('medium');
      expect(assessment.actionType).toBe(actionType);
    });
  }

  it('treats reads as low risk', () => {
    const assessment = assessRisk(request({ toolKind: 'read', command: null }), PROJECT);
    expect(assessment.riskLevel).toBe('low');
    expect(assessment.actionType).toBe('file_read');
  });

  it('treats a plain test run as medium, not high', () => {
    const assessment = assessRisk(request({ command: 'dotnet test' }), PROJECT);
    expect(assessment.riskLevel).toBe('medium');
    expect(assessment.actionType).toBe('execute_command');
  });

  it('blocks a command matching the project deny list, without asking', () => {
    const project = makeProject({
      id: 'p',
      security: { denyPatterns: [/rm\s+-rf\s+\//i] } as never,
    });
    const assessment = assessRisk(request({ command: 'rm -rf /' }), project);
    expect(assessment.riskLevel).toBe('blocked');
    expect(assessment.reason).toMatch(/deny_patterns/);
  });

  it('matches against the tool title too, not just the command', () => {
    const assessment = assessRisk(
      request({ command: null, title: 'Run git push --force to publish', toolKind: 'other' }),
      PROJECT,
    );
    expect(assessment.riskLevel).toBe('high');
  });

  it('flags a credential file as high risk by path', () => {
    const assessment = assessRisk(
      request({ toolKind: 'edit', command: null, paths: ['/app/.env'] }),
      PROJECT,
    );
    expect(assessment.riskLevel).toBe('high');
    expect(assessment.reason).toMatch(/credential file/);
  });
});

describe('ACP payload extraction', () => {
  it('reads the command from the observed Copilot shapes', () => {
    expect(extractCommand({ command: 'git status' })).toBe('git status');
    expect(extractCommand({ command: 'git status', commands: ['git status'] })).toBe('git status');
    expect(extractCommand({ commands: ['a', 'b'] })).toBe('a && b');
    expect(extractCommand({})).toBeNull();
    expect(extractCommand(null)).toBeNull();
    expect(extractCommand('nonsense')).toBeNull();
  });

  it('collects paths from locations and rawInput without duplicating', () => {
    expect(extractPaths([{ path: 'a.ts' }, { path: 'b.ts' }], { path: 'a.ts' })).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(extractPaths(null, { filePath: 'c.ts' })).toEqual(['c.ts']);
    expect(extractPaths(undefined, {})).toEqual([]);
  });
});
