import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { eventAttendees, eventDiscord, eventDistinct, events, llmCalls, misses, notifications, rawItems, reports, sources, subscribers } from '../src/db/schema.js';
import { extractionSchema, type Extraction, type Extractor, type MatchResult } from '../src/pipeline/extract.js';
import { mergeExtraction, mergePresales, notableChanges, parsePresales, sameVenueName } from '../src/pipeline/merge.js';
import { sweepDuplicates } from '../src/pipeline/dedupSweep.js';
import { changeHead, changeNote, changeSlot, ensureDefaultSubscriber, planForChange } from '../src/notify/planner.js';
import { planReminders, presaleSlot } from '../src/notify/reminders.js';
import { detailLines, myAlertsCard } from '../src/notify/cards.js';
import { deliverNotice } from '../src/notify/noticeThreads.js';
import { decideDupPair, parseDupId, postPendingDupCards } from '../src/notify/review.js';
import { myEvents, parseGoId, toggleGoing, toggleWatch } from '../src/notify/watchers.js';
import { calendarData, calendarSvg, fitText, monthlyCalendar } from '../src/notify/calendarImage.js';
import { missReport, missReportMessage } from '../src/notify/weekly.js';
import { createInteractionHandlers } from '../src/notify/interactions.js';
import { createDiscordJobs } from '../src/notify/discordJobs.js';
import { SETTING, SETTING_DUP_SWEEP, getSetting, setSetting } from '../src/services/settings.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
const NOTICE = '123456789012345680';
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
  await ensureDefaultSubscriber(t.db, { noticeChannelId: NOTICE, hasWebhook: false });
});
afterEach(() => t.cleanup());

const NOW = new Date('2026-11-23T03:00:00Z'); // 한국 시간 11-23(월) 12:00
const base: Extraction = {
  is_relevant: true, title: '하츠네 미쿠 심포니 2027 in 서울', kind: 'concert', officiality: 'crypton', region: 'KR', city: '서울', venue: '롯데콘서트홀',
  start_date: '2027-02-06', end_date: '2027-02-07', ticket_open_at: null, ticket_url: null, is_cancelled: false, sale_started: null,
  parent_event_hint: null, summary_ko: '서울에서 미쿠 심포니가 열린다.', confidence: 0.9,
};
type Matcher = (ext: Extraction, c: { id: number }[]) => Promise<MatchResult>;
async function merge(over: Partial<Extraction> = {}, now = NOW, matcher?: Matcher) {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, '팝가 (팝업 모음)'));
  const [item] = await t.db.insert(rawItems).values({ sourceId: s!.id, externalId: `x-${Math.random()}`, url: 'https://piapro.net/n', contentHash: 'h' }).returning();
  return mergeExtraction(t.db, { ...base, ...over }, { rawItemId: item!.id, model: 'claude-haiku-5-5', needsReview: false, fromKopis: false, now, matcher });
}
const queued = async (eventId: number) => (await t.db.select().from(notifications).where(eq(notifications.eventId, eventId))).map((n) => ({ ...n, text: JSON.stringify(JSON.parse(n.message).card) }));
const fakeBot = () => {
  let n = 0;
  return {
    isReady: () => true, post: vi.fn(async (_c: string, _m: unknown, _o?: unknown) => `m-${++n}`), editMessage: vi.fn(async () => {}), startThread: vi.fn(async () => 'th'),
    deleteMessage: vi.fn(async () => {}), postFile: vi.fn(async (_c: string, _t: string, _f: { name: string; data: Buffer }) => 'f-1'),
  };
};
const notifier = () => ({ sendNotice: vi.fn(async () => 'webhook' as const), alerter: { alert: vi.fn(async () => {}) } });
const admin = { userId: 'u-admin', isAdmin: true, memberRoleIds: [] as string[] };

