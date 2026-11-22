import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
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
  /** 버튼(예: /행사 페이지 이동)을 눌렀을 때 바꿔 보여 줄 메시지. 모르는 버튼이면 null */
  onButton?: (customId: string) => Promise<OutgoingMessage | null>;
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

export interface DiscordBot extends ChannelSender {
  state(): BotState;
  sendDm(userId: string, message: OutgoingMessage): Promise<void>;
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
  // 1단계 기능(채널 발송, 슬래시 명령)에는 Guilds 인텐트만 필요하다.
  // 멘션 질의(추후 기능)를 붙일 때 GuildMessages를 추가한다.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
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
    const msg = opts.onButton ? await opts.onButton(interaction.customId) : null;
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
