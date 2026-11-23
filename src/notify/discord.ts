import {
  ActivityType,
  ApplicationCommandOptionType,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { ChannelSender, OutgoingMessage } from './types.js';
import { commandDefinitions } from './commands.js';
import { truncate } from './format.js';

export type BotState = 'connecting' | 'ready' | 'error' | 'stopped';

/** 명령·버튼 응답. 문자열이나 메시지는 누른(친) 사람에게만 보인다 */
export type Reply = string | OutgoingMessage;

/** 입력 창(모달). 입력 칸은 5개까지 */
export interface ModalSpec {
  customId: string;
  title: string;
  inputs: { id: string; label: string; value?: string; placeholder?: string; required?: boolean; paragraph?: boolean; maxLength?: number }[];
}

export type CommandResult = Reply | { modal: ModalSpec };
/** 버튼 결과: 메시지 자체를 바꾸거나(OutgoingMessage), 누른 사람에게만 답하거나(reply), 입력 창을 띄운다(modal) */
export type ButtonResult = OutgoingMessage | { reply: Reply } | { modal: ModalSpec } | null;

/** 누른·친 사람 정보 */
export interface InteractionCtx {
  userId: string;
  /** 서버 관리 권한(Manage Server)이 있는지 */
  isAdmin: boolean;
  /** 서버 안에서의 역할 ID (DM이면 빈 배열) */
  memberRoleIds: string[];
}

export interface CommandContext extends InteractionCtx {
  wsPingMs: number;
  getString(option: string): string | null;
  /** 하위 명령 이름 (/관리 소스 → '소스') */
  subcommand: string | null;
  /** 메시지 우클릭 명령의 대상 메시지 */
  targetMessage?: { id: string; channelId: string; url: string; content: string; authorId: string };
}

export interface DiscordBotOptions {
  token: string;
  appId: string;
  guildId: string;
  /** 슬래시 명령·메시지 우클릭 명령 응답. 모르는 명령이면 null */
  onCommand: (name: string, ctx: CommandContext) => Promise<CommandResult | null>;
  /** 명령 옵션 자동완성 후보 (최대 25개) */
  onAutocomplete?: (name: string, focused: { name: string; value: string }, ctx: InteractionCtx) => Promise<{ name: string; value: string }[]>;
  /** 버튼을 눌렀을 때. 모르는 버튼이면 null */
  onButton?: (customId: string, ctx: InteractionCtx) => Promise<ButtonResult>;
  /** 입력 창 제출 */
  onModal?: (customId: string, fields: Record<string, string>, ctx: InteractionCtx) => Promise<Reply>;
  /** 봇을 멘션한 질문에 대한 답. null이면 답하지 않는다 */
  onMention?: (question: string, ctx: { userId: string; channelId: string }) => Promise<string | null>;
  /** 봇 상태 메시지(프로필 아래 한 줄). 준비될 때와 10분마다 갱신 */
  presence?: () => Promise<string>;
  /** 처음 준비됐을 때 한 번 */
  onReady?: (tag: string) => void | Promise<void>;
  /** 명령·버튼·입력 창 처리 중 오류 (관리자 경보용) */
  onError?: (where: string, err: unknown) => void | Promise<void>;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
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

/** 서버 멤버 (기본 구독 동기화용) */
export interface MemberInfo {
  id: string;
  bot: boolean;
  roles: string[];
}

export interface PostOptions {
  /** 카드 위에 이 역할을 멘션해 알림을 보낸다 */
  mentionRoleId?: string;
  /** 이 메시지에 답장으로 보낸다 (지워졌으면 그냥 보낸다) */
  replyTo?: string;
}

export interface DiscordBot extends ChannelSender {
  state(): BotState;
  sendDm(userId: string, message: OutgoingMessage): Promise<void>;
  /** 채널에 보내고 메시지 ID를 돌려준다 (검수 카드·공지처럼 나중에 찾아야 하는 메시지) */
  post(channelId: string, message: OutgoingMessage, opts?: PostOptions): Promise<string>;
  /** 봇이 보낸 메시지를 고친다. 메시지가 지워졌으면 code 10008 오류 */
  editMessage(channelId: string, messageId: string, message: OutgoingMessage): Promise<void>;
  /** 메시지에서 공개 스레드를 연다 (일주일 동안 조용하면 보관). 스레드 ID를 돌려준다 */
  startThread(channelId: string, messageId: string, name: string): Promise<string>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  /** 그림 파일 한 장을 글과 함께 올린다 (월간 달력) */
  postFile(channelId: string, content: string, file: { name: string; data: Buffer }): Promise<string>;
  /** 봇이 보낸 메시지를 지운다 (이미 없으면 무시) */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** 역할이 있으면 그 ID, 없으면 이름으로 찾고, 그래도 없으면 만든다 */
  ensureRole(spec: { id?: string; name: string; color: number }): Promise<string>;
  /** 서버 멤버 1000명씩 (Developer Portal에서 Server Members Intent가 켜져 있어야 함) */
  listMembers(after?: string): Promise<MemberInfo[]>;
  addMemberRole(userId: string, roleId: string): Promise<void>;
  removeMemberRole(userId: string, roleId: string): Promise<void>;
  /** 봇에게 없는 권한 이름 (서버 전체 + channelId 채널 기준) */
  missingPermissions(channelId?: string): Promise<string[]>;
  /** 봇의 가장 높은 역할보다 아래가 아닌 역할 이름 (봇이 줄 수 없는 역할) */
  rolesNotBelowBot(roleIds: string[]): Promise<string[]>;
  /** 서버 예약 이벤트를 만들 권한(이벤트 만들기 또는 이벤트 관리)이 있는지 */
  canManageEvents(): Promise<boolean>;
  createGuildEvent(spec: GuildEventSpec): Promise<string>;
  editGuildEvent(id: string, spec: GuildEventSpec): Promise<void>;
  deleteGuildEvent(id: string): Promise<void>;
  stop(): Promise<void>;
}

/** 디스코드 API 오류 코드 (10008 메시지 없음, 10003 채널 없음, 50007 DM 불가, 50013 권한 없음) */
export const discordErrorCode = (err: unknown): number | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
};

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
 * 역할 멘션을 붙인 메시지. 카드는 맨 위에 멘션 한 줄(Text Display)을 넣고, 대체 본문은 content 앞에 붙인다.
 * 텍스트 표시 컴포넌트 안의 멘션도 allowedMentions가 허용하면 알림이 간다.
 */
export function withRoleMention(msg: OutgoingMessage, roleId: string | undefined): OutgoingMessage {
  if (!roleId) return msg;
  const mention = `<@&${roleId}>`;
  return {
    ...msg,
    content: msg.content ? `${mention}\n${msg.content}` : mention,
    ...(msg.card ? { card: [{ type: ComponentType.TextDisplay, content: mention }, ...msg.card] } : {}),
  };
}

/**
 * 봇을 시작한다. 로그인에 실패해도 예외를 던지지 않고 state()가 'error'가 되며, 1·2·5·10분 간격으로 다시 시도한다.
 * 디스코드 장애로 수집까지 멈추지 않게 하기 위해서다. 상태는 /health와 로그로 확인한다.
 */
export function startDiscordBot(opts: DiscordBotOptions): DiscordBot {
  const log = opts.log ?? console;
  // 채널 발송·슬래시 명령은 Guilds, 멘션 질문은 GuildMessages.
  // 봇을 멘션한 메시지는 MessageContent(특권 인텐트) 없이도 본문이 온다.
  // 멤버 목록은 게이트웨이가 아니라 REST(List Guild Members)로 읽으므로 GuildMembers 인텐트를 접속에 넣지 않는다.
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  let state: BotState = 'connecting';
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function updatePresence() {
    if (!opts.presence || !client.isReady()) return;
    try {
      const text = (await opts.presence()).slice(0, 128);
      client.user.setPresence({ activities: [{ name: text, state: text, type: ActivityType.Custom }], status: 'online' });
    } catch (err) {
      log.warn(`봇 상태 메시지 갱신 실패: ${errText(err)}`);
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
      log.error(`슬래시 명령 등록 실패: ${errText(err)}`);
    }
    try {
      await opts.onReady?.(c.user.tag);
    } catch (err) {
      log.error(`onReady 처리 실패: ${errText(err)}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction).catch((err: unknown) => log.error(`자동완성 실패 (/${interaction.commandName}): ${errText(err)}`));
      return;
    }
    if (interaction.isButton()) {
      await handleButton(interaction).catch((err: unknown) => failed(interaction, `버튼 ${interaction.customId}`, err));
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModal(interaction).catch((err: unknown) => failed(interaction, `입력 창 ${interaction.customId}`, err));
      return;
    }
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) return;
    await handleCommand(interaction).catch((err: unknown) => {
      const sub = interaction.isChatInputCommand() ? interaction.options.getSubcommand(false) : null;
      return failed(interaction, `/${interaction.commandName}${sub ? ` ${sub}` : ''}`, err);
    });
  });

  type Repliable = ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

  /**
   * 처리 중 오류: 누른 사람에게 원인을 짧게 보여 주고(디스코드 API 오류 문구, 시크릿 없음), 로그와 관리자 경보에 남긴다.
   * 이미 답했으면 생략, 응답을 미뤄 둔(defer) 상태면 그 응답을 고친다.
   */
  async function failed(i: Repliable, where: string, err: unknown) {
    log.error(`${where} 처리 실패: ${errText(err)}`);
    await Promise.resolve(opts.onError?.(where, err)).catch(() => undefined);
    const code = (err as { code?: unknown } | null)?.code;
    const content = `처리 중에 문제가 생겼어요: ${errText(err).slice(0, 300)}${typeof code === 'number' ? ` (${code})` : ''}`;
    if (i.deferred && !i.replied) await i.editReply({ content }).catch(() => undefined);
    else if (!i.replied) await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }

  /**
   * 디스코드는 3초 안에 응답해야 한다. 2초 안에 결과가 안 나오면 "생각 중"으로 미뤄 두고(deferReply) 끝나면 그 응답을 고친다.
   * 입력 창(모달)은 미룬 뒤에는 열 수 없으므로 안내 문구로 바꾼다.
   */
  async function respond(i: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ModalSubmitInteraction, produce: () => Promise<CommandResult | null>) {
    let deferring: Promise<unknown> | undefined;
    const timer = setTimeout(() => {
      deferring = i.deferReply({ flags: MessageFlags.Ephemeral }).catch((err: unknown) => log.warn(`응답 미루기 실패: ${errText(err)}`));
    }, 2000);
    let result: CommandResult | null;
    try {
      result = await produce();
    } finally {
      clearTimeout(timer);
      await deferring;
    }
    if (result === null) {
      if (i.deferred) await i.deleteReply().catch(() => undefined);
      return;
    }
    if (typeof result === 'object' && 'modal' in result) {
      if (i.deferred || i.isModalSubmit()) {
        await replyEphemeral(i, '입력 창을 여는 데 시간이 걸렸어요. 한 번 더 실행해 주세요.');
        return;
      }
      await i.showModal(modalPayload(result.modal));
      return;
    }
    await replyEphemeral(i, result);
  }

  function interactionCtx(i: { user: { id: string }; member: unknown; memberPermissions: { has(p: bigint): boolean } | null }): InteractionCtx {
    const member = i.member as GuildMember | { roles?: string[] } | null;
    const roles = !member
      ? []
      : Array.isArray((member as { roles?: unknown }).roles)
        ? ((member as { roles: string[] }).roles)
        : [...((member as GuildMember).roles?.cache?.keys() ?? [])];
    return { userId: i.user.id, isAdmin: i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false, memberRoleIds: roles };
  }

  /** 응답(문자열·카드)을 누른 사람에게만 보이게 보낸다. 미뤄 둔 응답이면 그 응답을 고친다 */
  async function replyEphemeral(i: Repliable, content: Reply) {
    const msg = typeof content === 'string' ? { content } : content;
    if (i.deferred && !i.replied) {
      await sendWithFallback(
        msg,
        (card) => i.editReply({ components: card, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
        (plain) => i.editReply({ content: plain.content ?? null, embeds: plain.embeds ?? [], allowedMentions: { parse: [] } }),
        log,
      );
      return;
    }
    await sendWithFallback(
      msg,
      (card) => i.reply({ components: card, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
      (plain) => i.reply({ ...plain, flags: MessageFlags.Ephemeral }),
      log,
    );
  }

  /** 입력 창: Label(18) 안에 TextInput(4) */
  function modalPayload(spec: ModalSpec) {
    return {
      custom_id: spec.customId,
      title: spec.title.slice(0, 45),
      components: spec.inputs.slice(0, 5).map((f) => ({
        type: ComponentType.Label as const,
        label: f.label.slice(0, 45),
        component: {
          type: ComponentType.TextInput as const,
          custom_id: f.id,
          style: f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
          required: f.required ?? false,
          ...(f.value ? { value: f.value.slice(0, f.maxLength ?? 4000) } : {}),
          ...(f.placeholder ? { placeholder: f.placeholder.slice(0, 100) } : {}),
          ...(f.maxLength ? { max_length: f.maxLength } : {}),
        },
      })),
    };
  }

  // 멘션 질문: 같은 사람은 15초에 한 번, 동시에 2건까지
  const lastAsked = new Map<string, number>();
  let answering = 0;
  client.on(Events.MessageCreate, async (message: Message) => {
    if (!opts.onMention || message.author.bot || !client.user || !message.inGuild()) return;
    if (!message.mentions.users.has(client.user.id) || message.mentions.everyone) return;
    const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const reply = (content: string) =>
      message.reply({ content: truncate(content), allowedMentions: { parse: [], repliedUser: false } }).catch((err: unknown) =>
        log.error(`멘션 답장 실패: ${errText(err)}`),
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
      log.error(`멘션 질문 처리 실패: ${errText(err)}`);
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

  async function handleCommand(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction) {
    const ctx: CommandContext = {
      ...interactionCtx(interaction),
      wsPingMs: client.ws.ping,
      getString: (o) => (interaction.isChatInputCommand() ? interaction.options.getString(o) : null),
      subcommand: interaction.isChatInputCommand() ? interaction.options.getSubcommand(false) : null,
    };
    if (interaction.isMessageContextMenuCommand()) {
      const m = interaction.targetMessage;
      ctx.targetMessage = { id: m.id, channelId: m.channelId, url: m.url, content: m.content ?? '', authorId: m.author.id };
    }
    // 명령 응답은 친 사람에게만 보인다
    await respond(interaction, () => opts.onCommand(interaction.commandName, ctx));
  }

  async function handleAutocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (!opts.onAutocomplete || focused.type !== ApplicationCommandOptionType.String) {
      await interaction.respond([]);
      return;
    }
    const choices = await opts.onAutocomplete(interaction.commandName, { name: focused.name, value: String(focused.value) }, interactionCtx(interaction));
    await interaction.respond(choices.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) })));
  }

  async function handleButton(interaction: ButtonInteraction) {
    const result = opts.onButton ? await opts.onButton(interaction.customId, interactionCtx(interaction)) : null;
    if (result && 'modal' in result) {
      await interaction.showModal(modalPayload(result.modal));
      return;
    }
    if (result && 'reply' in result) {
      await replyEphemeral(interaction, result.reply);
      return;
    }
    if (!result?.card) {
      await interaction.deferUpdate();
      return;
    }
    await interaction.update({ components: result.card, allowedMentions: { parse: [] } });
  }

  async function handleModal(interaction: ModalSubmitInteraction) {
    if (!opts.onModal) return;
    const fields: Record<string, string> = {};
    for (const [id, f] of interaction.fields.fields) {
      const value = (f as { value?: unknown }).value;
      if (typeof value === 'string') fields[id] = value;
    }
    await respond(interaction, () => opts.onModal!(interaction.customId, fields, interactionCtx(interaction)));
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
        log.error(`디스코드 로그인 실패: ${errText(err)}`);
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

  async function sendable(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) throw new Error(`메시지를 보낼 수 없는 채널입니다: ${channelId}`);
    return channel;
  }
  const guild = () => client.guilds.fetch(opts.guildId);

  /** 역할 멘션·답장을 붙여 보내고 메시지 ID를 돌려준다 */
  async function post(channelId: string, message: OutgoingMessage, o: PostOptions = {}) {
    const channel = await sendable(channelId);
    const msg = withRoleMention(message, o.mentionRoleId);
    const allowedMentions = { parse: [] as [], roles: o.mentionRoleId ? [o.mentionRoleId] : [], repliedUser: false };
    const reply = o.replyTo ? { reply: { messageReference: o.replyTo, failIfNotExists: false } } : {};
    let id = '';
    await sendWithFallback(
      msg,
      async (card) => (id = (await channel.send({ components: card, flags: MessageFlags.IsComponentsV2, allowedMentions, ...reply })).id),
      async (plain) => (id = (await channel.send({ ...plain, allowedMentions, ...reply })).id),
      log,
    );
    return id;
  }

  return {
    state: () => state,
    isReady: () => state === 'ready' && client.isReady(),
    async send(channelId: string, message: OutgoingMessage) {
      await post(channelId, message);
    },
    post,
    async editMessage(channelId: string, messageId: string, message: OutgoingMessage) {
      const channel = await sendable(channelId);
      await sendWithFallback(
        message,
        (card) => channel.messages.edit(messageId, { components: card, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }),
        (plain) => channel.messages.edit(messageId, { content: plain.content ?? null, embeds: plain.embeds ?? [], allowedMentions: { parse: [] } }),
        log,
      );
    },
    async startThread(channelId: string, messageId: string, name: string) {
      const thread = (await client.rest.post(Routes.threads(channelId, messageId), {
        body: { name: name.slice(0, 100) || '행사 소식', auto_archive_duration: 10080 },
      })) as { id: string };
      return thread.id;
    },
    async postFile(channelId: string, content: string, file: { name: string; data: Buffer }) {
      const channel = await sendable(channelId);
      const sent = await channel.send({ content: truncate(content), files: [{ attachment: file.data, name: file.name }], allowedMentions: { parse: [] } });
      return sent.id;
    },
    async deleteMessage(channelId: string, messageId: string) {
      await client.rest.delete(Routes.channelMessage(channelId, messageId)).catch((err: unknown) => {
        if (discordErrorCode(err) !== 10008) throw err;
      });
    },
    async pinMessage(channelId: string, messageId: string) {
      const channel = await sendable(channelId);
      await (await channel.messages.fetch(messageId)).pin();
    },
    async ensureRole(spec: { id?: string; name: string; color: number }) {
      const g = await guild();
      if (spec.id) {
        const role = await g.roles.fetch(spec.id).catch(() => null);
        if (role) return role.id;
      }
      const found = (await g.roles.fetch()).find((r) => r.name === spec.name);
      if (found) return found.id;
      const created = await g.roles.create({ name: spec.name, colors: { primaryColor: spec.color }, mentionable: true, reason: '미쿠 행사 알림 구독 역할' });
      return created.id;
    },
    async listMembers(after?: string) {
      const g = await guild();
      const members = await g.members.list({ limit: 1000, ...(after ? { after } : {}), cache: false });
      return [...members.values()].map((m) => ({ id: m.id, bot: m.user.bot, roles: [...m.roles.cache.keys()] }));
    },
    async addMemberRole(userId: string, roleId: string) {
      await client.rest.put(Routes.guildMemberRole(opts.guildId, userId, roleId), { reason: '미쿠 행사 알림 구독' });
    },
    async removeMemberRole(userId: string, roleId: string) {
      await client.rest.delete(Routes.guildMemberRole(opts.guildId, userId, roleId), { reason: '미쿠 행사 알림 구독 해제' });
    },
    async missingPermissions(channelId?: string) {
      const g = await guild();
      const me = await g.members.fetchMe();
      const missing: string[] = [];
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) missing.push('역할 관리');
      if (channelId) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        const perms = ch && 'permissionsFor' in ch ? ch.permissionsFor(me) : null;
        if (!perms) missing.push('채널 보기');
        else {
          // 채널 권한: 공지·답장(메시지 기록 보기 필요)·스레드·고정
          const need: [bigint, string][] = [
            [PermissionFlagsBits.ViewChannel, '채널 보기'],
            [PermissionFlagsBits.SendMessages, '메시지 보내기'],
            [PermissionFlagsBits.EmbedLinks, '링크 첨부'],
            [PermissionFlagsBits.ReadMessageHistory, '메시지 기록 보기'],
            [PermissionFlagsBits.CreatePublicThreads, '공개 스레드 만들기'],
            [PermissionFlagsBits.SendMessagesInThreads, '스레드에서 메시지 보내기'],
          ];
          for (const [flag, name] of need) if (!perms.has(flag)) missing.push(name);
          if (!perms.has(PermissionFlagsBits.PinMessages) && !perms.has(PermissionFlagsBits.ManageMessages)) missing.push('메시지 고정');
        }
      }
      return missing;
    },
    async rolesNotBelowBot(roleIds: string[]) {
      const g = await guild();
      const me = await g.members.fetchMe();
      const top = me.roles.highest.position;
      const out: string[] = [];
      for (const id of roleIds) {
        const role = await g.roles.fetch(id).catch(() => null);
        if (role && role.position >= top) out.push(role.name);
      }
      return out;
    },
    async canManageEvents() {
      const me = await (await guild()).members.fetchMe();
      return me.permissions.has(PermissionFlagsBits.CreateEvents) || me.permissions.has(PermissionFlagsBits.ManageEvents);
    },
    async createGuildEvent(spec: GuildEventSpec) {
      const g = await guild();
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
        return (await g.scheduledEvents.create({ ...base, ...(spec.imageUrl ? { image: spec.imageUrl } : {}) })).id;
      } catch (err) {
        if (!spec.imageUrl) throw err;
        log.warn(`서버 이벤트 커버 이미지 없이 다시 만듭니다: ${errText(err)}`);
        return (await g.scheduledEvents.create(base)).id;
      }
    },
    async editGuildEvent(id: string, spec: GuildEventSpec) {
      const g = await guild();
      await g.scheduledEvents.edit(id, {
        name: spec.name.slice(0, 100),
        description: spec.description.slice(0, 1000),
        scheduledStartTime: spec.startIso,
        scheduledEndTime: spec.endIso,
        entityMetadata: { location: spec.location.slice(0, 100) },
      });
    },
    async deleteGuildEvent(id: string) {
      const g = await guild();
      await g.scheduledEvents.delete(id);
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
