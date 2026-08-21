import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
} from '@agentclientprotocol/sdk';

import type {
  CopilotEvent,
  CopilotPermissionOption,
  CopilotPermissionRequest,
  PlanEntrySummary,
  ToolCallSummary,
} from './events.js';

/** Renders a content block as plain text for Discord/CLI display. */
export function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    case 'resource': {
      const resource = block.resource as { text?: string; uri?: string } | undefined;
      if (resource && typeof resource.text === 'string') return resource.text;
      return `[resource${resource?.uri ? ` ${resource.uri}` : ''}]`;
    }
    default: {
      // A new ContentBlock variant appeared; show something rather than nothing.
      const exhaustive: never = block;
      return `[unsupported content ${JSON.stringify((exhaustive as { type?: unknown }).type)}]`;
    }
  }
}

function toolCallContentToText(items: readonly ToolCallContent[] | null | undefined): string | null {
  if (!items || items.length === 0) return null;
  const parts: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case 'content':
        parts.push(contentBlockToText(item.content));
        break;
      case 'diff': {
        const added = item.newText.split('\n').length;
        const removed = item.oldText ? item.oldText.split('\n').length : 0;
        parts.push(`diff ${item.path} (+${added}/-${removed} lines)`);
        break;
      }
      case 'terminal':
        parts.push(`[terminal ${item.terminalId}]`);
        break;
      default: {
        const exhaustive: never = item;
        parts.push(`[unsupported tool content ${JSON.stringify((exhaustive as { type?: unknown }).type)}]`);
      }
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Pulls the shell command out of a tool call's `rawInput`.
 *
 * Observed shapes from Copilot CLI 1.0.80: `{command: "git status"}` on the
 * `tool_call` notification and `{command: "...", commands: ["..."]}` on the
 * matching permission request. Anything else yields null, and the caller falls
 * back to the tool call title.
 */
export function extractCommand(rawInput: unknown): string | null {
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const input = rawInput as { command?: unknown; commands?: unknown };

  if (typeof input.command === 'string' && input.command.trim().length > 0) {
    return input.command.trim();
  }
  if (Array.isArray(input.commands)) {
    const commands = input.commands.filter((c): c is string => typeof c === 'string');
    if (commands.length > 0) return commands.join(' && ');
  }
  return null;
}

/** Best-effort file path for edit/read/delete style calls. */
export function extractPaths(
  locations: readonly ToolCallLocation[] | null | undefined,
  rawInput: unknown,
): string[] {
  const paths = new Set<string>();
  for (const location of locations ?? []) {
    if (location.path) paths.add(location.path);
  }
  if (typeof rawInput === 'object' && rawInput !== null) {
    const input = rawInput as { path?: unknown; filePath?: unknown; file_path?: unknown };
    for (const candidate of [input.path, input.filePath, input.file_path]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) paths.add(candidate.trim());
    }
  }
  return [...paths];
}

/**
 * Translates one ACP `session/update` into a domain event.
 *
 * The switch is exhaustive over all thirteen `sessionUpdate` variants and ends
 * in a `never` assignment, so adding a fourteenth becomes a compile error here
 * rather than a silently dropped event at runtime.
 */
export function parseSessionUpdate(update: SessionUpdate): CopilotEvent {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { kind: 'message', text: contentBlockToText(update.content) };

    case 'agent_thought_chunk':
      return { kind: 'thought', text: contentBlockToText(update.content) };

    case 'user_message_chunk':
      return { kind: 'echo', text: contentBlockToText(update.content) };

    case 'tool_call': {
      const call: ToolCallSummary = {
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.kind ?? 'other',
        status: update.status ?? 'pending',
        command: extractCommand(update.rawInput),
        paths: extractPaths(update.locations, update.rawInput),
        rawInput: update.rawInput,
      };
      return { kind: 'tool-started', call };
    }

    case 'tool_call_update':
      return {
        kind: 'tool-updated',
        toolCallId: update.toolCallId,
        status: update.status ?? null,
        title: update.title ?? null,
        output: toolCallContentToText(update.content),
      };

    case 'plan':
      return {
        kind: 'plan',
        entries: update.entries.map(
          (entry): PlanEntrySummary => ({
            content: entry.content,
            status: entry.status,
            priority: entry.priority,
          }),
        ),
      };

    case 'usage_update':
      return { kind: 'usage', used: update.used, size: update.size };

    case 'current_mode_update':
      return { kind: 'mode-changed', mode: String(update.currentModeId) };

    case 'session_info_update':
      return update.title
        ? { kind: 'title', title: update.title }
        : { kind: 'ignored', sessionUpdate: update.sessionUpdate };

    // Deliberately not surfaced: these describe the agent's own UI affordances
    // (slash commands, config menus) or unstable plan deltas, none of which the
    // Bridge renders. Listed explicitly so the exhaustiveness check stays honest.
    case 'available_commands_update':
    case 'config_option_update':
    case 'plan_update':
    case 'plan_removed':
      return { kind: 'ignored', sessionUpdate: update.sessionUpdate };

    default: {
      const exhaustive: never = update;
      return {
        kind: 'ignored',
        sessionUpdate: String((exhaustive as { sessionUpdate?: unknown }).sessionUpdate ?? 'unknown'),
      };
    }
  }
}

/** Normalizes a `session/request_permission` payload for the Approval Manager. */
export function parsePermissionRequest(params: RequestPermissionRequest): CopilotPermissionRequest {
  const toolCall = params.toolCall as
    | {
        toolCallId?: string;
        title?: string;
        kind?: CopilotPermissionRequest['toolKind'];
        rawInput?: unknown;
        locations?: readonly ToolCallLocation[] | null;
      }
    | undefined;

  const options: CopilotPermissionOption[] = params.options.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.name,
  }));

  return {
    toolCallId: toolCall?.toolCallId ?? null,
    title: toolCall?.title ?? 'Copilot action',
    toolKind: toolCall?.kind ?? null,
    command: extractCommand(toolCall?.rawInput),
    paths: extractPaths(toolCall?.locations, toolCall?.rawInput),
    options,
    rawInput: toolCall?.rawInput,
  };
}