describe('일정·장소 변경 알림', () => {
  it('일정이 바뀌면 한 번 알리고(스레드·DM), 같은 값으로는 다시 알리지 않는다', async () => {
    const a = await merge();
    await planForChange(t.db, a.event, a);
    await toggleWatch(t.db, a.event.id, 'u-1', NOW);
    // 날짜가 달라 제목만으로는 같은 행사인지 알 수 없다 → Claude가 같은 회차의 일정 변경이라고 확인
    const b = await merge({ start_date: '2027-02-13', end_date: '2027-02-14', summary_ko: '공연이 일주일 연기됐다.' }, NOW, async (_e, c) => ({ matchId: c[0]!.id, relation: 'same', confidence: 0.9 }));
    expect(b.created).toBe(false);
    expect(b.changes).toEqual([{ field: 'dates', from: '2027-02-06~2027-02-07', to: '2027-02-13~2027-02-14' }]);
    expect(await planForChange(t.db, b.event, b)).toBe(2); // 공지 채널 + 🔔 DM
    const n = (await queued(a.event.id)).find((x) => x.slot.startsWith('chg:'))!;
    expect(n.reason).toBe('status_change');
    expect(n.text).toContain('✏️ 일정 변경');
    expect(n.text).toContain('~~2027.02.06(토) ~ 02.07(일)~~ → **2027.02.13(토) ~ 02.14(일)**');
    expect(await planForChange(t.db, b.event, b)).toBe(0);
    // 공지 채널에서는 원래 카드를 고치고 스레드에 쓴다 (멘션 없음)
    const bot = fakeBot();
    await t.db.insert(eventDiscord).values({ eventId: a.event.id, noticeMessageId: 'orig', noticeThreadId: 'thread' });
    expect(await deliverNotice({ db: t.db, notifier: notifier(), noticeChannelId: NOTICE, bot }, { eventId: a.event.id, reason: 'status_change', slot: n.slot, message: JSON.parse(n.message) })).toBe('thread');
    expect(bot.editMessage).toHaveBeenCalledWith(NOTICE, 'orig', expect.anything());
  });

  it('하루만 적은 출처·다른 언어 장소 표기는 변경이 아니다. 미정 → 확정은 알린다', async () => {
    const a = await merge({ venue: null });
    const b = await merge({ start_date: '2027-02-07', end_date: '2027-02-07', venue: '롯데콘서트홀' });
    expect([b.event.startDate, b.event.endDate]).toEqual(['2027-02-06', '2027-02-07']); // 기간을 줄이지 않는다
    expect(b.changes).toEqual([{ field: 'venue', from: null, to: '롯데콘서트홀' }]);
    expect(changeHead(b.changes!).label).toBe('장소 확정');
    expect(changeNote(b.changes!)).toBe('✏️ **장소 확정**　**롯데콘서트홀**');
    const c = await merge({ venue: 'LOTTE Concert Hall' });
    expect(c.event.venue).toBe('롯데콘서트홀');
    expect(c.changes).toEqual([]);
    expect(a.event.id).toBe(c.event.id);
    expect(sameVenueName('킨텍스', '일산 킨텍스 제2전시장 7홀')).toBe(true);
    expect(sameVenueName('킨텍스', '코엑스 C홀')).toBe(false);
    expect(notableChanges({ startDate: '2026-12-04', endDate: '2026-12-06', venue: '킨텍스' }, { startDate: '2026-12-04', endDate: '2026-12-06', venue: '코엑스 C홀' })).toHaveLength(1);
    expect(changeSlot([{ field: 'dates', from: null, to: 'x' }])).toBe('chg:dates=x');
  });
});

describe('유형별 멘션', () => {
  it('굿즈·콜라보는 멘션 없이, 공연은 지역 역할 멘션', async () => {
    await setSetting(t.db, SETTING.role('KR'), 'kr');
    const goods = await merge({ title: '이치방쿠지 하츠네 미쿠', kind: 'goods', venue: null, start_date: '2026-11-28', end_date: '2026-11-28' });
    const concert = await merge();
    const bot = fakeBot();
    const deps = { db: t.db, notifier: notifier(), noticeChannelId: NOTICE, bot };
    await deliverNotice(deps, { eventId: goods.event.id, reason: 'new', slot: '', message: { content: 'x' } });
    expect(bot.post).toHaveBeenLastCalledWith(NOTICE, expect.anything(), { mentionRoleId: undefined });
    await deliverNotice(deps, { eventId: concert.event.id, reason: 'new', slot: '', message: { content: 'x' } });
    expect(bot.post).toHaveBeenLastCalledWith(NOTICE, expect.anything(), { mentionRoleId: 'kr' });
  });
});

