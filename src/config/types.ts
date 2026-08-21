/** Normalized, validated configuration consumed by the rest of the Bridge. */

export interface ProjectSecurity {
  requireApproval: boolean;
  allowedUsers: ReadonlySet<string>;
  allowedRoles: ReadonlySet<string>;
  allowAlways: boolean;
  denyPatterns: readonly RegExp[];
}

export interface ProjectCopilotOptions {
  model?: string;
  mode: 'agent' | 'plan';
  additionalDirectories: readonly string[];
}

/** One Project — the isolation boundary (spec §4, §46). */
export interface ProjectConfig {
  readonly id: string;
  readonly name: string;
  /** Absolute, normalized path to the project's Git working tree. */
  readonly path: string;
  readonly discordEnabled: boolean;
  readonly discordChannelId?: string;
  readonly memoryEnabled: boolean;
  readonly security: ProjectSecurity;
  readonly copilot: ProjectCopilotOptions;
}

export interface CopilotLaunchConfig {
  readonly executable: string;
  readonly args: readonly string[];
  readonly startupTimeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface OutputConfig {
  readonly showThoughts: boolean;
  readonly flushIntervalMs: number;
  readonly maxMessageChars: number;
  readonly attachThresholdChars: number;
}

export interface SessionsConfig {
  readonly maxConcurrentPerProject: number;
  readonly idleTimeoutMs: number;
}

export interface BridgeConfig {
  readonly discord: {
    readonly token: string;
    readonly allowedGuilds: ReadonlySet<string>;
  };
  readonly projects: readonly ProjectConfig[];
  readonly copilot: CopilotLaunchConfig;
  readonly approval: { readonly timeoutMs: number };
  readonly sessions: SessionsConfig;
  readonly output: OutputConfig;
  readonly storage: { readonly databasePath: string };
}

/** Raised for any configuration problem, with all issues collected at once. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
