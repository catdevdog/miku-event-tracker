import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { discordMembers, eventDiscord, eventSources, eventStateLog, events, keywords, misses, notifications, rawItems, reports, sources, subscribers } from '../src/db/schema.js';
import { findExistingEvent, mergeExtraction } from '../src/pipeline/merge.js';
import type { Extraction, Extractor } from '../src/pipeline/extract.js';
import { processPendingItems, reportPageUrl } from '../src/pipeline/index.js';
import { loadKeywordSet } from '../src/pipeline/keywordFilter.js';
import { isSchedulable } from '../src/scheduler/due.js';
import { ensureDefaultSubscriber, planForChange, planNotifications } from '../src/notify/planner.js';
import { sendQueued } from '../src/notify/sender.js';
import { withRoleMention, type InteractionCtx } from '../src/notify/discord.js';
import { deliverNotice, threadName, withoutImages } from '../src/notify/noticeThreads.js';
import { MemberListError, ensureSubscriptionSetup, panelMessage, parseSubId, syncDefaultMembers, toggleSubscription } from '../src/notify/subscriptions.js';
import { parseWatchId, toggleWatch } from '../src/notify/watchers.js';
import { createReport, firstUrl, resolveReports } from '../src/notify/reports.js';
import { statusBoardData, statusBoardMessage, syncStatusBoard } from '../src/notify/statusBoard.js';
import { createInteractionHandlers } from '../src/notify/interactions.js';
import { createDiscordJobs } from '../src/notify/discordJobs.js';
import { addKeyword, editEvent, eventChoices, mergeEvents, parseEventEdit, removeKeyword, sourceAction } from '../src/services/admin.js';
import { SETTING, getSetting, isNotifyPaused, setSetting } from '../src/services/settings.js';
import { getEventDetail } from '../src/services/events.js';
import type { Notifier } from '../src/notify/notifier.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
const NOTICE = '123456789012345680';
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
  await ensureDefaultSubscriber(t.db, { noticeChannelId: NOTICE, hasWebhook: false });
});
afterEach(() => t.cleanup());

const NOW = new Date('2026-11-23T00:00:00Z');
const base: Extraction = {
  is_relevant: true, title: '하츠네 미쿠 팝업 in 홍대', kind: 'popup', officiality: 'licensed', region: 'KR', city: '서울', venue: 'AK플라자 홍대',
  start_date: '2026-12-10', end_date: '2026-12-24', ticket_open_at: null, ticket_url: null, is_cancelled: false, sale_started: null,
  parent_event_hint: null, summary_ko: '홍대에서 미쿠 팝업이 열린다.', confidence: 0.9,
};
async function rawItem(name = '팝가 (팝업 모음)', url = 'https://popga.co.kr/popup/1') {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, name));
  const [r] = await t.db.insert(rawItems).values({ sourceId: s!.id, externalId: `x-${Math.random()}`, url, contentHash: 'h' }).returning();
  return r!;
}
const merge = async (over: Partial<Extraction> = {}) =>
  mergeExtraction(t.db, { ...base, ...over }, { rawItemId: (await rawItem()).id, model: 'claude-haiku-5-5', needsReview: false, fromKopis: false, now: NOW });
const admin: InteractionCtx = { userId: 'u-admin', isAdmin: true, memberRoleIds: [] };
const user = (roles: string[] = []): InteractionCtx => ({ userId: 'u-1', isAdmin: false, memberRoleIds: roles });
const notifier = (): Notifier & { sendNotice: ReturnType<typeof vi.fn> } => ({ sendNotice: vi.fn(async () => 'webhook' as const), alerter: { alert: vi.fn(async () => {}) } });

