#!/usr/bin/env node
/**
 * A scriptable fake ACP agent, standing in for `copilot --acp` in tests.
 *
 * It speaks raw newline-delimited JSON-RPC rather than using the ACP SDK, so the
 * tests exercise our client against the actual wire format instead of against
 * another copy of the same library.
 *
 * The scenario is supplied as JSON in FAKE_ACP_SCENARIO:
 *
 *   {
 *     "steps": [
 *       { "type": "message", "text": "..." },
 *       { "type": "thought", "text": "..." },
 *       { "type": "usage", "used": 10, "size": 100 },
 *       { "type": "plan", "entries": [{ "content": "...", "status": "pending", "priority": "high" }] },
 *       { "type": "tool", "toolCallId": "t1", "title": "Run tests", "kind": "execute",
 *         "command": "dotnet test", "permission": "ask" | "none",
 *         "output": "42 passed" },
 *       { "type": "crash" },
 *       { "type": "unknown_update" }
 *     ],
 *     "stopReason": "end_turn",
 *     "failNewSession": false,
 *     "hangHandshake": false
 *   }
 */

const scenario = JSON.parse(process.env.FAKE_ACP_SCENARIO ?? '{"steps":[]}');
const sessionIdToIssue = scenario.sessionId ?? 'fake-session-0001';

let sessionId = null;
let nextRequestId = 1000;
let cancelled = false;
const pendingPermission = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(update) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function askPermission(toolCall) {
  const id = nextRequestId++;
  write({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      ],
    },
  });
  return new Promise((resolve) => pendingPermission.set(id, resolve));
}

async function runSteps() {
  for (const step of scenario.steps ?? []) {
    if (cancelled) break;

    switch (step.type) {
      case 'message':
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } });
        break;

      case 'thought':
        notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.text } });
        break;

      case 'usage':
        notify({ sessionUpdate: 'usage_update', used: step.used, size: step.size });
        break;

      case 'plan':
        notify({ sessionUpdate: 'plan', entries: step.entries });
        break;

      case 'title':
        notify({ sessionUpdate: 'session_info_update', title: step.title });
        break;

      // An update variant our parser does not know — it must be ignored, not fatal.
      case 'unknown_update':
        notify({ sessionUpdate: 'available_commands_update', availableCommands: [] });
        break;

      case 'crash':
        process.exit(step.code ?? 1);
        break;

      case 'tool': {
        const rawInput = step.command ? { command: step.command } : (step.rawInput ?? {});
        const toolCall = {
          toolCallId: step.toolCallId ?? 't1',
          title: step.title ?? 'Do a thing',
          kind: step.kind ?? 'execute',
          status: 'pending',
          rawInput,
          ...(step.locations ? { locations: step.locations } : {}),
        };

        notify({ sessionUpdate: 'tool_call', ...toolCall });

        let allowed = true;
        if (step.permission === 'ask') {
          // Blocks here until the client answers, or until session/cancel
          // resolves it as cancelled — mirroring the real agent's behaviour.
          const outcome = await askPermission(toolCall);
          if (outcome?.outcome === 'cancelled') {
            cancelled = true;
            allowed = false;
          } else {
            allowed = outcome?.optionId?.startsWith('allow') ?? false;
          }
        }

        if (cancelled) break;

        notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: allowed ? 'completed' : 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: allowed ? (step.output ?? 'ok') : 'Permission denied by user.',
              },
            },
          ],
        });

        if (!allowed && step.onRejectMessage) {
          notify({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: step.onRejectMessage },
          });
        }
        break;
      }

      default:
        break;
    }

    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleLine(line);
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // A response to our permission request.
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingPermission.get(message.id);
    if (resolve) {
      pendingPermission.delete(message.id);
      resolve(message.result?.outcome ?? { outcome: 'cancelled' });
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      if (scenario.hangHandshake) return;
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, embeddedContext: true },
            sessionCapabilities: { close: {}, list: {} },
          },
          agentInfo: { name: 'FakeCopilot', title: 'FakeCopilot', version: '0.0.1' },
          authMethods: [],
        },
      });
      return;

    case 'session/new':
      if (scenario.failNewSession) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'auth_required' },
        });
        return;
      }
      sessionId = sessionIdToIssue;
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      return;

    case 'session/load':
      sessionId = message.params?.sessionId ?? sessionIdToIssue;
      write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;

    case 'session/prompt': {
      cancelled = false;
      await runSteps();
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: { stopReason: cancelled ? 'cancelled' : (scenario.stopReason ?? 'end_turn') },
      });
      return;
    }

    case 'session/cancel':
      cancelled = true;
      // ACP: after cancel, outstanding permission requests resolve as cancelled.
      for (const [id, resolve] of pendingPermission) {
        pendingPermission.delete(id);
        resolve({ outcome: 'cancelled' });
      }
      return;

    case 'session/close':
      write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;

    default:
      if (message.id !== undefined) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
      }
  }
}
