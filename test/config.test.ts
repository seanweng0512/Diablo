import { describe, expect, it } from 'vitest';

import { loadConfigFromString } from '../src/config/load';
import { ConfigError } from '../src/config/types';

const CONFIG_PATH = 'D:/Developing/copilot-workflow/Diablo/config/config.yaml';
const EXISTING_DIR = 'D:/Developing/copilot-workflow/Diablo';

function baseYaml(overrides = ''): string {
  return `
discord:
  token: \${TEST_DISCORD_TOKEN}
projects:
  backend:
    name: Backend
    path: ${EXISTING_DIR}
    discord_enabled: true
    discord:
      channel_id: "111"
    security:
      allowed_users: ["42"]
${overrides}
`;
}

describe('config loading', () => {
  it('interpolates ${ENV} references so secrets stay out of the file', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok-from-env';
    const { config } = loadConfigFromString(baseYaml(), CONFIG_PATH);
    expect(config.discord.token).toBe('tok-from-env');
  });

  it('applies documented defaults', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok';
    const { config } = loadConfigFromString(baseYaml(), CONFIG_PATH);

    expect(config.approval.timeoutMs).toBe(30 * 60 * 1000); // §41
    expect(config.copilot.executable).toBe('copilot');
    expect(config.output.showThoughts).toBe(false); // §29
    const project = config.projects[0]!;
    expect(project.security.requireApproval).toBe(true);
    expect(project.security.allowAlways).toBe(false); // must be opt-in
    expect(project.memoryEnabled).toBe(true);
  });

  it('accepts the .NET-style connection string from the spec', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok';
    const { config } = loadConfigFromString(
      baseYaml(`
storage:
  connection_string: "Data Source=agent.db"
`),
      CONFIG_PATH,
    );
    expect(config.storage.databasePath.replace(/\\/g, '/')).toMatch(/\/config\/agent\.db$/);
  });

  it('fails closed when a Discord-enabled project names no approvers (§25)', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok';
    const yaml = `
discord:
  token: \${TEST_DISCORD_TOKEN}
projects:
  backend:
    name: Backend
    path: ${EXISTING_DIR}
    discord_enabled: true
    discord:
      channel_id: "111"
`;
    expect(() => loadConfigFromString(yaml, CONFIG_PATH)).toThrow(ConfigError);
    try {
      loadConfigFromString(yaml, CONFIG_PATH);
    } catch (error) {
      expect((error as ConfigError).issues.join(' ')).toMatch(/allowed_users/);
    }
  });

  it('rejects two projects claiming the same Discord channel (§8)', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok';
    const yaml = `
discord:
  token: \${TEST_DISCORD_TOKEN}
projects:
  backend:
    name: Backend
    path: ${EXISTING_DIR}
    discord_enabled: true
    discord: { channel_id: "111" }
    security: { allowed_users: ["42"] }
  other:
    name: Other
    path: ${EXISTING_DIR}
    discord_enabled: true
    discord: { channel_id: "111" }
    security: { allowed_users: ["42"] }
`;
    expect(() => loadConfigFromString(yaml, CONFIG_PATH)).toThrow(/more than one project/);
  });

  it('allows a project with Discord disabled and no approvers (§6.2)', () => {
    const yaml = `
projects:
  frontend:
    name: Frontend
    path: ${EXISTING_DIR}
    discord_enabled: false
`;
    const { config } = loadConfigFromString(yaml, CONFIG_PATH);
    expect(config.projects[0]!.discordEnabled).toBe(false);
  });

  it('reports an invalid deny_patterns regex instead of silently ignoring it', () => {
    const yaml = `
projects:
  frontend:
    name: Frontend
    path: ${EXISTING_DIR}
    discord_enabled: false
    security:
      deny_patterns: ["([unclosed"]
`;
    expect(() => loadConfigFromString(yaml, CONFIG_PATH)).toThrow(/invalid regex/);
  });

  it('warns when require_approval is disabled', () => {
    const yaml = `
projects:
  frontend:
    name: Frontend
    path: ${EXISTING_DIR}
    discord_enabled: false
    security:
      require_approval: false
`;
    const { warnings } = loadConfigFromString(yaml, CONFIG_PATH);
    expect(warnings.join(' ')).toMatch(/require_approval is false/);
  });
});