function fakeBot<O extends Record<string, unknown> = Record<never, never>>(over?: O) {
  let n = 0;
  const b = {
    isReady: () => true,
    post: vi.fn(async (_ch: string, _m: unknown, _o?: unknown) => `m-${++n}`),
    editMessage: vi.fn(async () => {}),
    startThread: vi.fn(async () => 'thread-1'),
    pinMessage: vi.fn(async () => {}),
    ensureRole: vi.fn(async (s: { id?: string; name: string }) => s.id ?? `role-${s.name}`),
    listMembers: vi.fn(async () => [] as { id: string; bot: boolean; roles: string[] }[]),
    addMemberRole: vi.fn(async () => {}),
    removeMemberRole: vi.fn(async () => {}),
    sendDm: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  return { ...b, ...(over ?? {}) } as typeof b & O;
}
const apiError = (code: number) => Object.assign(new Error(`code ${code}`), { code });

describe('알림 역할 구독 (국내 기본)', () => {
  it('역할 3개를 만들고 패널을 올려 고정한다. 두 번째는 패널을 고치기만 한다', async () => {
    const bot = fakeBot();
    const r1 = await ensureSubscriptionSetup(t.db, bot, NOTICE, NOW);
    expect(Object.keys(r1.roles)).toEqual(['KR', 'JP', 'OTHER']);
    expect(r1.panelPosted).toBe(true);
    expect(bot.pinMessage).toHaveBeenCalledWith(NOTICE, 'm-1');
    expect(await getSetting(t.db, SETTING.role('KR'))).toBe('role-국내 행사 알림');
    const r2 = await ensureSubscriptionSetup(t.db, bot, NOTICE, NOW);
    expect(r2.panelPosted).toBe(false);
    expect(bot.editMessage).toHaveBeenCalledTimes(1);
    // 패널이 지워졌으면 다시 올린다
    bot.editMessage.mockRejectedValueOnce(apiError(10008));
    expect((await ensureSubscriptionSetup(t.db, bot, NOTICE, NOW)).panelPosted).toBe(true);
  });

  it('패널 버튼은 국내·일본·해외', () => {
    const ids = JSON.stringify(panelMessage().card).match(/sub:[A-Z]+/g);
    expect(ids).toEqual(['sub:KR', 'sub:JP', 'sub:OTHER']);
    expect(parseSubId('sub:JP')).toBe('JP');
    expect(parseSubId('sub:XX')).toBeNull();
  });

  it('멤버 전원에게 국내 역할을 한 번 준다 (봇 제외, 이미 있으면 기록만, 직접 끈 사람은 다시 안 줌)', async () => {
    await setSetting(t.db, SETTING.role('KR'), 'kr');
    const bot = fakeBot({
      listMembers: vi.fn(async () => [
        { id: 'a', bot: false, roles: [] },
        { id: 'b', bot: false, roles: ['kr'] },
        { id: 'bot', bot: true, roles: [] },
      ]),
    });
    expect(await syncDefaultMembers(t.db, bot, NOW)).toEqual({ added: 1, initialized: 2, failed: 0 });
    expect(bot.addMemberRole).toHaveBeenCalledWith('a', 'kr');
    // 'a'가 국내를 껐어도 다시 주지 않는다
    expect(await syncDefaultMembers(t.db, bot, NOW)).toEqual({ added: 0, initialized: 0, failed: 0 });
    expect(await syncDefaultMembers(t.db, fakeBot({ listMembers: vi.fn(async () => [{ id: 'c', bot: false, roles: [] }, { id: 'd', bot: false, roles: [] }]) }), NOW, 1)).toEqual({ added: 1, initialized: 1, failed: 0 });
  });

  it('한 명이 실패해도 나머지는 계속하고, 실패한 사람은 다음에 다시 시도한다', async () => {
    await setSetting(t.db, SETTING.role('KR'), 'kr');
    const add = vi.fn(async (id: string) => (id === 'owner' ? Promise.reject(apiError(50013)) : undefined));
    const list = vi.fn(async () => [{ id: 'owner', bot: false, roles: [] }, { id: 'x', bot: false, roles: [] }]);
    const r = await syncDefaultMembers(t.db, fakeBot({ listMembers: list, addMemberRole: add }), NOW);
    expect(r).toMatchObject({ added: 1, initialized: 1, failed: 1 });
    expect(r.lastError).toContain('50013');
    await syncDefaultMembers(t.db, fakeBot({ listMembers: list, addMemberRole: add }), NOW);
    expect(add.mock.calls.filter((c) => c[0] === 'owner')).toHaveLength(2);
    // 처음 3명이 모두 실패하면 멈춘다
    const allFail = vi.fn(async () => Promise.reject(apiError(50013)));
    const many = vi.fn(async () => ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, bot: false, roles: [] })));
    expect((await syncDefaultMembers(t.db, fakeBot({ listMembers: many, addMemberRole: allFail }), NOW)).failed).toBe(3);
    // 멤버 목록을 못 읽으면 구분되는 오류
    await expect(syncDefaultMembers(t.db, fakeBot({ listMembers: vi.fn(async () => Promise.reject(apiError(50001))) }), NOW)).rejects.toBeInstanceOf(MemberListError);
  });

  it('버튼으로 켜고 끈다. 직접 바꾼 사람은 기본 구독 대상에서 빠진다', async () => {
    await setSetting(t.db, SETTING.role('JP'), 'jp');
    await setSetting(t.db, SETTING.role('KR'), 'kr');
    const bot = fakeBot();
    const on = await toggleSubscription(t.db, bot, user(['kr']), 'JP', NOW);
    expect(bot.addMemberRole).toHaveBeenCalledWith('u-1', 'jp');
    expect(on).toContain('🇯🇵 일본 행사 알림을 켰어요');
    expect(on).toContain('🇰🇷 국내 ✅ · 🇯🇵 일본 ✅ · 🌏 해외 ⬜');
    const off = await toggleSubscription(t.db, bot, user(['kr']), 'KR', NOW);
    expect(bot.removeMemberRole).toHaveBeenCalledWith('u-1', 'kr');
    expect(off).toContain('껐어요');
    expect((await t.db.select().from(discordMembers)).map((m) => m.userId)).toEqual(['u-1']);
    const denied = await toggleSubscription(t.db, fakeBot({ addMemberRole: vi.fn(async () => Promise.reject(apiError(50013))) }), user(), 'JP', NOW);
    expect(denied).toContain('봇 역할을 알림 역할들보다 위로');
  });

  it('공지 카드 맨 위에 역할 멘션 한 줄', () => {
    const m = withRoleMention({ card: [{ type: 17, components: [] }] as never, content: '본문' }, 'kr');
    expect(m.card![0]).toEqual({ type: 10, content: '<@&kr>' });
    expect(m.content).toBe('<@&kr>\n본문');
    expect(withRoleMention({ content: 'x' }, undefined)).toEqual({ content: 'x' });
  });
});

