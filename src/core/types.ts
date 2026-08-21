/** Core domain types. Deliberately free of any Discord or ACP types (§8 core principle). */

/** Session states from spec §10/§11. */
export const SESSION_STATUSES = [
  'Created',
  'Running',
  'WaitingForApproval',
  'Completed',
  'Failed',
  'Cancelled',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** States a session can still be driven from; cancellation is legal from any of these (§11). */
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = [
  'Created',
  'Running',
  'WaitingForApproval',
];

export function isActiveStatus(status: SessionStatus): boolean {
  return ACTIVE_SESSION_STATUSES.includes(status);
}

/**
 * A Session — one independent unit of Copilot work, bound 1:1 to a Discord
 * thread when Discord is in play (§9), or standalone under the CLI provider.
 */
export interface Session {
  readonly id: string;
  readonly projectId: string;
  /** Human label, e.g. the thread name "Fix Redis timeout". Used by /status. */
  title: string;
  /** Which interaction provider owns the conversation for this session. */
  readonly providerId: string;
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordThreadId: string | null;
  /** ACP session id returned by `session/new`. Null until Copilot starts. */
  copilotSessionId: string | null;
  copilotProcessId: number | null;
  status: SessionStatus;
  readonly createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'agent' | 'thought' | 'tool' | 'system';

export interface StoredMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

/** A durable fact about a Project (§17, §18). Shared by every session in the project. */
export interface MemoryEntry {
  readonly id: string;
  readonly projectId: string;
  readonly content: string;
  readonly category: string;
  readonly createdAt: string;
  /** Who approved persisting it (§20). */
  readonly approvedBy: string;
}

/** Addresses the conversation a session belongs to, for the interaction layer. */
export interface ConversationRef {
  readonly providerId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly guildId?: string | null;
  readonly channelId?: string | null;
  readonly threadId?: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
