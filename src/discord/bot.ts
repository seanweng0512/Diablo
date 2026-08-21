import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type SendableChannels,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import type { ApprovalDecision } from '../approval/models.js';
import type { BridgeConfig, ProjectConfig } from '../config/types.js';
import {
  formatMemoryList,
  formatProjectInfo,
  formatStatus,
  type BridgeCommands,
} from '../core/commands.js';
import type { AgentOrchestrator } from '../core/orchestrator.js';
import type { ProjectManager } from '../core/project-manager.js';
import type { SessionManager } from '../core/session-manager.js';
import type { ConversationRef } from '../core/types.js';
import type { MemoryApprovalPrompt } from '../interaction/provider.js';
import type { MemoryManager } from '../memory/manager.js';
import type { Logger } from '../util/logger.js';
import { actorFromMember, describeDenial, isAuthorized, type Actor } from './authz.js';
import { deriveThreadName } from './formatting.js';
import {
  DiscordInteractionProvider,
  DISCORD_PROVIDER_ID,
  type DiscordGateway,
} from './provider.js';

const APPROVAL_PREFIX = 'apv';
const MEMORY_PREFIX = 'mem';

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Show the agent status for this thread'),
  new SlashCommandBuilder().setName('cancel').setDescription('Cancel this thread’s session and stop Copilot'),
  new SlashCommandBuilder().setName('reset').setDescription('Retire this session; the next message starts fresh'),
  new SlashCommandBuilder().setName('project').setDescription('Show the project mapped to this channel'),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Inspect or manage this project’s memory')
    .addSubcommand((sub) => sub.setName('list').setDescription('Show all project memory'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Remember a durable fact about this project')
        .addStringOption((opt) => opt.setName('fact').setDescription('The fact to remember').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Forget an entry')
        .addStringOption((opt) => opt.setName('id').setDescription('Entry id (first 8 chars is enough)').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Search project memory')
        .addStringOption((opt) => opt.setName('term').setDescription('Text to look for').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('approve')
    .setDescription('Approve the pending action (buttons are usually easier)')
    .addStringOption((opt) => opt.setName('id').setDescription('Approval id, if there are several')),
  new SlashCommandBuilder()
    .setName('reject')
    .setDescription('Reject the pending action')
    .addStringOption((opt) => opt.setName('id').setDescription('Approval id, if there are several')),
].map((command) => command.toJSON());

export interface DiscordBotOptions {
  readonly config: BridgeConfig;
  readonly orchestrator: AgentOrchestrator;
  readonly commands: BridgeCommands;
  readonly projects: ProjectManager;
  readonly sessions: SessionManager;
  readonly memory: MemoryManager;
  readonly logger: Logger;
}

/**
 * The Discord front end (spec §8, §9, §12, §13, §24, §30–§35).
 *
 * Routing is strict: a channel must be configured, and anything else is ignored
 * outright (§8). Messages in a mapped channel open a thread; messages in a
 * thread continue its session, looked up by thread id so the user never types a
 * session id (§13).
 */
export class DiscordBot implements DiscordGateway {
  private readonly client: Client;
  readonly provider: DiscordInteractionProvider;
  private ready = false;

  constructor(private readonly options: DiscordBotOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // Required to read message text; enable "Message Content Intent" in the
        // Discord developer portal or the bot will see empty messages.
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.provider = new DiscordInteractionProvider(this, this.options.logger.child('provider'));
  }

  get isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const { logger } = this.options;

    this.client.once(Events.ClientReady, (client) => {
      this.ready = true;
      logger.info(`Discord connected as ${client.user.tag}`);
      void this.registerCommands().catch((error) => logger.error('slash command registration failed', error));
    });

    // §40 — a dropped gateway must not corrupt state. discord.js reconnects on
    // its own; we only track availability so approvals park instead of being
    // auto-answered.
    this.client.on(Events.ShardDisconnect, () => {
      this.ready = false;
      logger.warn('Discord gateway disconnected; approvals will park until it returns');
    });
    this.client.on(Events.ShardResume, () => {
      this.ready = true;
      logger.info('Discord gateway resumed');
    });
    this.client.on(Events.Error, (error) => logger.error('Discord client error', error));

    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message).catch((error) => logger.error('message handling failed', error));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction).catch((error) =>
        logger.error('interaction handling failed', error),
      );
    });

    await this.client.login(this.options.config.discord.token);
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.client.destroy();
  }

  async resolveSendable(ref: ConversationRef): Promise<SendableChannels | null> {
    const id = ref.threadId ?? ref.channelId;
    if (!id) return null;
    try {
      const channel = await this.client.channels.fetch(id);
      return channel?.isSendable() ? channel : null;
    } catch (error) {
      this.options.logger.warn(`could not fetch channel ${id}`, error);
      return null;
    }
  }

  // -------------------------------------------------------------------------

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || message.system) return;
    if (!message.guild) return;
    if (!message.content.trim()) return;

    const { allowedGuilds } = this.options.config.discord;
    if (allowedGuilds.size > 0 && !allowedGuilds.has(message.guild.id)) return;

    const routing = this.routeChannel(message);
    // §8 — unmapped channels are simply not ours.
    if (!routing) return;

    const { project, threadId } = routing;
    const actor = actorFromMember(message.member, message.author);

    if (!isAuthorized(project, actor)) {
      this.options.logger.warn(
        `unauthorized message from ${actor.id} (${actor.displayName}) in project ${project.id}`,
      );
      await message.reply({ content: `🚫 ${describeDenial(project)}` });
      return;
    }

    // A message in the mapped channel itself opens a thread, so that every
    // session gets its own conversation (§9, §12).
    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      const thread = await this.openThread(message);
      if (!thread) return;
      resolvedThreadId = thread.id;
    }

    try {
      await this.options.orchestrator.handleUserMessage({
        project,
        providerId: DISCORD_PROVIDER_ID,
        text: message.content.trim(),
        author: `${actor.displayName} (${actor.id})`,
        title: resolvedThreadId === threadId ? undefined : deriveThreadName(message.content),
        discordGuildId: message.guild.id,
        discordChannelId: routing.channelId,
        discordThreadId: resolvedThreadId,
      });
    } catch (error) {
      const channel = await this.resolveSendable({
        providerId: DISCORD_PROVIDER_ID,
        sessionId: '',
        projectId: project.id,
        threadId: resolvedThreadId,
        channelId: routing.channelId,
      });
      await channel?.send(`❌ ${(error as Error).message}`);
    }
  }

  /**
   * Works out which project a message belongs to.
   *
   * Threads are matched by their parent channel, so a thread inherits its
   * channel's project and nothing else needs configuring.
   */
  private routeChannel(
    message: Message,
  ): { project: ProjectConfig; channelId: string; threadId: string | null } | null {
    const channel = message.channel;

    if (channel.isThread()) {
      const parentId = channel.parentId;
      if (!parentId) return null;
      const project = this.options.projects.byDiscordChannel(parentId);
      return project ? { project, channelId: parentId, threadId: channel.id } : null;
    }

    if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
      const project = this.options.projects.byDiscordChannel(channel.id);
      return project ? { project, channelId: channel.id, threadId: null } : null;
    }

    return null;
  }

  private async openThread(message: Message): Promise<ThreadChannel | null> {
    try {
      const parent = message.channel as TextChannel;
      return await parent.threads.create({
        name: deriveThreadName(message.content),
        startMessage: message,
        reason: 'Copilot Agent Bridge session',
      });
    } catch (error) {
      this.options.logger.error('failed to create a thread', error);
      await message.reply(
        '❌ I could not create a thread here. I need the **Create Public Threads** permission ' +
          'in this channel, or you can start a thread yourself and talk to me inside it.',
      );
      return null;
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.onButton(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await this.onSlashCommand(interaction);
    }
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const [prefix, action, id] = interaction.customId.split(':');
    if (!prefix || !action || !id) return;

    const context = this.contextForInteraction(interaction);
    if (!context) {
      await interaction.reply({
        content: 'This channel is not mapped to a project any more.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { project, actor, sessionId } = context;

    // §25 — the button existing is not permission to press it.
    if (!isAuthorized(project, actor)) {
      this.options.logger.warn(
        `unauthorized button press by ${actor.id} on ${interaction.customId} (project ${project.id})`,
      );
      await interaction.reply({ content: `🚫 ${describeDenial(project)}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const by = `${actor.displayName} (${actor.id})`;

    if (prefix === APPROVAL_PREFIX) {
      const decision = action as ApprovalDecision;
      await interaction.deferUpdate();

      const result = await this.options.orchestrator.resolveApproval(id, decision, by, {
        expectProjectId: project.id,
        ...(sessionId ? { expectSessionId: sessionId } : {}),
      });

      if (!result.ok) {
        await interaction.followUp({
          content:
            result.reason === 'already-resolved'
              ? 'That request was already resolved.'
              : result.reason === 'wrong-scope'
                ? 'That request belongs to a different project or session.'
                : 'That request is no longer available.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (prefix === MEMORY_PREFIX) {
      const prompt = this.provider.getMemoryPrompt(id);
      await interaction.deferUpdate();

      if (!prompt) {
        await interaction.followUp({
          content: 'That memory request has already been handled.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (prompt.projectId !== project.id) {
        await interaction.followUp({
          content: 'That memory request belongs to a different project.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const approved = action === 'approve';
      this.options.memory.resolveMemoryRequest(id, approved, by);
      await this.provider.finishMemoryPrompt(prompt, approved, by);
    }
  }

  private async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = this.contextForInteraction(interaction);
    if (!context) {
      await interaction.reply({
        content: 'This channel is not mapped to a project. See `config/config.yaml`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { project, actor, sessionId } = context;
    if (!isAuthorized(project, actor)) {
      await interaction.reply({ content: `🚫 ${describeDenial(project)}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const { commands } = this.options;
    const by = `${actor.displayName} (${actor.id})`;

    switch (interaction.commandName) {
      case 'status': {
        const report = sessionId ? commands.status(sessionId) : null;
        await interaction.reply({
          content: report
            ? formatStatus(report)
            : 'No active session in this thread. Send a message to start one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'cancel': {
        await interaction.deferReply();
        const result = await commands.cancel(sessionId);
        await interaction.editReply(result.message);
        return;
      }

      case 'reset': {
        await interaction.deferReply();
        const result = await commands.reset(sessionId);
        await interaction.editReply(result.message);
        return;
      }

      case 'project':
        await interaction.reply({
          content: formatProjectInfo(commands.projectInfo(project)),
          flags: MessageFlags.Ephemeral,
        });
        return;

      case 'memory': {
        const sub = interaction.options.getSubcommand(false) ?? 'list';
        if (sub === 'add') {
          const fact = interaction.options.getString('fact', true);
          await interaction.reply(commands.memoryAdd(project, fact, by).message);
          return;
        }
        if (sub === 'remove') {
          const id = interaction.options.getString('id', true);
          const full = this.expandMemoryId(project, id);
          await interaction.reply(
            full ? commands.memoryRemove(project, full).message : 'No memory with that id in this project.',
          );
          return;
        }
        if (sub === 'search') {
          const term = interaction.options.getString('term', true);
          await interaction.reply({
            content: formatMemoryList(
              commands.memorySearch(project.id, term),
              `${project.name} — matching "${term}"`,
            ),
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.reply({
          content: formatMemoryList(commands.memoryList(project.id), project.name),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'approve':
      case 'reject': {
        await interaction.deferReply();
        const result = await commands.decide(
          sessionId,
          project.id,
          interaction.commandName === 'approve' ? 'approve' : 'reject',
          by,
          interaction.options.getString('id') ?? undefined,
        );
        await interaction.editReply(result.message);
        return;
      }

      default:
        await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    }
  }

  /** Accepts a short id prefix, as shown in `/memory list`. */
  private expandMemoryId(project: ProjectConfig, shortId: string): string | null {
    const match = this.options.memory
      .list(project.id)
      .find((entry) => entry.id === shortId || entry.id.startsWith(shortId));
    return match?.id ?? null;
  }

  private contextForInteraction(
    interaction: ButtonInteraction | ChatInputCommandInteraction,
  ): { project: ProjectConfig; actor: Actor; sessionId: string | null } | null {
    const channel = interaction.channel;
    if (!channel || !interaction.guild) return null;

    let channelId: string | null = null;
    let threadId: string | null = null;

    if (channel.isThread()) {
      channelId = channel.parentId;
      threadId = channel.id;
    } else {
      channelId = channel.id;
    }
    if (!channelId) return null;

    const project = this.options.projects.byDiscordChannel(channelId);
    if (!project) return null;

    const member = interaction.guild.members.cache.get(interaction.user.id) ?? null;
    const actor = actorFromMember(member, interaction.user);
    const session = threadId ? this.options.sessions.findActiveByThread(threadId) : null;

    return { project, actor, sessionId: session?.id ?? null };
  }

  private async registerCommands(): Promise<void> {
    const application = this.client.application;
    if (!application) return;

    const rest = new REST().setToken(this.options.config.discord.token);
    // Guild-scoped registration so commands appear immediately rather than
    // waiting on global propagation.
    for (const [guildId] of this.client.guilds.cache) {
      const { allowedGuilds } = this.options.config.discord;
      if (allowedGuilds.size > 0 && !allowedGuilds.has(guildId)) continue;
      try {
        await rest.put(Routes.applicationGuildCommands(application.id, guildId), {
          body: SLASH_COMMANDS,
        });
        this.options.logger.info(`registered ${SLASH_COMMANDS.length} slash commands in guild ${guildId}`);
      } catch (error) {
        this.options.logger.warn(`could not register commands in guild ${guildId}`, error);
      }
    }
  }
}