describe('설정 점검 (/관리 설정)', () => {
  const jobsWith = (over: Record<string, unknown>) => {
    const alerts: string[] = [];
    const bot = fakeBot({ missingPermissions: vi.fn(async () => []), rolesNotBelowBot: vi.fn(async () => []), ...over });
    const jobs = createDiscordJobs({
      db: t.db, bot: () => bot as never, notifier: notifier(), alerter: { alert: async (m: string) => void alerts.push(m) },
      noticeChannelId: NOTICE, adminChannelId: 'admin', now: () => NOW, log: { log() {}, warn() {}, error() {} },
    });
    return { jobs, bot, alerts };
  };

  it('멤버 목록을 못 읽으면 Server Members Intent 안내를 돌려준다', async () => {
    const { jobs, alerts } = jobsWith({ listMembers: vi.fn(async () => Promise.reject(Object.assign(new Error('Missing Access'), { code: 50001 }))) });
    const r = await jobs.setup();
    expect(r!.memberError).toContain('Server Members Intent');
    expect(r!.memberError).toContain('Missing Access (50001)');
    expect(alerts.some((a) => a.includes('Server Members Intent'))).toBe(true);
  });

  it('봇 역할이 알림 역할보다 아래면 부여를 시도하지 않고 순서를 바꾸라고 알린다', async () => {
    const { jobs, bot } = jobsWith({ rolesNotBelowBot: vi.fn(async () => ['국내 행사 알림']) });
    const r = await jobs.setup();
    expect(r!.errors.join('\n')).toContain('봇 역할을 끌어서 알림 역할들 위로');
    expect(bot.listMembers).not.toHaveBeenCalled();
  });

  it('공지 채널에 패널을 못 올려도(50013) 멈추지 않고 멤버에게 역할을 준다', async () => {
    const { jobs, bot } = jobsWith({
      post: vi.fn(async () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }))),
      listMembers: vi.fn(async () => [{ id: 'a', bot: false, roles: [] }]),
    });
    const r = await jobs.setup();
    expect(r!.errors.join('\n')).toContain('구독 패널을 공지 채널에 올리지 못했습니다: Missing Permissions (50013)');
    expect(r!.errors.join('\n')).toContain('메시지 보내기');
    expect(bot.addMemberRole).toHaveBeenCalledWith('a', expect.any(String));
  });

  it('정상이면 멤버에게 국내 역할을 준다 (동시에 불러도 한 번만 실행)', async () => {
    const { jobs, bot } = jobsWith({ listMembers: vi.fn(async () => [{ id: 'a', bot: false, roles: [] }]) });
    const [r1, r2] = await Promise.all([jobs.setup(), jobs.setup()]);
    expect(r1).toBe(r2);
    expect(r1!.members).toMatchObject({ added: 1 });
    expect(bot.addMemberRole).toHaveBeenCalledTimes(1);
  });
});

