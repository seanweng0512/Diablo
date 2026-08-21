import type { OutputConfig } from '../config/types.js';
import type { ToolCallSummary } from '../copilot/events.js';
import type { IInteractionProvider } from '../interaction/provider.js';
import type { Logger } from '../util/logger.js';
import type { ConversationRef } from './types.js';

/**
 * Turns Copilot's token-level stream into readable messages (spec §28, §29).
 *
 * Copilot emits `agent_message_chunk` a few characters at a time and a
 * `tool_call` for every action. Forwarding each one would be unusable in
 * Discord and would hit rate limits immediately, so this buffers and coalesces:
 * text accumulates, tool activity becomes one progress line, and the whole
 * buffer is flushed on a short debounce or when it gets long.
 */

const TOOL_ICONS: Record<string, string> = {
  read: '🔍',
  search: '🔍',
  edit: '✏️',
  move: '✏️',
  delete: '🗑️',
  execute: '🖥️',
  fetch: '🌐',
  think: '💭',
  switch_mode: '🔀',
  other: '🔧',
};

function iconFor(call: ToolCallSummary): string {
  if (call.toolKind === 'execute' && /\b(test|pytest|vitest|jest|xunit)\b/i.test(call.command ?? '')) {
    return '🧪';
  }
  return TOOL_ICONS[call.toolKind] ?? '🔧';
}

/** One line describing what Copilot just started doing. */
export function renderToolLine(call: ToolCallSummary): string {
  const icon = iconFor(call);
  if (call.command) {
    return `${icon} \`${truncate(call.command, 180)}\``;
  }
  const target = call.paths[0];
  return target ? `${icon} ${call.title} — \`${target}\`` : `${icon} ${call.title}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface SessionReporterOptions {
  readonly ref: ConversationRef;
  readonly output: OutputConfig;
  readonly logger: Logger;
  /** Resolved late, so a provider that reconnects is picked up automatically. */
  readonly getProvider: () => IInteractionProvider | null;
}

export class SessionReporter {
  /** Rendered blocks awaiting delivery, oldest first. */
  private readonly blocks: string[] = [];
  /** Partial agent prose, accumulated from chunks. */
  private prose = '';
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private toolCalls = 0;
  private lastToolLine: string | null = null;
  private currentAction: string | null = null;

  constructor(private readonly options: SessionReporterOptions) {}

  get toolCallCount(): number {
    return this.toolCalls;
  }

  /** What /status should report as the current activity (§31). */
  get action(): string | null {
    return this.currentAction;
  }

  appendAgentText(text: string): void {
    if (!text) return;
    this.prose += text;
    this.scheduleFlush();
  }

  appendThought(text: string): void {
    if (!this.options.output.showThoughts || !text) return;
    this.prose += text;
    this.scheduleFlush();
  }

  toolStarted(call: ToolCallSummary): void {
    this.toolCalls += 1;
    this.currentAction = call.command ?? call.title;

    const line = renderToolLine(call);
    // Copilot re-announces a call when its status changes; don't repeat ourselves.
    if (line === this.lastToolLine) return;
    this.lastToolLine = line;

    this.sealProse();
    this.blocks.push(line);
    this.scheduleFlush();
  }

  toolFailed(title: string, output: string | null): void {
    this.sealProse();
    this.blocks.push(`⚠️ ${title} failed${output ? `\n\`\`\`\n${truncate(output, 600)}\n\`\`\`` : ''}`);
    this.scheduleFlush();
  }

  system(text: string): void {
    this.sealProse();
    this.blocks.push(text);
    this.scheduleFlush();
  }

  clearAction(): void {
    this.currentAction = null;
  }

  /** Delivers everything buffered, waiting for any in-flight send to finish. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sealProse();

    if (this.blocks.length === 0) {
      await this.flushing;
      return;
    }

    const payload = this.blocks.join('\n\n').trim();
    this.blocks.length = 0;
    if (!payload) {
      await this.flushing;
      return;
    }

    const send = async (): Promise<void> => {
      const provider = this.options.getProvider();
      if (!provider) {
        // Nothing to deliver to. Log it rather than silently dropping Copilot's work.
        this.options.logger.warn(
          `no provider available; dropping ${payload.length} chars of output for session ${this.options.ref.sessionId}`,
        );
        return;
      }
      try {
        const tooLong = payload.length > this.options.output.attachThresholdChars;
        await provider.sendMessage(this.options.ref, {
          kind: 'agent',
          text: payload,
          ...(tooLong ? { attachmentName: 'copilot-output.md' } : {}),
        });
      } catch (error) {
        this.options.logger.warn('failed to deliver output', error);
      }
    };

    this.flushing = this.flushing.then(send, send);
    await this.flushing;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private sealProse(): void {
    const text = this.prose.trim();
    this.prose = '';
    if (text) this.blocks.push(text);
  }

  private scheduleFlush(): void {
    const pendingChars = this.prose.length + this.blocks.reduce((n, b) => n + b.length + 2, 0);
    if (pendingChars >= this.options.output.maxMessageChars) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.output.flushIntervalMs);
    this.timer.unref();
  }
}
