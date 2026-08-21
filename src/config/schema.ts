import { z } from 'zod';

/**
 * Configuration schema for the Agent Bridge (spec §5, §25, §42).
 *
 * YAML uses snake_case (as in the spec's examples); this module validates it and
 * hands the rest of the app camelCase objects. Validation is deliberately strict
 * and fail-closed: a project that enables Discord without naming anyone who may
 * approve actions is a configuration error, not a project that lets everyone in.
 */

const discordProjectSchema = z.object({
  channel_id: z.string().min(1, 'discord.channel_id must be a non-empty Discord channel ID'),
});

const securitySchema = z
  .object({
    require_approval: z.boolean().default(true),
    /** Discord user IDs permitted to drive and approve this project. */
    allowed_users: z.array(z.string().min(1)).default([]),
    /** Discord role names or IDs permitted to drive and approve this project. */
    allowed_roles: z.array(z.string().min(1)).default([]),
    /**
     * Whether to offer ACP's `allow_always` outcome in the approval UI.
     *
     * Default false, and deliberately so: `allow_always` makes Copilot stop
     * sending `session/request_permission` for matching actions entirely, which
     * would create an auto-approval path the Bridge can neither see nor audit.
     * That directly contradicts §21 and §26. Turn it on per project only if you
     * accept that trade.
     */
    allow_always: z.boolean().default(false),
    /**
     * Shell command patterns the Bridge refuses outright, without ever asking a
     * human. Evaluated before the approval UI. Regex, case-insensitive.
     */
    deny_patterns: z.array(z.string().min(1)).default([]),
  })
  .prefault({});

const memorySchema = z.object({ enabled: z.boolean().default(true) }).prefault({});

const projectCopilotSchema = z
  .object({
    model: z.string().min(1).optional(),
    /** ACP session mode; `agent` is the interactive default. */
    mode: z.enum(['agent', 'plan']).default('agent'),
    /** Extra directories to grant filesystem access beyond the project path. */
    additional_directories: z.array(z.string().min(1)).default([]),
  })
  .prefault({});

const projectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  discord_enabled: z.boolean().default(false),
  discord: discordProjectSchema.optional(),
  memory: memorySchema,
  security: securitySchema,
  copilot: projectCopilotSchema,
});

const rootSchema = z.object({
  discord: z
    .object({
      token: z.string().default(''),
      /** Optional guild allow-list; empty means "any guild the bot is in". */
      allowed_guilds: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),

  projects: z.record(z.string().min(1), projectSchema),

  copilot: z
    .object({
      executable: z.string().min(1).default('copilot'),
      /** Extra CLI args. `--acp` is always added by the Bridge. */
      args: z.array(z.string()).default([]),
      startup_timeout_ms: z.number().int().positive().default(60_000),
      /** Passed through to the spawned process environment. */
      env: z.record(z.string(), z.string()).prefault({}),
    })
    .prefault({}),

  approval: z
    .object({
      /** §41 — 30 minutes. Expiry never approves; it only marks the request stale. */
      timeout_ms: z.number().int().positive().default(30 * 60 * 1000),
    })
    .prefault({}),

  sessions: z
    .object({
      max_concurrent_per_project: z.number().int().positive().default(4),
      /** Reap idle Copilot processes to bound memory (§15). 0 disables reaping. */
      idle_timeout_ms: z.number().int().nonnegative().default(60 * 60 * 1000),
    })
    .prefault({}),

  output: z
    .object({
      /** §29 — agent reasoning is noisy; off by default. */
      show_thoughts: z.boolean().default(false),
      /** Debounce window for coalescing streamed chunks into one edit. */
      flush_interval_ms: z.number().int().positive().default(1_200),
      /** Discord's hard limit is 2000; leave headroom for formatting. */
      max_message_chars: z.number().int().positive().max(2000).default(1_900),
      /** Beyond this, send the reply as a .md attachment instead (§28). */
      attach_threshold_chars: z.number().int().positive().default(6_000),
    })
    .prefault({}),

  storage: z
    .object({
      provider: z.literal('sqlite').default('sqlite'),
      /**
       * Accepts a bare path (`agent.db`) or the spec's .NET-style
       * `"Data Source=agent.db"`; both resolve to the same file.
       */
      connection_string: z.string().min(1).default('Data Source=agent.db'),
    })
    .prefault({}),
});

export type RawConfig = z.infer<typeof rootSchema>;
export type RawProjectConfig = z.infer<typeof projectSchema>;

export { rootSchema, projectSchema };