describe('공지 스레드', () => {
  const deps = (bot: ReturnType<typeof fakeBot> | undefined, n = notifier()) => ({ db: t.db, notifier: n, noticeChannelId: NOTICE, bot });
  const job = (eventId: number, reason: 'new' | 'status_change' | 'reminder', slot = '') => ({ eventId, reason, slot, message: { card: [{ type: 17, components: [{ type: 12, items: [] }, { type: 10, content: 'x' }] }] as never } });

  it('새 행사: 국내 역할 멘션 + 스레드 → 상태 변경: 카드 고치고 스레드에 → 리마인더: 멘션 답장', async () => {
    await setSetting(t.db, SETTING.role('KR'), 'kr');
    const { event } = await merge();
    const bot = fakeBot();
    expect(await deliverNotice(deps(bot), job(event.id, 'new'))).toBe('new');
    expect(bot.post).toHaveBeenLastCalledWith(NOTICE, expect.anything(), { mentionRoleId: 'kr' });
    expect(bot.startThread).toHaveBeenCalledWith(NOTICE, 'm-1', '12.10 하츠네 미쿠 팝업 in 홍대');
    const [ed] = await t.db.select().from(eventDiscord).where(eq(eventDiscord.eventId, event.id));
    expect([ed!.noticeMessageId, ed!.noticeThreadId]).toEqual(['m-1', 'thread-1']);

    expect(await deliverNotice(deps(bot), job(event.id, 'status_change'))).toBe('thread');
    expect(bot.editMessage).toHaveBeenCalledWith(NOTICE, 'm-1', expect.objectContaining({ card: expect.any(Array) }));
    const threadMsg = bot.post.mock.calls.at(-1)!;
    expect(threadMsg[0]).toBe('thread-1');
    expect(JSON.stringify(threadMsg[1])).not.toContain('"type":12'); // 스레드에는 지역 이미지 없이

    expect(await deliverNotice(deps(bot), job(event.id, 'reminder', 'T-1h'))).toBe('reminder');
    expect(bot.post).toHaveBeenLastCalledWith(NOTICE, expect.anything(), { mentionRoleId: 'kr', replyTo: 'm-1' });
  });

  it('원래 카드가 지워졌으면 새로 올리고, 봇이 없으면 웹후크', async () => {
    const { event } = await merge();
    const bot = fakeBot();
    await deliverNotice(deps(bot), job(event.id, 'new'));
    bot.editMessage.mockRejectedValueOnce(apiError(10008));
    expect(await deliverNotice(deps(bot), job(event.id, 'status_change'))).toBe('new');
    const n = notifier();
    expect(await deliverNotice(deps(undefined, n), job(event.id, 'new'))).toBe('webhook');
    expect(n.sendNotice).toHaveBeenCalledTimes(1);
  });

  it('스레드를 못 열어도 공지는 나간다 (권한 부족)', async () => {
    const { event } = await merge();
    const bot = fakeBot({ startThread: vi.fn(async () => Promise.reject(new Error('Missing Permissions'))) });
    expect(await deliverNotice({ ...deps(bot), log: { warn: () => {} } }, job(event.id, 'new'))).toBe('new');
    expect(await deliverNotice(deps(bot), job(event.id, 'status_change'))).toBe('channel');
    expect(bot.post).toHaveBeenLastCalledWith(NOTICE, expect.anything(), { replyTo: 'm-1' });
  });

  it('보조 함수', () => {
    expect(threadName({ title: 'x'.repeat(200), startDate: null })).toHaveLength(100);
    expect(withoutImages({ content: 'a' })).toEqual({ content: 'a' });
  });
});

