import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { getDiagnostics } from '../services/diagnostics.js';
import { getServiceStatus } from '../services/status.js';
import { listCollectionPlan, listSourceStatuses } from '../services/sources.js';
import { listRecentRawItems } from '../services/rawItems.js';
import { eventLinks, getEventDetail, listUpcomingEvents, parseEventScope, type EventScope } from '../services/events.js';
import {
  TIER_KO,
  addKeyword,
  editDefaults,
  editEvent,
  eventChoices,
  getEvent,
  listKeywords,
  mergeEvents,
  parseEventEdit,
  removeKeyword,
  setEventHidden,
  setEventKind,
  type EventKind,
  sourceAction,
  sourceChoices,
  type KeywordTier,
  type SourceAction,
} from '../services/admin.js';
import { SETTING, deleteSetting, isNotifyPaused, setSetting } from '../services/settings.js';
import { EVENT_KINDS, KEYWORD_TIERS } from '../db/schema.js';
import { buildDiagnosticsReply, buildEventsReply, buildPingReply, buildRecentReply, buildSourcesReply } from './commands.js';
import { buildGuideReply } from './guide.js';
import { EVENTS_PAGE_SIZE, eventDetailCard, myAlertsCard, parseEventsPageId, searchResultsCard } from './cards.js';
import { decideDupPair, decideReview, parseDupId, parseReviewId } from './review.js';
import { parseSubId, roleIds, subscriptionLine, toggleSubscription } from './subscriptions.js';
import { myEvents, parseGoId, parseWatchId, toggleGoing, toggleWatch } from './watchers.js';
import { createReport, firstUrl, postReportCard } from './reports.js';
import { noticeThreadUrl, refreshNoticeCard, removeNotice, type NoticeDeliveryDeps } from './noticeThreads.js';
import { KIND_GROUPS, kindLabel, parseKindGroup, type KindGroup } from './labels.js';
import { planForChange } from './planner.js';
import { createAdminPanel, isAdminPanelId, type AdminOps } from './adminPanel.js';
import { statusBoardData, statusBoardMessage } from './statusBoard.js';
import type { ButtonResult, CommandContext, CommandResult, DiscordBot, DiscordBotOptions, InteractionCtx, Reply } from './discord.js';
import type { Notifier } from './notifier.js';

/**
 * 슬래시 명령·자동완성·버튼·입력 창 처리. 조회는 services/를 쓰고, 디스코드 표시는 cards·commands가 맡는다.
 */
export interface InteractionDeps {
  db: Db;
  bot: () => DiscordBot | undefined;
  notifier: Notifier;
  guildId?: string;
  noticeChannelId?: string;
  adminChannelId?: string;
  notifyPausedEnv?: boolean;
  uptimeSec: () => number;
  /** /관리 중복검사: 이미 등록된 행사끼리 같은 행사인지 검사 (Claude 키가 없으면 undefined) */
  dupSweep?: () => Promise<{ checked: number; flagged: number; more: boolean }>;
  /** /관리 달력: 이번 달 달력을 공지 채널에 올린다 */
  postCalendar?: () => Promise<string>;
  /** 관리 패널(상태판) 메시지를 지금 고친다 */
  refreshBoard?: () => Promise<unknown>;
  /** /관리 설정: 역할·패널·상태판을 지금 다시 맞춘다 */
  setupNow?: () => Promise<{ missing?: string[]; members?: { added: number; initialized: number; failed: number } | null; memberError?: string; errors?: string[] } | null>;
  now?: () => Date;
}

const ADMIN_ONLY = '관리자(서버 관리 권한)만 쓸 수 있어요.';