describe('선예매·추첨 일정', () => {
  const PRE = [{ label: '팬클럽 선예매', open_at: '2026-11-24T02:00:00.000Z', close_at: '2026-11-25T14:59:00.000Z' }];

  it('추출 형식: 일정 없는 항목은 버리고, 없으면 빈 배열', () => {
    const raw = { ...base, presales: [{ label: '추첨 접수', open_at: '2026-12-01T12:00:00+09:00', close_at: null }, { label: '일정 미정', open_at: null, close_at: null }] };
    expect(extractionSchema.parse(raw).presales).toEqual([{ label: '추첨 접수', open_at: '2026-12-01T03:00:00.000Z', close_at: null }]);
    expect(extractionSchema.parse({ ...base, presales: 'x' }).presales).toEqual([]);
    expect(mergePresales(PRE, [{ label: '팬클럽 선예매', open_at: '2026-11-24T03:00:00.000Z', close_at: null }, { label: '2차 선예매', open_at: '2026-11-20T03:00:00.000Z', close_at: null }]).map((p) => [p.label, p.open_at])).toEqual([
      ['2차 선예매', '2026-11-20T03:00:00.000Z'],
      ['팬클럽 선예매', '2026-11-24T03:00:00.000Z'],
    ]);
  });

  it('카드에 선예매 줄이 나오고, 시작 24시간·1시간 전에 리마인더를 보낸다', async () => {
    const a = await merge({ presales: PRE });
    expect(parsePresales(a.event.presales)).toEqual(PRE);
    expect(detailLines(a.event).join('\n')).toContain('🎟️ **팬클럽 선예매**　2026.11.24(화) 11:00 KST');
    expect(detailLines(a.event).join('\n')).toContain('~ 2026.11.25(수) 23:59 마감');
    expect(await planReminders(t.db, NOW)).toBe(1); // 23시간 전
    const [n] = (await queued(a.event.id)).filter((x) => x.reason === 'reminder');
    expect(n!.slot).toBe(presaleSlot('팬클럽 선예매', PRE[0]!.open_at, 'T-24h'));
    expect(n!.text).toContain('팬클럽 선예매 24시간 전');
    expect(await planReminders(t.db, NOW)).toBe(0);
    expect(await planReminders(t.db, new Date('2026-11-24T01:30:00Z'))).toBe(1); // 30분 전
    // 다른 출처가 나중에 선예매 일정을 알려 주면 합친다
    const b = await merge({ presales: [{ label: '일반 추첨', open_at: '2026-12-01T03:00:00.000Z', close_at: null }] });
    expect(parsePresales(b.event.presales)).toHaveLength(2);
  });
});

describe('전날·종료 임박 DM', () => {
  it('🔔를 켠 사람에게만: 시작 전날 한 번, 팝업은 끝나기 3일 전', async () => {
    const concert = await merge({ start_date: '2026-11-24', end_date: '2026-11-24' });
    const popup = await merge({ title: '미쿠 팝업 스토어', kind: 'popup', venue: '홍대', start_date: '2026-11-10', end_date: '2026-11-26' });
    const other = await merge({ title: '다른 공연', venue: '부산', start_date: '2026-11-24', end_date: '2026-11-24' });
    await toggleWatch(t.db, concert.event.id, 'u-1', NOW);
    await toggleWatch(t.db, popup.event.id, 'u-1', NOW);
    expect(await planReminders(t.db, new Date('2026-11-22T23:00:00Z'))).toBe(0); // 한국 시간 08시: 아직
    expect(await planReminders(t.db, NOW)).toBe(2);
    const [dm] = await t.db.select().from(subscribers).where(eq(subscribers.channel, 'discord_dm'));
    const mine = await t.db.select().from(notifications).where(eq(notifications.subscriberId, dm!.id));
    expect(mine.map((n) => n.slot).sort()).toEqual(['D-1', 'END-3']);
    expect(mine.find((n) => n.slot === 'D-1')!.message).toContain('내일 시작해요');
    expect(mine.find((n) => n.slot === 'END-3')!.message).toContain('3일 뒤에 끝나요');
    expect(await queued(other.event.id)).toHaveLength(0); // 공지 채널에는 보내지 않는다
    expect(await planReminders(t.db, new Date('2026-11-23T05:00:00Z'))).toBe(0);
  });
});

