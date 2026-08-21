import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { rootSchema } from './schema.js';
import type { RawProjectConfig } from './schema.js';
import { ConfigError } from './types.js';
import type { BridgeConfig, ProjectConfig } from './types.js';

/** Reads a `.env` file into `process.env` without clobbering existing values. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Substitutes `${VAR}` references from the environment (spec §42 — secrets live
 * in the environment, never in the committed YAML).
 *
 * Unset variables collapse to an empty string rather than throwing, so that
 * downstream validation can produce the more useful message (e.g. "project
 * `backend` has discord_enabled but discord.token is empty").
 */
function interpolateEnv(source: string, env: NodeJS.ProcessEnv): string {
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '');
}

/** Accepts a bare path or the spec's `"Data Source=agent.db"` form. */
function resolveDatabasePath(connectionString: string, baseDir: string): string {
  const match = /(?:^|;)\s*data\s+source\s*=\s*([^;]+)/i.exec(connectionString);
  const raw = (match?.[1] ?? connectionString).trim();
  if (!raw) return path.join(baseDir, 'agent.db');
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDir, raw);
}

function compileDenyPatterns(patterns: readonly string[], projectId: string, issues: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch (error) {
      issues.push(
        `project \`${projectId}\`: security.deny_patterns contains an invalid regex ${JSON.stringify(pattern)} (${(error as Error).message})`,
      );
    }
  }
  return compiled;
}

function normalizeProject(
  id: string,
  raw: RawProjectConfig,
  configDir: string,
  hasDiscordToken: boolean,
  issues: string[],
  warnings: string[],
): ProjectConfig {
  const absolutePath = path.isAbsolute(raw.path)
    ? path.normalize(raw.path)
    : path.resolve(configDir, raw.path);

  // §16/§39 — a bad working directory is reported now as a warning and enforced
  // hard at spawn time, so one unplugged drive cannot stop the whole Bridge.
  if (!existsSync(absolutePath)) {
    warnings.push(`project \`${id}\`: path does not exist yet: ${absolutePath}`);
  } else if (!statSync(absolutePath).isDirectory()) {
    issues.push(`project \`${id}\`: path is not a directory: ${absolutePath}`);
  } else if (!existsSync(path.join(absolutePath, '.git'))) {
    warnings.push(`project \`${id}\`: ${absolutePath} is not a Git repository (no .git found)`);
  }

  if (raw.discord_enabled) {
    if (!raw.discord?.channel_id) {
      issues.push(`project \`${id}\`: discord_enabled is true but discord.channel_id is missing (§8)`);
    }
    if (!hasDiscordToken) {
      issues.push(`project \`${id}\`: discord_enabled is true but discord.token is empty — set DISCORD_TOKEN`);
    }
    // Decision: fail closed. §25 requires that only authorized users may
    // approve; defaulting to "everyone" would mean there is no security
    // boundary at all, which is worse than refusing to start.
    if (raw.security.allowed_users.length === 0 && raw.security.allowed_roles.length === 0) {
      issues.push(
        `project \`${id}\`: discord_enabled is true but neither security.allowed_users nor ` +
          `security.allowed_roles is configured. Refusing to start rather than allow anyone ` +
          `to approve Copilot actions (§25).`,
      );
    }
    if (raw.security.allow_always) {
      warnings.push(
        `project \`${id}\`: security.allow_always is enabled — approving with "Always" stops ` +
          `Copilot from asking again for matching actions, so those actions will not appear in ` +
          `Discord or the audit log (§21, §26).`,
      );
    }
  }

  if (!raw.security.require_approval) {
    warnings.push(
      `project \`${id}\`: security.require_approval is false — the Bridge will auto-answer ` +
        `Copilot's permission requests for this project. Only do this for throwaway sandboxes.`,
    );
  }

  const project: ProjectConfig = {
    id,
    name: raw.name,
    path: absolutePath,
    discordEnabled: raw.discord_enabled,
    discordChannelId: raw.discord?.channel_id,
    memoryEnabled: raw.memory.enabled,
    security: {
      requireApproval: raw.security.require_approval,
      allowedUsers: new Set(raw.security.allowed_users),
      allowedRoles: new Set(raw.security.allowed_roles),
      allowAlways: raw.security.allow_always,
      denyPatterns: compileDenyPatterns(raw.security.deny_patterns, id, issues),
    },
    copilot: {
      model: raw.copilot.model,
      mode: raw.copilot.mode,
      additionalDirectories: raw.copilot.additional_directories.map((dir) =>
        path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(absolutePath, dir),
      ),
    },
  };

  return project;
}

export interface LoadResult {
  config: BridgeConfig;
  warnings: string[];
}

/** Parses and validates a config file, collecting every problem before throwing. */
export function loadConfigFromString(source: string, configPath: string): LoadResult {
  const configDir = path.dirname(path.resolve(configPath));

  let parsed: unknown;
  try {
    parsed = YAML.parse(interpolateEnv(source, process.env));
  } catch (error) {
    throw new ConfigError([`${configPath}: YAML parse error — ${(error as Error).message}`]);
  }

  const result = rootSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${where}: ${issue.message}`;
      }),
    );
  }
  const raw = result.data;

  const issues: string[] = [];
  const warnings: string[] = [];

  const projectIds = Object.keys(raw.projects);
  if (projectIds.length === 0) issues.push('projects: at least one project must be configured');

  const hasToken = raw.discord.token.trim().length > 0;
  const projects: ProjectConfig[] = [];
  for (const id of projectIds) {
    const rawProject = raw.projects[id];
    if (!rawProject) continue;
    projects.push(normalizeProject(id, rawProject, configDir, hasToken, issues, warnings));
  }

  // §8 — a channel maps to exactly one project, or routing is ambiguous.
  const channelOwners = new Map<string, string[]>();
  for (const project of projects) {
    if (!project.discordEnabled || !project.discordChannelId) continue;
    const owners = channelOwners.get(project.discordChannelId) ?? [];
    owners.push(project.id);
    channelOwners.set(project.discordChannelId, owners);
  }
  for (const [channelId, owners] of channelOwners) {
    if (owners.length > 1) {
      issues.push(
        `discord channel ${channelId} is mapped by more than one project (${owners.join(', ')}); ` +
          `a channel must map to exactly one project (§8)`,
      );
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const config: BridgeConfig = {
    discord: {
      token: raw.discord.token,
      allowedGuilds: new Set(raw.discord.allowed_guilds),
    },
    projects,
    copilot: {
      executable: raw.copilot.executable,
      args: raw.copilot.args,
      startupTimeoutMs: raw.copilot.startup_timeout_ms,
      env: raw.copilot.env,
    },
    approval: { timeoutMs: raw.approval.timeout_ms },
    sessions: {
      maxConcurrentPerProject: raw.sessions.max_concurrent_per_project,
      idleTimeoutMs: raw.sessions.idle_timeout_ms,
    },
    output: {
      showThoughts: raw.output.show_thoughts,
      flushIntervalMs: raw.output.flush_interval_ms,
      maxMessageChars: raw.output.max_message_chars,
      attachThresholdChars: raw.output.attach_threshold_chars,
    },
    storage: { databasePath: resolveDatabasePath(raw.storage.connection_string, configDir) },
  };

  return { config, warnings };
}

export function loadConfig(configPath: string): LoadResult {
  if (!existsSync(configPath)) {
    throw new ConfigError([
      `config file not found: ${configPath}. Copy config/config.example.yaml to config/config.yaml and edit it.`,
    ]);
  }
  return loadConfigFromString(readFileSync(configPath, 'utf8'), configPath);
}