export function createInteractionHandlers(deps: InteractionDeps): Pick<DiscordBotOptions, 'onCommand' | 'onAutocomplete' | 'onButton' | 'onSelect' | 'onModal'> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const noticeDeps = (): NoticeDeliveryDeps => ({ db, notifier: deps.notifier, noticeChannelId: deps.noticeChannelId, bot: deps.bot() });

  /** /행사 한 페이지. 카드 버튼 링크(예매·원문)는 그 페이지 행사만 조회한다. */
  const eventsPage = async (scope: EventScope, page: number, kind?: KindGroup) => {
    const rows = await listUpcomingEvents(db, { scope, limit: 200, kinds: kind ? KIND_GROUPS[kind].kinds : undefined });
    const p = Math.min(Math.max(0, page), Math.max(0, Math.ceil(rows.length / EVENTS_PAGE_SIZE) - 1));
    const links = await eventLinks(db, rows.slice(p * EVENTS_PAGE_SIZE, (p + 1) * EVENTS_PAGE_SIZE));
    return buildEventsReply(rows, scope, p, links, kind);
  };

  const detail = async (id: number, opts: { admin?: boolean } = {}): Promise<Reply> => {
    const d = await getEventDetail(db, id);
    if (!d || (!opts.admin && (d.event.needsReview !== 0 || d.event.mergedInto))) return '행사를 찾을 수 없어요.';
    return { card: eventDetailCard(d, { threadUrl: await noticeThreadUrl(db, deps.guildId, id) }), content: `${d.event.title} (#${d.event.id})` };
  };

  /** /행사 검색: 번호면 상세, 한 건이면 상세, 여러 건이면 목록 */
  const search = async (q: string): Promise<Reply> => {
    const term = q.trim();
    if (/^#?\d+$/.test(term)) return detail(Number(term.replace('#', '')));
    const choices = await eventChoices(db, term, { publicOnly: true });
    if (choices.length === 1) return detail(Number(choices[0]!.value));
    const ids = choices.map((c) => Number(c.value));
    const rows = ids.length ? await db.select().from(events).where(inArray(events.id, ids)) : [];
    rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return { card: searchResultsCard(term, rows, await eventLinks(db, rows.slice(0, EVENTS_PAGE_SIZE))), content: `"${term}" 검색 결과 ${rows.length}건` };
  };

  /** 자동완성으로 고르지 않고 글자만 친 경우도 첫 후보로 찾는다 */
  const resolveEventId = async (v: string | null): Promise<number | null> => {
    const t = (v ?? '').trim();
    if (/^#?\d+$/.test(t)) return Number(t.replace('#', ''));
    const [first] = t ? await eventChoices(db, t) : [];
    return first ? Number(first.value) : null;
  };

  const report = async (ctx: CommandContext, input: { url?: string; note?: string; messageUrl?: string }): Promise<Reply> => {
    const r = await createReport(db, { reporterId: ctx.userId, ...input }, now());
    if (!r.ok) return r.reason;
    const bot = deps.bot();
    if (bot?.isReady() && deps.adminChannelId) await postReportCard(db, bot, deps.adminChannelId, r.reportId).catch(() => undefined);
    return '📮 제보 고마워요! Claude가 1~2분 안에 판정해서 미쿠 행사가 맞으면 공지 채널에 올려요.';
  };

  /** 관리 작업 (명령 /관리 와 관리 패널 버튼이 같이 쓴다) */
  const ops: AdminOps = {
    editModal(e) {
      const v = editDefaults(e);
      return {
        customId: `ed:${e.id}`,
        title: `행사 #${e.id} 수정`,
        inputs: [
          { id: 'title', label: '제목', value: v.title, required: true, maxLength: 200 },
          { id: 'dates', label: '일정 (2026-12-04 ~ 2026-12-06)', value: v.dates, placeholder: '비우면 미정', maxLength: 30 },
          { id: 'venue', label: '장소 (도시 / 장소)', value: v.venue, placeholder: '예: 고양 / 킨텍스 제2전시장', maxLength: 150 },
          { id: 'ticket_open', label: '티켓 오픈 (한국 시간)', value: v.ticket_open, placeholder: '2026-12-01 20:00, 비우면 미정', maxLength: 20 },
          { id: 'ticket_url', label: '예매 링크', value: v.ticket_url, placeholder: 'https://', maxLength: 500 },
        ],
      };
    },
    async setKind(e, kind, userId) {
      if (!(EVENT_KINDS as readonly string[]).includes(kind)) return '바꿀 유형을 골라 주세요.';
      const updated = await setEventKind(db, e.id, kind as EventKind, userId, now());
      if (updated) await refreshNoticeCard(noticeDeps(), updated).catch(() => false);
      return `🏷️ #${e.id} **${e.title}** 유형: ${kindLabel(e.kind)} → ${kindLabel(kind)}`;
    },
    async setHidden(e, hidden) {
      await setEventHidden(db, e.id, hidden, now());
      return hidden
        ? `🙈 #${e.id} **${e.title}**을(를) 숨겼어요. 목록·검색·서버 이벤트에서 빠지고 알림도 보내지 않아요.`
        : `👀 #${e.id} **${e.title}**을(를) 다시 보이게 했어요.`;
    },
    async merge(keep, absorb, userId) {
      const text = await mergeEvents(db, keep, absorb, userId, now());
      if (!text.startsWith('🔗')) return text;
      // 흡수한 행사의 공지는 지우고, 남긴 행사의 공지 카드는 채워진 내용으로 고친다
      const removed = await removeNotice(noticeDeps(), absorb, keep, deps.guildId).catch(() => false);
      const kept = await getEvent(db, keep);
      if (kept) await refreshNoticeCard(noticeDeps(), kept).catch(() => false);
      return `${text}${removed ? '\n중복 공지는 지웠어요.' : ''}`;
    },
    async notify(action) {
      if (action === 'toggle') action = (await isNotifyPaused(db)) ? 'resume' : 'pause';
      if (action === 'pause') await setSetting(db, SETTING.notifyPaused, '1', now());
      if (action === 'resume') await deleteSetting(db, SETTING.notifyPaused);
      const paused = await isNotifyPaused(db, deps.notifyPausedEnv);
      const env = deps.notifyPausedEnv ? '\n-# 환경 변수 NOTIFY_PAUSED=1이 켜져 있어 여기서 재개해도 보내지 않아요. Railway 변수에서 지워 주세요.' : '';
      return `${paused ? '⏸️ 알림 일시정지 중: 알림은 쌓아 두고 보내지 않아요.' : '▶️ 알림을 보내고 있어요.'}${env}`;
    },
    async dupSweep() {
      if (!deps.dupSweep) return '중복 검사는 Claude API 키(ANTHROPIC_API_KEY)가 있어야 해요.';
      const r = await deps.dupSweep();
      return [
        `🔁 다가오는 행사 중 겹쳐 보이는 ${r.checked}건을 확인했어요. 같은 행사로 의심되는 쌍: **${r.flagged}건**`,
        r.flagged ? '1분 안에 관리자 채널에 [같은 행사로 합치기]·[별개 행사] 카드가 올라와요.' : '',
        r.more ? '확인할 행사가 더 있어요. 한 번 더 실행해 주세요.' : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
    async calendar() {
      return deps.postCalendar ? deps.postCalendar() : '봇이 준비되지 않았어요.';
    },
    async setup() {
      const r = await deps.setupNow?.();
      if (!r) return '봇이 준비되지 않았거나 공지 채널이 설정되지 않았어요.';
      const lines = ['🔧 알림 역할·구독 패널·상태판을 다시 맞췄어요.'];
      if (r.members) lines.push(`👥 국내 알림 역할: 이번에 ${r.members.added}명에게 줬어요${r.members.failed ? ` · 실패 ${r.members.failed}명` : ''} (새로 확인한 멤버 ${r.members.initialized}명)`);
      if (r.memberError) lines.push(`⚠️ ${r.memberError}`);
      if (r.missing?.length) lines.push(`⚠️ 부족한 권한: ${r.missing.join(', ')}`);
      for (const e of r.errors ?? []) lines.push(`⚠️ ${e}`);
      return lines.join('\n').slice(0, 1900);
    },
    detail: (id) => detail(id, { admin: true }),
    diagnostics: async () => buildDiagnosticsReply(await getDiagnostics(db)),
    board: async () => statusBoardMessage(await statusBoardData(db, now(), deps.notifyPausedEnv)),
    refreshBoard: async () => {
      await deps.refreshBoard?.().catch(() => undefined);
    },
  };
  const panel = createAdminPanel({ db, ops, now });

  async function admin(ctx: CommandContext): Promise<CommandResult | null> {
    if (!ctx.isAdmin) return ADMIN_ONLY;
    switch (ctx.subcommand) {
      case '소스':
        return sourceAction(db, ctx.getString('이름') ?? '', (ctx.getString('동작') ?? 'run') as SourceAction);
      case '키워드': {
        const action = ctx.getString('동작');
        const term = ctx.getString('단어') ?? '';
        if (action === 'list') {
          const k = await listKeywords(db);
          return KEYWORD_TIERS.map((t) => `**${TIER_KO[t]}** (${k[t].length}) ${k[t].join(', ') || '없음'}`).join('\n').slice(0, 1900);
        }
        if (!term.trim()) return '단어를 입력해 주세요.';
        return action === 'remove' ? removeKeyword(db, term) : addKeyword(db, term, (ctx.getString('등급') ?? 'strong') as KeywordTier);
      }
      case '행사': {
        const id = await resolveEventId(ctx.getString('행사'));
        const e = id ? await getEvent(db, id) : undefined;
        if (!e) return '행사를 찾을 수 없어요. 입력 중에 뜨는 목록에서 골라 주세요.';
        const action = ctx.getString('동작');
        if (action === 'edit') return { modal: ops.editModal(e) };
        if (action === 'kind') return ops.setKind(e, ctx.getString('유형') ?? '', ctx.userId);
        return ops.setHidden(e, action === 'hide');
      }
      case '합치기': {
        const keep = await resolveEventId(ctx.getString('남길행사'));
        const absorb = await resolveEventId(ctx.getString('합칠행사'));
        if (!keep || !absorb) return '행사를 찾을 수 없어요. 입력 중에 뜨는 목록에서 골라 주세요.';
        return ops.merge(keep, absorb, ctx.userId);
      }
      case '알림': {
        const action = ctx.getString('동작');
        return ops.notify(action === 'pause' || action === 'resume' ? action : 'status');
      }
      case '중복검사':
        return ops.dupSweep();
      case '달력':
        return ops.calendar();
      case '설정':
        return ops.setup();
      default:
        return null;
    }
  }

  return {
    async onCommand(name, ctx) {
      switch (name) {
        case 'ping':
          return buildPingReply({ status: await getServiceStatus(db), wsPingMs: ctx.wsPingMs, uptimeSec: deps.uptimeSec() });
        case '소스':
          return buildSourcesReply(await listSourceStatuses(db));
        case '최근수집':
          return buildRecentReply(await listRecentRawItems(db, 15));
        case '행사': {
          const q = ctx.getString('검색');
          return q ? search(q) : eventsPage(parseEventScope(ctx.getString('범위')), 0, parseKindGroup(ctx.getString('유형')));
        }
        case '점검':
          return buildDiagnosticsReply(await getDiagnostics(db));
        case '가이드':
          return buildGuideReply(await listCollectionPlan(db));
        case '내알림': {
          const { watching, going } = await myEvents(db, ctx.userId);
          const line = subscriptionLine(await roleIds(db), ctx.memberRoleIds);
          return { card: myAlertsCard(line, watching, going), content: `지역 알림: ${line}\n🔔 ${watching.map((e) => e.title).join(', ') || '없음'}` };
        }
        case '제보':
          return report(ctx, { url: ctx.getString('링크') ?? undefined, note: ctx.getString('메모') ?? undefined });
        case '행사 제보': {
          const m = ctx.targetMessage;
          if (!m) return null;
          return report(ctx, { url: firstUrl(m.content), note: m.content, messageUrl: m.url });
        }
        case '관리':
          return admin(ctx);
        default:
          return null;
      }
    },

    async onAutocomplete(name, focused, ctx: InteractionCtx) {
      if (name === '행사' && focused.name === '검색') return eventChoices(db, focused.value, { publicOnly: true });
      if (name !== '관리' || !ctx.isAdmin) return [];
      if (focused.name === '이름') return sourceChoices(db, focused.value);
      if (['행사', '남길행사', '합칠행사'].includes(focused.name)) return eventChoices(db, focused.value);
      return [];
    },

    async onSelect(customId, values, ctx): Promise<ButtonResult> {
      if (!isAdminPanelId(customId)) return null;
      if (!ctx.isAdmin) return { reply: ADMIN_ONLY };
      return panel.onComponent(customId, values, ctx);
    },

    async onButton(customId, ctx): Promise<ButtonResult> {
      if (isAdminPanelId(customId)) {
        if (!ctx.isAdmin) return { reply: ADMIN_ONLY };
        return panel.onComponent(customId, [], ctx);
      }
      const page = parseEventsPageId(customId);
      if (page) return eventsPage(parseEventScope(page.scope), page.page, parseKindGroup(page.kind));
      const review = parseReviewId(customId);
      if (review) {
        if (!ctx.isAdmin) return { reply: ADMIN_ONLY };
        return (await decideReview(db, review.eventId, review.decision, ctx.userId))?.message ?? null;
      }
      const region = parseSubId(customId);
      if (region) {
        const bot = deps.bot();
        if (!bot?.isReady()) return { reply: '봇이 아직 준비되지 않았어요. 잠시 뒤에 다시 눌러 주세요.' };
        return { reply: await toggleSubscription(db, bot, ctx, region, now()) };
      }
      const watch = parseWatchId(customId);
      if (watch) return { reply: await toggleWatch(db, watch, ctx.userId, now()) };
      const go = parseGoId(customId);
      if (go) {
        const r = await toggleGoing(db, go, ctx.userId, now());
        if (r.changed) {
          // 공지 카드의 참석 수를 맞춘다
          const e = await getEvent(db, go);
          if (e) await refreshNoticeCard(noticeDeps(), e).catch(() => false);
        }
        return { reply: r.reply };
      }
      const dupPair = parseDupId(customId);
      if (dupPair) {
        if (!ctx.isAdmin) return { reply: ADMIN_ONLY };
        const r = await decideDupPair(db, dupPair.eventId, dupPair.decision, ctx.userId, now());
        if (r?.mergedInto) {
          await removeNotice(noticeDeps(), dupPair.eventId, r.mergedInto, deps.guildId).catch(() => false);
          const kept = await getEvent(db, r.mergedInto);
          if (kept) await refreshNoticeCard(noticeDeps(), kept).catch(() => false);
        }
        return r?.message ?? null;
      }
      return null;
    },

    async onModal(customId, fields, ctx): Promise<Reply> {
      if (isAdminPanelId(customId)) return ctx.isAdmin ? panel.onModal(customId, fields, ctx) : ADMIN_ONLY;
      const m = /^ed:(\d+)$/.exec(customId);
      if (!m) return '알 수 없는 입력 창이에요.';
      if (!ctx.isAdmin) return ADMIN_ONLY;
      const parsed = parseEventEdit(fields);
      if ('error' in parsed) return `⚠️ ${parsed.error} (바뀐 것 없음)`;
      const r = await editEvent(db, Number(m[1]), parsed.fields, ctx.userId, now());
      if (!r) return '행사를 찾을 수 없어요.';
      if (r.changed.length === 0 && !r.statusChanged) return '바뀐 내용이 없어요.';
      const queued = await planForChange(db, r.event, { created: false, statusChanged: r.statusChanged, changes: r.notable });
      const refreshed = await refreshNoticeCard(noticeDeps(), r.event).catch(() => false);
      return [
        `✏️ #${r.event.id} **${r.event.title}** 수정: ${r.changed.length ? r.changed.join(', ') : '상태'}`,
        ...(queued ? [`${r.statusChanged ? '상태' : '일정·장소'}가 바뀌어 알림 ${queued}건을 보낼게요 (1분 안에).`] : []),
        ...(refreshed ? ['공지 카드도 고쳤어요.'] : []),
        '-# 서버 이벤트는 10분 안에 맞춰져요.',
      ].join('\n');
    },
  };
}
