import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import type { ChannelSender, OutgoingMessage } from './types.js';
import { commandDefinitions } from './commands.js';
import { truncate } from './format.js';

export type BotState = 'connecting' | 'ready' | 'error' | 'stopped';

export interface DiscordBotOptions {
  token: string;
  appId: string;
  guildId: string;
  /** 슬래시 명령 응답(텍스트 또는 임베드)을 만든다. 모르는 명령이면 null */
  onCommand: (name: string, ctx: CommandContext) => Promise<string | OutgoingMessage | null>;
  /** 버튼(/행사 페이지 이동, 검수 승인·무시)을 눌렀을 때 바꿔 보여 줄 메시지. 모르는 버튼이면 null */
  onButton?: (customId: string, ctx: { userId: string }) => Promise<OutgoingMessage | null>;
  /** 봇을 멘션한 질문에 대한 답. null이면 답하지 않는다 */
  onMention?: (question: string, ctx: { userId: string; channelId: string }) => Promise<string | null>;
  /** 봇 상태 메시지(프로필 아래 한 줄). 준비될 때와 10분마다 갱신 */
  presence?: () => Promise<string>;
  /** 처음 준비됐을 때 한 번 */
  onReady?: (tag: string) => void | Promise<void>;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface CommandContext {
  wsPingMs: number;
  getString(option: string): string | null;
}

/** 디스코드 서버 예약 이벤트(외부 장소) 내용 */
export interface GuildEventSpec {
  name: string;
  description: string;
  location: string;
  startIso: string;
  endIso: string;
  /** 커버 이미지 URL. 못 가져오면 이미지 없이 만든다 */
  imageUrl?: string;
}

export interface DiscordBot extends ChannelSender {
  state(): BotState;
  sendDm(userId: string, message: OutgoingMessage): Promise<void>;
  /** 채널에 보내고 메시지 ID를 돌려준다 (검수 카드처럼 나중에 찾아야 하는 메시지) */
  post(channelId: string, message: OutgoingMessage): Promise<string>;
  /** 서버 예약 이벤트를 만들 권한(이벤트 만들기 또는 이벤트 관리)이 있는지 */
  canManageEvents(): Promise<boolean>;
  createGuildEvent(spec: GuildEventSpec): Promise<string>;
  editGuildEvent(id: string, spec: GuildEventSpec): Promise<void>;
  deleteGuildEvent(id: string): Promise<void>;
  stop(): Promise<void>;
}

/** 길드 슬래시 명령을 등록한다. 길드 명령은 등록 즉시 반영된다. */
export async function registerCommands(token: string, appId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commandDefinitions });
}

/**
 * 카드(Components V2)가 있으면 카드로 보내고, 디스코드가 형식 오류(400)로 거부하면 content·embeds로 다시 보낸다.
 * 카드 형식이 바뀌어 거부돼도 알림이 빠지지 않게 하기 위해서다.
 */