describe('개인 리마인더 (🔔)', () => {
  it('켜면 DM 구독자가 생기고, 지켜보는 행사의 상태 변경·리마인더만 받는다', async () => {
    const { event } = await merge();
    const { event: other } = await merge({ title: '미쿠 콜라보 카페 강남', venue: '강남', start_date: '2027-01-10' });
    expect(parseWatchId(`wt:${event.id}`)).toBe(event.id);
    expect(await toggleWatch(t.db, event.id, 'u-1', NOW)).toContain('알림을 켰어요');
    const [dm] = await t.db.select().from(subscribers).where(eq(subscribers.channel, 'discord_dm'));
    expect(dm!.target).toBe('u-1');

    expect(await planNotifications(t.db, event, 'new')).toBe(1); // 공지 채널만
    expect(await planNotifications(t.db, { ...event, status: 'on_sale' }, 'status_change')).toBe(2); // 공지 채널 + DM
    expect(await planNotifications(t.db, { ...other, status: 'on_sale' }, 'status_change')).toBe(1); // 안 지켜보는 행사
    expect(await toggleWatch(t.db, event.id, 'u-1', NOW)).toContain('껐어요');
    expect(await planNotifications(t.db, { ...event, status: 'cancelled' }, 'status_change')).toBe(1);
  });

  it('DM이 막힌 사람은 다시 시도하지 않고 DM 구독을 멈춘다. 다시 누르면 재개', async () => {
    const { event } = await merge();
    await toggleWatch(t.db, event.id, 'u-1', NOW);
    await planNotifications(t.db, { ...event, status: 'on_sale' }, 'status_change');
    const bot = fakeBot({ sendDm: vi.fn(async () => Promise.reject(apiError(50007))) });
    await sendQueued({ db: t.db, notifier: notifier(), noticeChannelId: NOTICE, bot: bot as never, deliverNotice: async () => {} });
    const [dm] = await t.db.select().from(subscribers).where(eq(subscribers.channel, 'discord_dm'));
    expect(dm!.active).toBe(0);
    const [failed] = await t.db.select().from(notifications).where(eq(notifications.subscriberId, dm!.id));
    expect([failed!.status, failed!.attempts]).toEqual(['failed', 3]);
    await toggleWatch(t.db, event.id, 'u-1', NOW); // 끄기
    await toggleWatch(t.db, event.id, 'u-1', NOW); // 다시 켜기
    expect((await t.db.select().from(subscribers).where(eq(subscribers.id, dm!.id)))[0]!.active).toBe(1);
  });

  it('끝난 행사는 켤 수 없다', async () => {
    const { event } = await merge({ start_date: '2026-10-01', end_date: '2026-10-02' });
    expect(await toggleWatch(t.db, event.id, 'u-1', NOW)).toContain('끝난 행사');
  });
});

