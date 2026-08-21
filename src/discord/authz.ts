import type { GuildMember, User } from 'discord.js';

import type { ProjectConfig } from '../config/types.js';

/**
 * Who is asking, reduced to what authorization needs (spec §25).
 *
 * Both role ids and role names are captured because `allowed_roles` in the
 * config is far more pleasant to write as `"Developer"` than as a snowflake,
 * and supporting only one of the two would quietly ignore half of people's
 * configuration.
 */
export interface Actor {
  readonly id: string;
  readonly displayName: string;
  readonly roleIds: readonly string[];
  readonly roleNames: readonly string[];
}

export function actorFromMember(member: GuildMember | null, user: User): Actor {
  return {
    id: user.id,
    displayName: member?.displayName ?? user.username,
    roleIds: member ? [...member.roles.cache.keys()] : [],
    roleNames: member ? member.roles.cache.map((role) => role.name) : [],
  };
}

/**
 * Whether this actor may drive and approve work in this project.
 *
 * Fails closed by construction: the config loader refuses to start a
 * Discord-enabled project with both lists empty, so an empty policy here can
 * only mean a non-Discord project, and returning false is correct.
 */
export function isAuthorized(project: ProjectConfig, actor: Actor): boolean {
  const { allowedUsers, allowedRoles } = project.security;

  if (allowedUsers.has(actor.id)) return true;
  for (const roleId of actor.roleIds) {
    if (allowedRoles.has(roleId)) return true;
  }
  for (const roleName of actor.roleNames) {
    if (allowedRoles.has(roleName)) return true;
  }
  return false;
}

export function describeDenial(project: ProjectConfig): string {
  return (
    `You are not authorized to control Copilot for **${project.name}**.\n` +
    `Ask whoever runs the Bridge to add you to \`security.allowed_users\` or a role in ` +
    `\`security.allowed_roles\` for this project.`
  );
}
