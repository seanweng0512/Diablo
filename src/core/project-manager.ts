import { existsSync, statSync } from 'node:fs';

import type { BridgeConfig, ProjectConfig } from '../config/types.js';
import type { ProjectRepository } from '../storage/repositories.js';
import type { Logger } from '../util/logger.js';

/**
 * Resolves projects, the Bridge's isolation boundary (§4).
 *
 * Lookup is deliberately explicit: a Discord channel that is not configured
 * resolves to nothing and its messages are ignored (§8), rather than falling
 * back to a default project.
 */
export class ProjectManager {
  private readonly byId = new Map<string, ProjectConfig>();
  private readonly byChannel = new Map<string, ProjectConfig>();

  constructor(
    config: BridgeConfig,
    repository: ProjectRepository,
    private readonly logger: Logger,
  ) {
    for (const project of config.projects) {
      this.byId.set(project.id, project);
      if (project.discordEnabled && project.discordChannelId) {
        this.byChannel.set(project.discordChannelId, project);
      }
      repository.upsert({
        id: project.id,
        name: project.name,
        path: project.path,
        discordEnabled: project.discordEnabled,
        discordChannelId: project.discordChannelId ?? null,
      });
    }
    this.logger.info(
      `loaded ${this.byId.size} project(s); ${this.byChannel.size} mapped to a Discord channel`,
    );
  }

  get(projectId: string): ProjectConfig | null {
    return this.byId.get(projectId) ?? null;
  }

  /** §8 — only configured channels are processed; everything else is ignored. */
  byDiscordChannel(channelId: string): ProjectConfig | null {
    return this.byChannel.get(channelId) ?? null;
  }

  list(): ProjectConfig[] {
    return [...this.byId.values()];
  }

  discordProjects(): ProjectConfig[] {
    return this.list().filter((project) => project.discordEnabled);
  }

  /**
   * Re-checks a project's working directory immediately before use (§16).
   *
   * Startup validation is not enough — a network drive can vanish between
   * startup and the first prompt, and Copilot must never be launched into a
   * path that is not the project.
   */
  assertUsable(project: ProjectConfig): void {
    if (!existsSync(project.path)) {
      throw new Error(`project \`${project.id}\` path does not exist: ${project.path}`);
    }
    if (!statSync(project.path).isDirectory()) {
      throw new Error(`project \`${project.id}\` path is not a directory: ${project.path}`);
    }
  }
}