describe('/관리', () => {
  it('수집처 멈춤은 재배포(시드)해도 유지되고, 지금 수집은 다음 틱에 돈다', async () => {
    const name = '팝가 (팝업 모음)';
    expect(await sourceAction(t.db, name, 'pause')).toContain('멈췄어요');
    await seedDatabase(t.db);
    const [s] = await t.db.select().from(sources).where(eq(sources.name, name));
    expect(s!.paused).toBe(1);
    expect(isSchedulable(s!)).toBe(false);
    expect(await sourceAction(t.db, name, 'run')).toContain('먼저 재개');
    expect(await sourceAction(t.db, name, 'resume')).toContain('다시 시작');
    await t.db.update(sources).set({ lastRunAt: NOW.toISOString() }).where(eq(sources.name, name));
    await sourceAction(t.db, name, 'run');
    expect((await t.db.select().from(sources).where(eq(sources.name, name)))[0]!.lastRunAt).toBeNull();
    const [off] = await t.db.select().from(sources).where(eq(sources.enabled, 0)).limit(1);
    expect(await sourceAction(t.db, off!.name, 'resume')).toContain('켤 수 없어요');
  });

  it('키워드 삭제는 시드가 다시 켜지 않는다', async () => {
    expect(await removeKeyword(t.db, '하츠네 미쿠')).toContain('뺐어요');
    await seedDatabase(t.db);
    expect((await loadKeywordSet(t.db)).strong).not.toContain('하츠네 미쿠');
    expect(await addKeyword(t.db, '하츠네 미쿠', 'strong')).toContain('강(단독 통과)');
    expect((await loadKeywordSet(t.db)).strong).toContain('하츠네 미쿠');
    await addKeyword(t.db, '원더리벳', 'weak');
    expect((await t.db.select().from(keywords).where(eq(keywords.term, '원더리벳')))[0]!.tier).toBe('weak');
  });

  it('행사 수정: 입력 검사, 바뀐 항목 기록, 상태 다시 계산', async () => {
    expect(parseEventEdit({ dates: '12월 4일' })).toEqual({ error: expect.stringContaining('형식') });
    expect(parseEventEdit({ ticket_open: '2026-12-01 20:00' })).toEqual({ fields: { ticketOpenAt: '2026-12-01T11:00:00.000Z' } });
    expect(parseEventEdit({ venue: '고양 / 킨텍스 제2전시장', dates: '2026-12-04 ~ 2026-12-06' })).toEqual({
      fields: { city: '고양', venue: '킨텍스 제2전시장', startDate: '2026-12-04', endDate: '2026-12-06' },
    });
    const { event } = await merge();
    const parsed = parseEventEdit({ ticket_open: '2026-12-01 20:00', ticket_url: 'https://ticket.melon.com/x' });
    if ('error' in parsed) throw new Error(parsed.error);
    const r = await editEvent(t.db, event.id, parsed.fields, 'u-admin', NOW);
    expect(r!.changed).toEqual(['ticketOpenAt', 'ticketUrl']);
    expect(r!.event.status).toBe('ticket_scheduled');
    expect(r!.statusChanged).toBe(true);
    const [log] = await t.db.select().from(eventStateLog).where(eq(eventStateLog.eventId, event.id)).orderBy(eventStateLog.id);
    expect(JSON.parse((await t.db.select().from(eventStateLog).where(eq(eventStateLog.eventId, event.id))).at(-1)!.changedFields!).by).toBe('admin:u-admin');
    expect(log).toBeDefined();
    expect((await editEvent(t.db, event.id, parsed.fields, 'u-admin', NOW))!.changed).toEqual([]);
  });

  it('합치기: 출처·리마인더를 옮기고, 이후 같은 제목의 새 출처도 남긴 행사로 간다', async () => {
    const { event: keep } = await merge({ venue: null, start_date: '2026-12-10' });
    const { event: absorb } = await merge({ title: 'MIKU POP-UP STORE HONGDAE', venue: '홍대 AK', start_date: '2026-12-11', ticket_url: 'https://x.com/t' });
    await toggleWatch(t.db, absorb.id, 'u-1', NOW);
    expect(await mergeEvents(t.db, keep.id, absorb.id, 'u-admin', NOW)).toContain('합쳤어요');
    const srcs = await t.db.select().from(eventSources).where(eq(eventSources.eventId, keep.id));
    expect(srcs).toHaveLength(2);
    const [k] = await t.db.select().from(events).where(eq(events.id, keep.id));
    expect(k!.ticketUrl).toBe('https://x.com/t'); // 빈 항목 채움
    const [a] = await t.db.select().from(events).where(eq(events.id, absorb.id));
    expect([a!.needsReview, a!.mergedInto]).toEqual([2, keep.id]);
    expect((await findExistingEvent(t.db, { ...base, title: 'MIKU POP-UP STORE HONGDAE', venue: '홍대 AK', start_date: '2026-12-11' }))!.id).toBe(keep.id);
    expect(await mergeEvents(t.db, keep.id, absorb.id, 'u-admin', NOW)).toContain('이미');
    expect((await eventChoices(t.db, 'POP-UP')).length).toBe(0); // 합쳐진 행사는 후보에서 빠짐
  });

  it('관리자가 아니면 막고, 알림 일시정지는 설정값으로', async () => {
    const h = createInteractionHandlers({ db: t.db, bot: () => undefined, notifier: notifier(), uptimeSec: () => 0, now: () => NOW });
    const ctx = (isAdmin: boolean, sub: string, opts: Record<string, string> = {}) => ({
      ...(isAdmin ? admin : user()), wsPingMs: 0, subcommand: sub, getString: (o: string) => opts[o] ?? null,
    });
    expect(await h.onCommand('관리', ctx(false, '알림', { 동작: 'pause' }))).toContain('관리자');
    expect(await h.onCommand('관리', ctx(true, '알림', { 동작: 'pause' }))).toContain('일시정지 중');
    expect(await isNotifyPaused(t.db)).toBe(true);
    expect(await h.onCommand('관리', ctx(true, '알림', { 동작: 'resume' }))).toContain('보내고 있어요');
    expect(await h.onAutocomplete!('관리', { name: '이름', value: '팝가' }, user())).toEqual([]);
    expect((await h.onAutocomplete!('관리', { name: '이름', value: '팝가' }, admin))[0]!.value).toBe('팝가 (팝업 모음)');
    const { event } = await merge();
    const modal = await h.onCommand('관리', ctx(true, '행사', { 행사: String(event.id), 동작: 'edit' }));
    expect(modal).toMatchObject({ modal: { customId: `ed:${event.id}` } });
    expect(await h.onModal!(`ed:${event.id}`, { title: base.title, dates: '2026-12-10 ~ 2026-12-25', venue: '', ticket_open: '', ticket_url: '' }, user())).toContain('관리자');
    expect(await h.onModal!(`ed:${event.id}`, { title: base.title, dates: '2026-12-10 ~ 2026-12-25' }, admin)).toContain('수정: endDate');
    expect(await h.onButton!(`rv:ok:${event.id}`, user())).toEqual({ reply: expect.stringContaining('관리자') });
  });
});

