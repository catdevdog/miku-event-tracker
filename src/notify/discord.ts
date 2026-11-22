import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
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
  /** /ping 응답 본문을 만든다 */
  onPing: (wsPingMs: number) => Promise<string>;
  /** 처음 준비됐을 때 한 번 */
  onReady?: (tag: string) => void | Promise<void>;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface DiscordBot extends ChannelSender {
  state(): BotState;
  stop(): Promise<void>;
}

/** 길드 슬래시 명령을 등록한다. 길드 명령은 등록 즉시 반영된다. */
export async function registerCommands(token: string, appId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commandDefinitions });
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

  client.once(Events.ClientReady, async (c) => {
    state = 'ready';
    log.log(`디스코드 봇 준비 완료: ${c.user.tag}`);
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
    if (interaction.commandName === 'ping') {
      const content = await opts.onPing(client.ws.ping);
      await interaction.reply({ content: truncate(content), flags: MessageFlags.Ephemeral });
    }
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
        if (stopped || code === 'TokenInvalid') return;
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
      await channel.send({
        content: message.content ? truncate(message.content) : undefined,
        embeds: message.embeds,
        allowedMentions: { parse: [] },
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      state = 'stopped';
      await client.destroy();
    },
  };
}