export async function sendWithFallback(
  msg: OutgoingMessage,
  sendCard: (card: NonNullable<OutgoingMessage['card']>) => Promise<unknown>,
  sendPlain: (plain: { content?: string; embeds?: OutgoingMessage['embeds']; allowedMentions: { parse: [] } }) => Promise<unknown>,
  log: Pick<Console, 'warn'> = console,
): Promise<'card' | 'plain'> {
  const plain = { content: msg.content ? truncate(msg.content) : undefined, embeds: msg.embeds, allowedMentions: { parse: [] as [] } };
  if (msg.card?.length) {
    try {
      await sendCard(msg.card);
      return 'card';
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (status !== 400 || !(msg.content || msg.embeds?.length)) throw err;
      log.warn(`카드 형식이 거부돼 임베드로 다시 보냅니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await sendPlain(plain);
  return 'plain';
}

/**
 * 봇을 시작한다. 로그인에 실패해도 예외를 던지지 않고 state()가 'error'가 되며, 1·2·5·10분 간격으로 다시 시도한다.
 * 디스코드 장애로 수집까지 멈추지 않게 하기 위해서다. 상태는 /health와 로그로 확인한다.
 */
export function startDiscordBot(opts: DiscordBotOptions): DiscordBot {
  const log = opts.log ?? console;
  // 채널 발송·슬래시 명령은 Guilds, 멘션 질문은 GuildMessages.
  // 봇을 멘션한 메시지는 MessageContent(특권 인텐트) 없이도 본문이 온다.
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  let state: BotState = 'connecting';

  async function updatePresence() {
    if (!opts.presence || !client.isReady()) return;
    try {
      const text = (await opts.presence()).slice(0, 128);
      client.user.setPresence({ activities: [{ name: text, state: text, type: ActivityType.Custom }], status: 'online' });
    } catch (err) {
      log.warn(`봇 상태 메시지 갱신 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let presenceTimer: NodeJS.Timeout | undefined;

  client.once(Events.ClientReady, async (c) => {
    state = 'ready';
    log.log(`디스코드 봇 준비 완료: ${c.user.tag}`);
    await updatePresence();
    presenceTimer = setInterval(() => void updatePresence(), 10 * 60_000);
    presenceTimer.unref();
    try {
      await registerCommands(opts.token, opts.appId, opts.guildId);
    } catch (err) {
      log.error(`슬래시 명령 등록 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await opts.onReady?.(c.user.tag);
    } catch (err) {
      log.error(`onReady 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      await handleButton(interaction).catch((err: unknown) =>
        log.error(`버튼 처리 실패 (${interaction.customId}): ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    await handleCommand(interaction).catch((err: unknown) =>
      log.error(`명령 처리 실패 (/${interaction.commandName}): ${err instanceof Error ? err.message : String(err)}`),
    );
  });

  // 멘션 질문: 같은 사람은 15초에 한 번, 동시에 2건까지
  const lastAsked = new Map<string, number>();
  let answering = 0;
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!opts.onMention || message.author.bot || !client.user || !message.inGuild()) return;
    if (!message.mentions.users.has(client.user.id) || message.mentions.everyone) return;
    const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const reply = (content: string) =>
      message.reply({ content: truncate(content), allowedMentions: { parse: [], repliedUser: false } }).catch((err: unknown) =>
        log.error(`멘션 답장 실패: ${err instanceof Error ? err.message : String(err)}`),
      );
    if (!question) {
      await reply('미쿠 행사에 대해 물어보세요. 예: `@봇 이번 달 국내 미쿠 행사 뭐 있어?`');
      return;
    }
    const now = Date.now();
    if (now - (lastAsked.get(message.author.id) ?? 0) < 15_000) return;
    if (answering >= 2) {
      await reply('지금 다른 질문에 답하는 중이에요. 잠시 뒤에 다시 물어봐 주세요.');
      return;
    }
    lastAsked.set(message.author.id, now);
    answering++;
    try {
      await message.channel.sendTyping().catch(() => undefined);
      const answer = await opts.onMention(question, { userId: message.author.id, channelId: message.channelId });
      if (answer) await reply(answer);
    } catch (err) {
      log.error(`멘션 질문 처리 실패: ${err instanceof Error ? err.message : String(err)}`);
      await reply('답을 만드는 중에 문제가 생겼어요. 잠시 뒤에 다시 물어봐 주세요.');
    } finally {
      answering--;
    }
  });

  client.on(Events.Error, (err) => log.error(`디스코드 클라이언트 오류: ${err.message}`));
  client.on(Events.ShardDisconnect, () => {
    if (state === 'ready') log.warn('디스코드 게이트웨이 연결 끊김, 자동 재연결 대기');
  });
  client.on(Events.ShardResume, () => log.log('디스코드 게이트웨이 재연결'));

  async function handleCommand(interaction: ChatInputCommandInteraction) {
    const content = await opts.onCommand(interaction.commandName, {
      wsPingMs: client.ws.ping,
      getString: (o) => interaction.options.getString(o),
    });
    if (content === null) return;
    // 명령 응답은 친 사람에게만 보인다
    const msg = typeof content === 'string' ? { content } : content;
    await sendWithFallback(
      msg,
      (card) => interaction.reply({ components: card, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
      (plain) => interaction.reply({ ...plain, flags: MessageFlags.Ephemeral }),
      log,
    );
  }

  async function handleButton(interaction: ButtonInteraction) {
    const msg = opts.onButton ? await opts.onButton(interaction.customId, { userId: interaction.user.id }) : null;
    if (!msg?.card) {
      await interaction.deferUpdate();
      return;
    }
    await interaction.update({ components: msg.card, allowedMentions: { parse: [] } });
  }

  // 로그인 실패 시 재시도 간격(분). 토큰이 틀린 경우는 재시도하지 않는다.
  const RETRY_MIN = [1, 2, 5, 10];
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  function login() {
    client
      .login(opts.token)
      .then(() => {
        attempt = 0;
      })
      .catch((err: unknown) => {
        state = 'error';
        // discord.js 오류 메시지에는 토큰이 들어가지 않는다.
        log.error(`디스코드 로그인 실패: ${err instanceof Error ? err.message : String(err)}`);
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'TokenInvalid') {
          log.error(
            '봇 토큰이 맞지 않습니다. Developer Portal → 앱 → Bot → Reset Token으로 새로 받은 값을 DISCORD_BOT_TOKEN에 넣으세요. ' +
              'OAuth2의 Client Secret이나 General Information의 Public Key가 아닌지 확인하세요.',
          );
          return;
        }
        if (stopped) return;
        const waitMin = RETRY_MIN[Math.min(attempt, RETRY_MIN.length - 1)]!;
        attempt++;
        log.warn(`${waitMin}분 뒤 디스코드 로그인을 다시 시도합니다`);
        retryTimer = setTimeout(() => {
          state = 'connecting';
          login();
        }, waitMin * 60_000);
        retryTimer.unref();
      });
  }
  login();

  return {
    state: () => state,
    isReady: () => state === 'ready' && client.isReady(),
    async send(channelId: string, message: OutgoingMessage) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isSendable()) throw new Error(`메시지를 보낼 수 없는 채널입니다: ${channelId}`);
      await sendWithFallback(
        message,
        (card) => channel.send({ components: card, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
        (plain) => channel.send(plain),
        log,
      );
    },
    async post(channelId: string, message: OutgoingMessage) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isSendable()) throw new Error(`메시지를 보낼 수 없는 채널입니다: ${channelId}`);
      let id = '';
      await sendWithFallback(
        message,
        async (card) => (id = (await channel.send({ components: card, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } })).id),
        async (plain) => (id = (await channel.send(plain)).id),
        log,
      );
      return id;
    },
    async canManageEvents() {
      const guild = await client.guilds.fetch(opts.guildId);
      const me = await guild.members.fetchMe();
      return me.permissions.has(PermissionFlagsBits.CreateEvents) || me.permissions.has(PermissionFlagsBits.ManageEvents);
    },
    async createGuildEvent(spec: GuildEventSpec) {
      const guild = await client.guilds.fetch(opts.guildId);
      const base = {
        name: spec.name.slice(0, 100),
        description: spec.description.slice(0, 1000),
        scheduledStartTime: spec.startIso,
        scheduledEndTime: spec.endIso,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: spec.location.slice(0, 100) },
      } as const;
      try {
        return (await guild.scheduledEvents.create({ ...base, ...(spec.imageUrl ? { image: spec.imageUrl } : {}) })).id;
      } catch (err) {
        if (!spec.imageUrl) throw err;
        log.warn(`서버 이벤트 커버 이미지 없이 다시 만듭니다: ${err instanceof Error ? err.message : String(err)}`);
        return (await guild.scheduledEvents.create(base)).id;
      }
    },
    async editGuildEvent(id: string, spec: GuildEventSpec) {
      const guild = await client.guilds.fetch(opts.guildId);
      await guild.scheduledEvents.edit(id, {
        name: spec.name.slice(0, 100),
        description: spec.description.slice(0, 1000),
        scheduledStartTime: spec.startIso,
        scheduledEndTime: spec.endIso,
        entityMetadata: { location: spec.location.slice(0, 100) },
      });
    },
    async deleteGuildEvent(id: string) {
      const guild = await client.guilds.fetch(opts.guildId);
      await guild.scheduledEvents.delete(id);
    },
    async sendDm(userId: string, message: OutgoingMessage) {
      const user = await client.users.fetch(userId);
      await sendWithFallback(
        message,
        (card) => user.send({ components: card, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
        (plain) => user.send(plain),
        log,
      );
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(presenceTimer);
      state = 'stopped';
      await client.destroy();
    },
  };
}