describe('/행사 검색', () => {
  it('자동완성 → 상세 카드(출처·이력·알림 받기 버튼), 숨긴 행사는 안 보임', async () => {
    const { event } = await merge();
    const h = createInteractionHandlers({ db: t.db, bot: () => undefined, notifier: notifier(), uptimeSec: () => 0, guildId: 'g', now: () => NOW });
    const choices = await h.onAutocomplete!('행사', { name: '검색', value: '홍대' }, user());
    expect(choices[0]).toEqual({ name: '#1 · 12.10 · 하츠네 미쿠 팝업 in 홍대 (국내)', value: String(event.id) });
    const reply = (await h.onCommand('행사', { ...user(), wsPingMs: 0, subcommand: null, getString: (o) => (o === '검색' ? String(event.id) : null) })) as { card: unknown[] };
    const json = JSON.stringify(reply.card);
    expect(json).toContain(`wt:${event.id}`);
    expect(json).toContain('출처 1건');
    expect((await getEventDetail(t.db, event.id))!.sources[0]!.url).toBe('https://popga.co.kr/popup/1');
    await t.db.update(events).set({ needsReview: 2 }).where(eq(events.id, event.id));
    expect(await h.onAutocomplete!('행사', { name: '검색', value: '홍대' }, user())).toEqual([]);
    expect(await h.onCommand('행사', { ...user(), wsPingMs: 0, subcommand: null, getString: (o) => (o === '검색' ? String(event.id) : null) })).toBe('행사를 찾을 수 없어요.');
  });
});

