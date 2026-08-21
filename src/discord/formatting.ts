import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from 'discord.js';

import type { RiskLevel } from '../approval/models.js';
import type {
  ApprovalPrompt,
  ApprovalResolution,
  MemoryApprovalPrompt,
} from '../interaction/provider.js';

/** Discord's hard per-message limit. */
export const DISCORD_MESSAGE_LIMIT = 2000;

export const APPROVAL_BUTTON_PREFIX = 'apv';
export const MEMORY_BUTTON_PREFIX = 'mem';

const RISK_COLORS: Record<RiskLevel, number> = {
  low: 0x2b9348,
  medium: 0xe9c46a,
  high: 0xe63946,
  blocked: 0x6c757d,
};

const RISK_LABELS: Record<RiskLevel, string> = {
  low: '🟢 Low risk',
  medium: '🟡 Needs approval',
  high: '🔴 HIGH RISK — destructive',
  blocked: '⛔ Blocked by policy',
};

/**
 * Splits text into Discord-sized pieces, preferring to break at paragraph then
 * line boundaries so code blocks and lists survive (§28).
 */
export function chunkText(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Fences a command for display, guarding against backtick injection. */
function codeBlock(content: string, language = ''): string {
  const safe = content.replace(/```/g, '`​``');
  return `\`\`\`${language}\n${safe}\n\`\`\``;
}

export function buildApprovalEmbed(prompt: ApprovalPrompt): EmbedBuilder {
  const { approval } = prompt;
  const fields: APIEmbedField[] = [
    { name: 'Action', value: approval.actionType.replace(/_/g, ' '), inline: true },
    { name: 'Project', value: prompt.projectName, inline: true },
    { name: 'Session', value: prompt.sessionTitle || '(untitled)', inline: true },
  ];

  if (approval.riskReason) {
    fields.push({ name: 'Why this matters', value: approval.riskReason });
  }
  if (approval.target) {
    fields.push({ name: 'Target', value: `\`${approval.target}\`` });
  }

  const embed = new EmbedBuilder()
    .setTitle(
      approval.riskLevel === 'high'
        ? '🚨 Copilot Action Approval — destructive'
        : '⚠️ Copilot Action Approval',
    )
    .setColor(RISK_COLORS[approval.riskLevel])
    .setDescription(
      `${RISK_LABELS[approval.riskLevel]}\n\n` +
        (approval.command ? codeBlock(approval.command, 'bash') : `**${approval.description}**`),
    )
    .addFields(fields)
    .setFooter({ text: `id ${approval.id.slice(0, 8)} · expires ${relativeTime(prompt.expiresAt)}` });

  return embed;
}

export function buildApprovalButtons(prompt: ApprovalPrompt): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const id = prompt.approval.id;

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${APPROVAL_BUTTON_PREFIX}:approve:${id}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(prompt.approval.riskLevel === 'high' ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${APPROVAL_BUTTON_PREFIX}:reject:${id}`)
      .setLabel('Reject')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary),
  );

  // Only offered when the project explicitly opted in — see the note in the
  // config schema on why this is off by default.
  if (prompt.offerAlwaysAllow) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVAL_BUTTON_PREFIX}:approve_always:${id}`)
        .setLabel('Always allow')
        .setStyle(ButtonStyle.Primary),
    );
  }

  return row;
}

/** Rebuilds the embed for a resolved request, with controls disabled (§24). */
export function buildResolvedApproval(
  prompt: ApprovalPrompt,
  resolution: ApprovalResolution,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> | null } {
  const { approval } = prompt;
  const outcome = describeResolution(resolution);

  const embed = new EmbedBuilder()
    .setTitle(outcome.title)
    .setColor(outcome.color)
    .setDescription(
      (approval.command ? codeBlock(approval.command, 'bash') : `**${approval.description}**`) +
        `\n\n${outcome.line}`,
    )
    .addFields(
      { name: 'Project', value: prompt.projectName, inline: true },
      { name: 'Session', value: prompt.sessionTitle || '(untitled)', inline: true },
    )
    .setFooter({ text: `id ${approval.id.slice(0, 8)}` });

  // Expired is not resolved: leave the buttons live so a late click still lands.
  if (resolution.status === 'Expired') {
    return { embed, row: buildApprovalButtons(prompt) };
  }
  return { embed, row: null };
}

function describeResolution(resolution: ApprovalResolution): {
  title: string;
  color: number;
  line: string;
} {
  const by = resolution.resolvedBy ? ` by ${resolution.resolvedBy}` : '';
  switch (resolution.status) {
    case 'Approved':
      return {
        title: resolution.decision === 'approve_always' ? '✅ Always allowed' : '✅ Approved',
        color: 0x2b9348,
        line: `✅ Approved${by}`,
      };
    case 'Rejected':
      return { title: '❌ Rejected', color: 0xe63946, line: `❌ Rejected${by}` };
    case 'Expired':
      return {
        title: '⏱️ Approval expired',
        color: 0x6c757d,
        line:
          '⏱️ This request timed out and was **not** approved. ' +
          'The session is still waiting — you can still approve or reject below, or run `/cancel`.',
      };
    case 'Cancelled':
      return { title: '🛑 Cancelled', color: 0x6c757d, line: `🛑 Cancelled${by}` };
    default:
      return { title: 'Approval', color: 0x6c757d, line: resolution.status };
  }
}

export function buildMemoryEmbed(prompt: MemoryApprovalPrompt): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🧠 Project Memory Request')
    .setColor(0x4361ee)
    .setDescription(`Copilot wants to remember:\n\n> ${prompt.content}`)
    .addFields(
      { name: 'Project', value: prompt.projectName, inline: true },
      { name: 'Category', value: prompt.category, inline: true },
    )
    .setFooter({ text: 'Shared with every session in this project' });
}

export function buildMemoryButtons(prompt: MemoryApprovalPrompt): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MEMORY_BUTTON_PREFIX}:approve:${prompt.requestId}`)
      .setLabel('Remember')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${MEMORY_BUTTON_PREFIX}:reject:${prompt.requestId}`)
      .setLabel('Discard')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildResolvedMemory(
  prompt: MemoryApprovalPrompt,
  approved: boolean,
  by: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(approved ? '🧠 Saved to project memory' : '🧠 Not saved')
    .setColor(approved ? 0x2b9348 : 0x6c757d)
    .setDescription(`> ${prompt.content}\n\n${approved ? '✅ Approved' : '❌ Rejected'} by ${by}`);
}

/** Discord relative timestamp, e.g. "in 30 minutes". */
function relativeTime(iso: string): string {
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${seconds}:R>`;
}

/** Derives a thread name from the first message (§12). */
export function deriveThreadName(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? 'Copilot task';
  const cleaned = firstLine.replace(/[`*_~|]/g, '').trim();
  if (cleaned.length === 0) return 'Copilot task';
  // Discord caps thread names at 100 characters.
  return cleaned.length <= 90 ? cleaned : `${cleaned.slice(0, 89)}…`;
}