describe('참석 표시·내 알림', () => {
  it('🙋 버튼으로 켜고 끄고, 공지 카드 숫자를 맞춘다', async () => {
    const a = await merge();
    await t.db.insert(eventDiscord).values({ eventId: a.event.id, noticeMessageId: 'orig' });
    const bot = fakeBot();
    const h = createInteractionHandlers({ db: t.db, bot: () => bot as never, notifier: notifier(), noticeChannelId: NOTICE, uptimeSec: () => 0, now: () => NOW });
    expect(parseGoId(`go:${a.event.id}`)).toBe(a.event.id);
    const r = await h.onButton!(`go:${a.event.id}`, { userId: 'u-1', isAdmin: false, memberRoleIds: [] });
    expect(r).toEqual({ reply: expect.stringContaining('간다고 표시했어요. (지금 1명)') });
    expect(JSON.stringify(bot.editMessage.mock.calls[0])).toContain('🙋 갈 거예요 1');
    expect((await toggleGoing(t.db, a.event.id, 'u-1', NOW)).reply).toContain('지웠어요. (지금 0명)');
    expect(await t.db.select().from(eventAttendees)).toHaveLength(0);
  });

  it('/내알림: 지역 구독, 🔔 켠 행사(끄기 버튼), 🙋 표시한 행사', async () => {
    const a = await merge();
    await toggleWatch(t.db, a.event.id, 'u-1', NOW);
    await toggleGoing(t.db, a.event.id, 'u-1', NOW);
    const mine = await myEvents(t.db, 'u-1');
    expect([mine.watching.length, mine.going.length]).toEqual([1, 1]);
    const json = JSON.stringify(myAlertsCard('🇰🇷 국내 ✅', mine.watching, mine.going));
    expect(json).toContain(`wt:${a.event.id}`);
    expect(json).toContain('간다고 표시한 행사 · 1');
    const h = createInteractionHandlers({ db: t.db, bot: () => undefined, notifier: notifier(), uptimeSec: () => 0, now: () => NOW });
    const reply = (await h.onCommand('내알림', { userId: 'u-2', isAdmin: false, memberRoleIds: [], wsPingMs: 0, subcommand: null, getString: () => null })) as { card: unknown };
    expect(JSON.stringify(reply.card)).toContain('아직 없어요');
  });
});

