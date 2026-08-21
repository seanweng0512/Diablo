import { AttachmentBuilder, type Message, type SendableChannels } from 'discord.js';

import { formatStatus } from '../core/commands.js';
import type { ConversationRef } from '../core/types.js';
import type {
  ApprovalPrompt,
  ApprovalResolution,
  CompletionReport,
  ErrorReport,
  IInteractionProvider,
  MemoryApprovalPrompt,
  OutboundMessage,
  StatusReport,
} from '../interaction/provider.js';
import type { Logger } from '../util/logger.js';
import {
  buildApprovalButtons,
  buildApprovalEmbed,
  buildMemoryButtons,
  buildMemoryEmbed,
  buildResolvedApproval,
  buildResolvedMemory,
  chunkText,
  DISCORD_MESSAGE_LIMIT,
} from './formatting.js';

export const DISCORD_PROVIDER_ID = 'discord';

/** What the provider needs from the gateway, kept narrow to avoid a cycle. */
export interface DiscordGateway {
  readonly isReady: boolean;
  resolveSendable(ref: ConversationRef): Promise<SendableChannels | null>;
}

/**
 * Renders the Bridge's output into Discord (spec §24, §28, §29).
 *
 * Notably it does *not* decide anything. Buttons pressed here are reported to
 * the Approval Manager, which owns the decision; this class only draws.
 */
export class DiscordInteractionProvider implements IInteractionProvider {
  readonly id = DISCORD_PROVIDER_ID;

  /** approvalId -> the message showing it, so it can be edited on resolution. */
  private readonly approvalMessages = new Map<string, Message>();
  private readonly memoryMessages = new Map<string, Message>();
  /** requestId -> prompt, so a button press can be matched back to its request. */
  private readonly memoryPrompts = new Map<string, MemoryApprovalPrompt>();
  /** Keeps sends to one channel in order, so streamed output does not interleave. */
  private readonly sendQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly logger: Logger,
  ) {}

  /**
   * False while the gateway is down.
   *
   * The Approval Manager reads this and parks the session rather than treating
   * an unreachable Discord as consent (§26, §40).
   */
  get isAvailable(): boolean {
    return this.gateway.isReady;
  }

  async sendMessage(target: ConversationRef, message: OutboundMessage): Promise<void> {
    await this.enqueue(target, async (channel) => {
      if (message.attachmentName) {
        // §28 — very long output becomes a file rather than a wall of messages.
        const file = new AttachmentBuilder(Buffer.from(message.text, 'utf8'), {
          name: message.attachmentName,
        });
        await channel.send({
          content: '📄 Copilot produced a long reply; attached in full.',
          files: [file],
        });
        return;
      }

      for (const chunk of chunkText(message.text, DISCORD_MESSAGE_LIMIT)) {
        await channel.send({ content: chunk });
      }
    });
  }

  async requestApproval(target: ConversationRef, prompt: ApprovalPrompt): Promise<void> {
    await this.enqueue(target, async (channel) => {
      const message = await channel.send({
        embeds: [buildApprovalEmbed(prompt)],
        components: [buildApprovalButtons(prompt)],
      });
      this.approvalMessages.set(prompt.approval.id, message);
    });
  }

  async updateApproval(
    target: ConversationRef,
    prompt: ApprovalPrompt,
    resolution: ApprovalResolution,
  ): Promise<void> {
    const message = this.approvalMessages.get(prompt.approval.id);
    const { embed, row } = buildResolvedApproval(prompt, resolution);

    // Expired requests stay actionable, so keep the handle; resolved ones do not.
    if (resolution.status !== 'Expired') {
      this.approvalMessages.delete(prompt.approval.id);
    }

    if (!message) {
      // The original message is gone (restart, or never rendered). Say what
      // happened in the channel rather than losing the audit trail entirely.
      await this.sendMessage(target, { kind: 'system', text: `**${resolution.status}** — ${prompt.approval.command ?? prompt.approval.description}` });
      return;
    }

    try {
      await message.edit({ embeds: [embed], components: row ? [row] : [] });
    } catch (error) {
      this.logger.warn('failed to edit approval message', error);
    }
  }

  async requestMemoryApproval(target: ConversationRef, prompt: MemoryApprovalPrompt): Promise<void> {
    this.memoryPrompts.set(prompt.requestId, prompt);
    await this.enqueue(target, async (channel) => {
      const message = await channel.send({
        embeds: [buildMemoryEmbed(prompt)],
        components: [buildMemoryButtons(prompt)],
      });
      this.memoryMessages.set(prompt.requestId, message);
    });
  }

  /** Looks up a rendered memory request, for matching a button press. */
  getMemoryPrompt(requestId: string): MemoryApprovalPrompt | null {
    return this.memoryPrompts.get(requestId) ?? null;
  }

  /** Called by the bot once a memory button has been handled. */
  async finishMemoryPrompt(
    prompt: MemoryApprovalPrompt,
    approved: boolean,
    by: string,
  ): Promise<void> {
    const message = this.memoryMessages.get(prompt.requestId);
    this.memoryMessages.delete(prompt.requestId);
    this.memoryPrompts.delete(prompt.requestId);
    if (!message) return;
    try {
      await message.edit({ embeds: [buildResolvedMemory(prompt, approved, by)], components: [] });
    } catch (error) {
      this.logger.warn('failed to edit memory message', error);
    }
  }

  async notifyStatus(target: ConversationRef, report: StatusReport): Promise<void> {
    await this.sendMessage(target, { kind: 'system', text: formatStatus(report) });
  }

  async notifyCompletion(target: ConversationRef, report: CompletionReport): Promise<void> {
    const icon = report.succeeded ? '🎉' : '⚠️';
    const actions = report.toolCallCount === 1 ? '1 action' : `${report.toolCallCount} actions`;
    await this.sendMessage(target, {
      kind: 'system',
      text: `${icon} **${report.summary}** — ${actions} taken.`,
    });
  }

  async notifyError(target: ConversationRef, report: ErrorReport): Promise<void> {
    await this.sendMessage(target, {
      kind: 'system',
      text:
        `❌ **${report.title}**\n\n` +
        `**Reason:**\n${report.reason}\n\n` +
        `**Session:** ${report.sessionTitle}` +
        (report.recoverable ? '\n\nSend another message to try again, or `/reset` to start fresh.' : ''),
    });
  }

  /** Forgets cached message handles for a session that has ended. */
  forgetApproval(approvalId: string): void {
    this.approvalMessages.delete(approvalId);
  }

  // -------------------------------------------------------------------------

  /**
   * Serializes work per conversation.
   *
   * Copilot streams, so several flushes can be in flight at once; without this
   * Discord would deliver them out of order and the transcript would not read
   * as a conversation.
   */
  private async enqueue(
    target: ConversationRef,
    work: (channel: SendableChannels) => Promise<void>,
  ): Promise<void> {
    const key = target.threadId ?? target.channelId ?? target.sessionId;

    const run = async (): Promise<void> => {
      const channel = await this.gateway.resolveSendable(target);
      if (!channel) {
        this.logger.warn(`cannot resolve a Discord channel for session ${target.sessionId}`);
        return;
      }
      try {
        await work(channel);
      } catch (error) {
        // Rate limits and transient 5xx surface here; discord.js already
        // retries, so anything reaching us is worth logging but not fatal (§39).
        this.logger.warn('Discord send failed', error);
      }
    };

    const previous = this.sendQueues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.sendQueues.set(key, next);
    await next;
    if (this.sendQueues.get(key) === next) this.sendQueues.delete(key);
  }
}
