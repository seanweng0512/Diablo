#!/usr/bin/env node
/**
 * Manual smoke test against the REAL GitHub Copilot CLI.
 *
 * Deliberately not part of `npm test`: it needs a logged-in Copilot and spends
 * AI credits. Run it by hand to confirm Phase 1 end to end.
 *
 *   npm run build && node scripts/smoke-copilot.mjs
 *
 * It auto-approves, but prints every permission request first, so you can see
 * the interception point actually firing.
 */
import path from 'node:path';

import { CopilotAcpSession, buildCopilotArgs } from '../dist/copilot/acp-session.js';
import { createLogger } from '../dist/util/logger.js';

const cwd = process.argv[2] ?? process.cwd();
const prompt =
  process.argv[3] ??
  'Run the shell command `node --version` and tell me the output. Do it now, do not ask me anything first.';

let approvals = 0;

const session = new CopilotAcpSession({
  executable: 'copilot',
  args: buildCopilotArgs({}),
  cwd: path.resolve(cwd),
  env: {},
  startupTimeoutMs: 90_000,
  additionalDirectories: [],
  mcpServers: [],
  logger: createLogger('smoke'),
  handlers: {
    onEvent: (event) => {
      switch (event.kind) {
        case 'message':
          process.stdout.write(event.text);
          break;
        case 'tool-started':
          console.log(
            `\n[tool] ${event.call.title} (${event.call.toolKind})` +
              (event.call.command ? ` -> ${event.call.command}` : ''),
          );
          break;
        case 'tool-updated':
          if (event.status) console.log(`[tool ${event.toolCallId}] ${event.status}`);
          break;
        case 'usage':
          console.log(`\n[usage] ${event.used}/${event.size} tokens`);
          break;
        default:
          break;
      }
    },
    onPermissionRequest: async (request) => {
      approvals += 1;
      console.log('\n=== PERMISSION REQUESTED (this is the approval interception point) ===');
      console.log(`  title:   ${request.title}`);
      console.log(`  kind:    ${request.toolKind}`);
      console.log(`  command: ${request.command ?? '(none)'}`);
      console.log(`  paths:   ${request.paths.join(', ') || '(none)'}`);
      console.log(`  options: ${request.options.map((o) => `${o.optionId}(${o.kind})`).join(', ')}`);

      const allow = request.options.find((o) => o.kind === 'allow_once');
      if (!allow) {
        console.log('  -> no allow_once option; rejecting');
        const reject = request.options.find((o) => o.kind === 'reject_once');
        return reject ? { type: 'selected', optionId: reject.optionId } : { type: 'cancelled' };
      }
      console.log(`  -> auto-approving with ${allow.optionId}`);
      return { type: 'selected', optionId: allow.optionId };
    },
    onExit: (info) =>
      console.log(
        `\n[exit] code=${info.code} signal=${info.signal} expected=${info.expected}` +
          (info.stderrTail ? `\nstderr: ${info.stderrTail}` : ''),
      ),
  },
});

try {
  console.log(`Starting Copilot in ${path.resolve(cwd)} ...`);
  await session.start();
  console.log(`ACP session id: ${session.copilotSessionId} (pid ${session.pid})\n`);

  const result = await session.prompt(prompt);
  console.log(`\n\n--- stopReason: ${result.stopReason}; permission requests seen: ${approvals} ---`);

  if (approvals === 0) {
    console.log(
      'WARNING: Copilot ran without asking permission. Check that no --allow-all/--yolo flag leaked in.',
    );
  }
} finally {
  await session.dispose();
}