describe('기존 행사 중복 검사', () => {
  const JP = { title: '初音ミクシンフォニー2027 ソウル公演', venue: 'ロッテコンサートホール' };
  const matcher = (result: (ids: number[]) => MatchResult): Pick<Extractor, 'match'> & { calls: number } => {
    const m = {
      calls: 0,
      async match(_e: Extraction, c: { id: number }[]) {
        m.calls++;
        return { model: 'claude-haiku-5-5', result: result(c.map((x) => x.id)), inputTokens: 200, outputTokens: 20 };
      },
    };
    return m;
  };

  it('같다고 하면 나중 행사에 표시하고 카드를 올린다. 합치면 중복 공지를 지운다', async () => {
    const a = await merge();
    const b = await merge(JP);
    expect(b.created).toBe(true);
    const m = matcher((ids) => ({ matchId: ids[0]!, relation: 'same', confidence: 0.9 }));
    expect(await sweepDuplicates(t.db, m, NOW)).toEqual({ checked: 1, flagged: 1, more: false });
    expect((await t.db.select().from(events).where(eq(events.id, b.event.id)))[0]!.dupOfId).toBe(a.event.id);
    expect(await t.db.select().from(llmCalls)).toHaveLength(1);
    expect((await sweepDuplicates(t.db, m, NOW)).checked).toBe(0); // 표시된 행사는 다시 묻지 않는다

    const post = vi.fn(async (_c: string, _m: unknown) => 'dup-card');
    expect(await postPendingDupCards(t.db, { post }, 'admin', NOW)).toBe(1);
    expect(JSON.stringify(post.mock.calls[0]![1])).toContain(`dp:mg:${b.event.id}`);
    expect(await postPendingDupCards(t.db, { post }, 'admin', NOW)).toBe(0);
    expect(parseDupId(`dp:no:${b.event.id}`)).toEqual({ decision: 'no', eventId: b.event.id });

    await t.db.update(eventDiscord).set({ noticeMessageId: 'dup-notice' }).where(eq(eventDiscord.eventId, b.event.id));
    const bot = fakeBot();
    const h = createInteractionHandlers({ db: t.db, bot: () => bot as never, notifier: notifier(), noticeChannelId: NOTICE, uptimeSec: () => 0, now: () => NOW });
    expect(await h.onButton!(`dp:mg:${b.event.id}`, { userId: 'u-1', isAdmin: false, memberRoleIds: [] })).toEqual({ reply: expect.stringContaining('관리자') });
    const r = await h.onButton!(`dp:mg:${b.event.id}`, admin);
    expect(JSON.stringify(r)).toContain(`#${a.event.id}에 합침`);
    expect(bot.deleteMessage).toHaveBeenCalledWith(NOTICE, 'dup-notice');
    expect((await t.db.select().from(events).where(eq(events.id, b.event.id)))[0]!.mergedInto).toBe(a.event.id);
    expect(JSON.stringify(await h.onButton!(`dp:mg:${b.event.id}`, admin))).toContain('이미 처리된');
  });

  it('다르다고 하면 적어 두고 다시 묻지 않는다. 별개 버튼도 같다', async () => {
    const a = await merge();
    const b = await merge(JP);
    const m = matcher(() => ({ matchId: null, relation: 'different', confidence: 0.9 }));
    expect(await sweepDuplicates(t.db, m, NOW)).toMatchObject({ checked: 1, flagged: 0 });
    expect(await t.db.select().from(eventDistinct)).toHaveLength(1);
    await sweepDuplicates(t.db, m, NOW);
    expect(m.calls).toBe(1);
    await t.db.delete(eventDistinct);
    await t.db.update(events).set({ dupOfId: a.event.id }).where(eq(events.id, b.event.id));
    const r = await decideDupPair(t.db, b.event.id, 'no', 'u-admin', NOW);
    expect(JSON.stringify(r!.message)).toContain('별개 행사로 둠');
    expect((await t.db.select().from(eventDistinct))[0]).toMatchObject({ aId: a.event.id, bId: b.event.id });
  });

  it('배포 후 한 번 자동으로 돌고 끝나면 다시 돌지 않는다', async () => {
    await merge();
    await merge(JP);
    const dupSweep = vi.fn(async () => ({ checked: 1, flagged: 0, more: false }));
    const jobs = createDiscordJobs({ db: t.db, bot: () => undefined, notifier: notifier(), alerter: { alert: async () => {} }, dupSweep, now: () => NOW, log: { log() {}, warn() {}, error() {} } });
    await jobs.autoDupSweep();
    await jobs.autoDupSweep();
    expect(dupSweep).toHaveBeenCalledTimes(1);
    expect(await getSetting(t.db, SETTING_DUP_SWEEP)).toBe('done');
  });
});