describe('제보', () => {
  const ex = (result: Extraction): Extractor & { inputs: string[] } => {
    const inputs: string[] = [];
    return { inputs, async extract(input, model) { inputs.push(input.body); return { model, result, inputTokens: 100, outputTokens: 50 }; } };
  };

  it('키워드 없이도 Claude 판정으로 가고, 결과를 카드와 misses에 남긴다', async () => {
    expect(firstUrl('여기 https://wonderlivet.jp/2026/lineup). 봐')).toBe('https://wonderlivet.jp/2026/lineup');
    expect(reportPageUrl('https://discord.com/channels/1/2/3')).toBe(false);
    const r = await createReport(t.db, { reporterId: 'u-1', url: 'https://wonderlivet.jp/2026/lineup', note: '킨텍스 행사에 출연' }, NOW);
    expect(r.ok).toBe(true);
    // 같은 사람 1분 제한, 같은 링크 중복
    expect(await createReport(t.db, { reporterId: 'u-1', url: 'https://a.com/x' }, NOW)).toEqual({ ok: false, reason: expect.stringContaining('1분') });
    expect(await createReport(t.db, { reporterId: 'u-2', url: 'https://wonderlivet.jp/2026/lineup' }, NOW)).toEqual({ ok: false, reason: expect.stringContaining('이미 제보') });
    expect(await createReport(t.db, { reporterId: 'u-3', note: '짧음' }, NOW)).toMatchObject({ ok: false });

    const extractor = ex({ ...base, title: 'WONDERLIVET 2026', kind: 'stage', venue: '킨텍스', start_date: '2026-12-20', end_date: '2026-12-20' });
    const res = await processPendingItems({ db: t.db, extractor, alerter: { alert: async () => {} }, now: () => NOW, fetchPage: async () => '출연진: 하츠네 미쿠 외' });
    expect(res.merged).toBe(1);
    expect(extractor.inputs[0]).toContain('킨텍스 행사에 출연');
    expect(extractor.inputs[0]).toContain('출연진: 하츠네 미쿠');

    const bot = fakeBot();
    expect(await resolveReports(t.db, bot, 'admin', NOW)).toBe(1);
    const [rep] = await t.db.select().from(reports);
    expect(rep!.result).toContain('🆕 새 행사로 등록');
    expect(bot.post).toHaveBeenCalledTimes(1); // 카드가 없었으면 새로 올린다
    const [miss] = await t.db.select().from(misses);
    expect([miss!.caughtBySystem, miss!.note]).toEqual([0, `디스코드 제보 #${rep!.id}`]);
    expect(await resolveReports(t.db, bot, 'admin', NOW)).toBe(0);
  });

  it('관련 없다고 판정되면 그렇게 적는다', async () => {
    await createReport(t.db, { reporterId: 'u-1', note: '나카노 미쿠 팝업이 열려요 (오등분의 신부)' }, NOW);
    await processPendingItems({ db: t.db, extractor: ex({ ...base, is_relevant: false }), alerter: { alert: async () => {} }, now: () => NOW });
    await resolveReports(t.db, undefined, undefined, NOW);
    expect((await t.db.select().from(reports))[0]!.result).toContain('관련 없다');
  });
});

describe('관리자 상태판', () => {
  it('수치를 모아 카드로 만들고, 메시지가 지워졌으면 다시 올린다', async () => {
    await t.db.update(sources).set({ consecutiveFailures: 3 }).where(eq(sources.name, '팝가 (팝업 모음)'));
    await merge();
    await setSetting(t.db, SETTING.notifyPaused, '1');
    const d = await statusBoardData(t.db, NOW);
    expect(d.sources.alert).toBe(1);
    expect(d.sources.alertNames).toEqual(['팝가 (팝업 모음)']);
    expect(d.events.kr).toBe(1);
    expect(d.notifyPaused).toBe(true);
    const text = statusBoardMessage(d).content!;
    expect(text).toContain('일시정지 중');
    expect(text).toContain('🇰🇷 1');
    const bot = fakeBot();
    expect(await syncStatusBoard(t.db, bot, 'admin', NOW)).toBe('posted');
    expect(await syncStatusBoard(t.db, bot, 'admin', NOW)).toBe('edited');
    bot.editMessage.mockRejectedValueOnce(apiError(10008));
    expect(await syncStatusBoard(t.db, bot, 'admin', NOW)).toBe('posted');
  });
});

describe('planForChange는 그대로', () => {
  it('검수 해제·새 행사 알림', async () => {
    const m = await merge();
    expect(await planForChange(t.db, m.event, { created: true, statusChanged: false })).toBe(1);
  });
});