describe('월간 달력 그림', () => {
  it('그 달에 걸친 행사를 날짜별로 모으고, 긴 행사는 기간 행사로 뺀다', async () => {
    await merge({ title: 'AGF 2026 미쿠 부스', kind: 'booth', venue: '킨텍스', start_date: '2026-12-04', end_date: '2026-12-06' });
    await merge({ title: '미쿠 <랩핑> 전철 & 카페', kind: 'collab', region: 'JP', venue: null, start_date: '2026-11-21', end_date: '2027-03-21' });
    await merge(); // 2027-02: 12월 달력에는 없음
    const d = await calendarData(t.db, 2026, 12);
    expect(d.total).toBe(2);
    expect([...d.days.keys()]).toEqual(['2026-12-04', '2026-12-05', '2026-12-06']);
    expect(d.long.map((e) => e.kind)).toEqual(['collab']);
    const { svg, height } = calendarSvg(d, '2026-12-05');
    expect(svg).toContain('2026년 12월 미쿠 행사');
    expect(svg).toContain('미쿠 &lt;랩핑&gt; 전철 &amp; 카페');
    expect(svg).toContain('stroke="#39c5bb"'); // 오늘 표시
    expect(height).toBeGreaterThan(900);
    expect(fitText('가'.repeat(30), 100, 16)).toBe(`${'가'.repeat(5)}…`);
  });

  it('PNG로 그려 공지 채널에 올린다. 행사가 없는 달은 올리지 않는다', async () => {
    const bot = fakeBot();
    const jobs = createDiscordJobs({ db: t.db, bot: () => bot as never, notifier: notifier(), alerter: { alert: async () => {} }, noticeChannelId: NOTICE, now: () => NOW, log: { log() {}, warn() {}, error() {} } });
    expect(await jobs.postCalendar()).toContain('행사가 없어');
    expect(await monthlyCalendar(t.db, NOW)).toBeNull();
    await merge({ title: '미쿠 팝업', kind: 'popup', venue: '홍대', start_date: '2026-11-27', end_date: '2026-11-29' });
    expect(await jobs.postCalendar()).toContain('2026년 11월 미쿠 행사 달력');
    const [channel, text, file] = bot.postFile.mock.calls[0]!;
    expect(channel).toBe(NOTICE);
    expect(text).toContain('행사 1건');
    expect(file.name).toBe('miku-2026-11.png');
    expect(file.data.subarray(1, 4).toString()).toBe('PNG');
    expect(file.data.length).toBeGreaterThan(10_000);
  });
});

describe('놓친 행사 주간 리포트', () => {
  it('지난 7일 제보를 놓친 것·잡은 것·관련 없음으로 정리한다. 제보가 없으면 보내지 않는다', async () => {
    expect(missReportMessage(await missReport(t.db, NOW))).toBeNull();
    const a = await merge();
    await t.db.insert(misses).values([
      { eventId: a.event.id, noticedAt: '2026-11-22T00:00:00.000Z', firstSeenSource: 'https://www.wonderlivet.jp/lineup', caughtBySystem: 0, note: 'x' },
      { eventId: a.event.id, noticedAt: '2026-11-21T00:00:00.000Z', firstSeenSource: 'https://x.com/a', caughtBySystem: 1, note: 'x' },
      { eventId: a.event.id, noticedAt: '2026-11-01T00:00:00.000Z', firstSeenSource: 'https://old.example.com', caughtBySystem: 0, note: 'x' },
    ]);
    await t.db.insert(reports).values({ reporterId: 'u', result: '⚪ 미쿠 행사와 관련 없다고 판정했어요', createdAt: '2026-11-22T00:00:00.000Z' });
    const r = await missReport(t.db, NOW);
    expect(r).toMatchObject({ caught: 1, irrelevant: 1, hosts: [{ host: 'wonderlivet.jp', n: 1 }] });
    expect(r.missed).toHaveLength(1);
    const text = missReportMessage(r)!.content!;
    expect(text).toContain('놓친 행사 **1** · 이미 잡은 행사 1 · 관련 없음 1');
    expect(text).toContain('wonderlivet.jp 1건');
  });
});
