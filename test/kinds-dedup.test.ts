import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { eventDiscord, eventSources, events, llmCalls, notifications, rawItems, sources } from '../src/db/schema.js';
import { actionUrl, linkTier, mayReplaceLink } from '../src/pipeline/links.js';
import { cleanupActionLinks, findMatchCandidates, mergeExtraction, parseAliases, periodsOverlap } from '../src/pipeline/merge.js';
import { MATCH_TOOL, matchPrompt, type Extraction, type Extractor, type MatchResult } from '../src/pipeline/extract.js';
import { processPendingItems } from '../src/pipeline/index.js';
import { ensureDefaultSubscriber, headline, planForChange } from '../src/notify/planner.js';
import { detailLines, eventsCard, noticeCard, parseEventsPageId } from '../src/notify/cards.js';
import { actionLabel, kindLabel } from '../src/notify/labels.js';
import { decideReview, parseReviewId, postPendingReviews, reviewMessage } from '../src/notify/review.js';
import { removeNotice } from '../src/notify/noticeThreads.js';
import { guildEventSpec } from '../src/notify/guildEvents.js';
import { setEventKind } from '../src/services/admin.js';
import { getDiagnostics } from '../src/services/diagnostics.js';
import { listUpcomingEvents } from '../src/services/events.js';
import { commandDefinitions } from '../src/notify/commands.js';
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
  is_relevant: true, title: '하츠네 미쿠 심포니 2027 in 서울', kind: 'concert', officiality: 'crypton', region: 'KR', city: '서울', venue: '롯데콘서트홀',
  start_date: '2027-02-06', end_date: '2027-02-07', ticket_open_at: null, ticket_url: null, is_cancelled: false, sale_started: null,
  parent_event_hint: null, summary_ko: '서울에서 미쿠 심포니가 열린다.', confidence: 0.9,
};
async function rawItem(url = 'https://piapro.net/news/1', name = '팝가 (팝업 모음)') {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, name));
  const [r] = await t.db.insert(rawItems).values({ sourceId: s!.id, externalId: `x-${Math.random()}`, url, contentHash: 'h' }).returning();
  return { item: r!, source: s! };
}
type Matcher = (ext: Extraction, c: { id: number }[]) => Promise<MatchResult>;
async function merge(over: Partial<Extraction> = {}, opts: { matcher?: Matcher; url?: string; adapter?: string } = {}) {
  const { item } = await rawItem(opts.url);
  return mergeExtraction(t.db, { ...base, ...over }, {
    rawItemId: item.id, model: 'claude-haiku-5-5', needsReview: false, fromKopis: false, now: NOW,
    item: { url: item.url, adapter: opts.adapter ?? 'html_diff' }, matcher: opts.matcher,
  });
}
const JP = { title: '初音ミクシンフォニー2027 ソウル公演', venue: 'LOTTE Concert Hall', start_date: '2027-02-07', end_date: '2027-02-07' };

describe('행동 링크 검사', () => {
  it('예매처·일반·소개 글 구분', () => {
    expect(linkTier('https://ticket.melon.com/performance/index.htm?prodId=1')).toBe('ticket');
    expect(linkTier('https://m.blog.naver.com/abc/123')).toBe('media');
    expect(linkTier('https://www.youtube.com/watch?v=1')).toBe('media');
    expect(linkTier('https://piapro.net/miku_symphony')).toBe('other');
    expect(linkTier('javascript:alert(1)')).toBeNull();
  });

  it('블로그·SNS 주소와 원문 자체 주소는 행동 링크로 쓰지 않는다', () => {
    expect(actionUrl('https://blog.naver.com/abc/123')).toBeNull();
    expect(actionUrl('https://shop.example.com/goods/1?utm=x', { url: 'https://www.shop.example.com/goods/1/', adapter: 'rss' })).toBeNull();
    expect(actionUrl('https://shop.example.com/goods/1', { url: 'https://news.example.com/a', adapter: 'rss' })).toBe('https://shop.example.com/goods/1');
    // 예매처 수집 항목은 원문 주소가 곧 예매 페이지
    expect(actionUrl('https://ticket.yes24.com/Perf/1', { url: 'https://ticket.yes24.com/Perf/1', adapter: 'ticket' })).toBe('https://ticket.yes24.com/Perf/1');
    expect(mayReplaceLink('https://ticket.melon.com/x', 'https://shop.example.com/y')).toBe(false);
    expect(mayReplaceLink('https://shop.example.com/y', 'https://ticket.melon.com/x')).toBe(true);
    expect(mayReplaceLink(null, 'https://shop.example.com/y')).toBe(true);
  });

  it('병합: 블로그 링크는 버리고, 예매처 링크는 다른 출처가 덮어쓰지 못한다', async () => {
    const a = await merge({ ticket_url: 'https://blog.naver.com/abc/1' });
    expect(a.event.ticketUrl).toBeNull();
    const b = await merge({ ticket_url: 'https://ticket.melon.com/x' });
    expect(b.event.ticketUrl).toBe('https://ticket.melon.com/x');
    const c = await merge({ ticket_url: 'https://piapro.net/symphony' });
    expect(c.event.id).toBe(a.event.id);
    expect(c.event.ticketUrl).toBe('https://ticket.melon.com/x');
  });

  it('이미 저장된 소개 글 주소를 시작할 때 비운다', async () => {
    const { event } = await merge();
    await t.db.update(events).set({ ticketUrl: 'https://blog.naver.com/abc/1' }).where(eq(events.id, event.id));
    const other = await merge({ title: '다른 공연', start_date: '2027-05-01', end_date: '2027-05-01', ticket_url: 'https://ticket.melon.com/y' });
    expect(await cleanupActionLinks(t.db)).toBe(1);
    expect((await t.db.select().from(events).where(eq(events.id, event.id)))[0]!.ticketUrl).toBeNull();
    expect((await t.db.select().from(events).where(eq(events.id, other.event.id)))[0]!.ticketUrl).toBe('https://ticket.melon.com/y');
    expect(await cleanupActionLinks(t.db)).toBe(0);
  });
});

describe('유형별 표기', () => {
  const ev = async (over: Partial<Extraction>) => (await merge(over)).event;
  const flat = (card: unknown) => JSON.stringify(card);

  it('굿즈: 발매 줄, 장소·티켓 줄 없음, 판매처 버튼', async () => {
    const e = await ev({ title: '이치방쿠지 하츠네 미쿠', kind: 'goods', venue: null, city: null, start_date: '2026-11-28', end_date: '2026-11-28', ticket_url: 'https://1kuji.com/products/miku' });
    expect(detailLines(e).join('\n')).toBe('📅 **발매**　2026.11.28(토)');
    const json = flat(noticeCard(e, headline('new', e.status, ''), ['https://blog.piapro.net/1']));
    expect(json).toContain('🛍️ 판매처 보기');
    expect(json).not.toContain('예매하기');
    expect(json).toContain('🛍️ 굿즈');
    expect(guildEventSpec({ ...e, region: 'KR' }, undefined, NOW)).toBeNull();
  });

  it('공연은 티켓 미정 줄과 예매하기, 팝업은 기간·예약 안내', async () => {
    const c = await ev({ ticket_url: 'https://ticket.melon.com/x' });
    expect(detailLines(c)).toContain('🎫 **티켓 오픈**　미정');
    expect(flat(noticeCard(c, headline('new', c.status, ''), []))).toContain('🎫 예매하기');
    const p = await ev({ title: '미쿠 팝업 스토어', kind: 'popup', venue: 'AK플라자 홍대', start_date: '2026-12-10', end_date: '2026-12-24', ticket_url: 'https://booking.example.com/miku' });
    expect(detailLines(p).join('\n')).toContain('📅 **기간**');
    expect(detailLines(p).join('\n')).not.toContain('티켓');
    expect(flat(noticeCard(p, headline('new', p.status, ''), []))).toContain('📝 예약·안내 보기');
    // 예매처 링크면 유형과 상관없이 예매하기
    expect(actionLabel('popup', true)).toBe('🎫 예매하기');
    expect(kindLabel('collab')).toBe('🤝 콜라보');
    expect(kindLabel('live_viewing')).toBe('🎬 상영·라이브뷰잉');
  });

  it('/행사 유형 필터와 페이지 버튼, /관리 유형 변경, /점검 유형별 건수', async () => {
    await ev({});
    const g = await ev({ title: '미쿠 랩핑 전철', kind: 'other', venue: null, start_date: '2026-11-21', end_date: '2027-03-21' });
    expect((await listUpcomingEvents(t.db, { kinds: ['goods', 'collab'] })).length).toBe(0);
    const changed = await setEventKind(t.db, g.id, 'collab', 'u-admin', NOW);
    expect(changed!.kind).toBe('collab');
    const rows = await listUpcomingEvents(t.db, { kinds: ['goods', 'collab'] });
    expect(rows.map((r) => r.title)).toEqual(['미쿠 랩핑 전철']);
    expect(JSON.stringify(eventsCard(rows, 'all', 0, new Map(), 'goods'))).toContain('🛍️ 굿즈·콜라보');
    expect(parseEventsPageId('ev:domestic:2:goods')).toEqual({ scope: 'domestic', page: 2, kind: 'goods' });
    expect(parseEventsPageId('ev:all:0')).toEqual({ scope: 'all', page: 0 });
    expect((await getDiagnostics(t.db)).kinds).toEqual([{ kind: 'collab', upcoming: 1 }, { kind: 'concert', upcoming: 1 }]);
    const opts = (commandDefinitions.find((c) => c.name === '행사') as { options: { name: string }[] }).options.map((o) => o.name);
    expect(opts).toEqual(['범위', '유형', '검색']);
  });
});

describe('같은 행사 찾기', () => {
  it('기간 겹침 판정', () => {
    expect(periodsOverlap('2027-02-06', '2027-02-07', '2027-02-07', null)).toBe(true);
    expect(periodsOverlap('2027-02-06', '2027-02-07', '2027-02-08', null)).toBe(false);
    expect(periodsOverlap('2027-02-06', '2027-02-07', '2027-02-08', null, 1)).toBe(true);
    expect(periodsOverlap(null, null, '2027-02-08', null)).toBe(false);
  });

  it('언어가 다른 제목: 확인 없이는 따로 등록되고, Claude가 같다고 하면 합쳐진다 (별칭 저장)', async () => {
    const first = await merge();
    const matcher = vi.fn<Matcher>(async (_e, c) => ({ matchId: c[0]!.id, relation: 'same', confidence: 0.95 }));
    const second = await merge(JP, { matcher });
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher.mock.calls[0]![1].map((c) => c.id)).toEqual([first.event.id]);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.title).toBe(base.title); // 제목은 그대로
    expect(parseAliases(second.event.aliases)).toEqual([JP.title]);
    expect(await planForChange(t.db, second.event, second)).toBe(0); // 다시 공지하지 않는다
    // 같은 일본어 표기가 다시 오면 별칭으로 바로 찾는다 (다시 묻지 않음)
    const third = await merge({ ...JP, venue: 'ロッテコンサートホール' }, { matcher });
    expect(third.event.id).toBe(first.event.id);
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(await t.db.select().from(eventSources).where(eq(eventSources.eventId, first.event.id))).toHaveLength(3);
  });

  it('애매하면(확신 0.5~0.8) 공지하지 않고 중복 의심으로 두고, 다르다고 하면 새 행사', async () => {
    const first = await merge();
    const suspect = await merge(JP, { matcher: async (_e, c) => ({ matchId: c[0]!.id, relation: 'same', confidence: 0.6 }) });
    expect(suspect.created).toBe(true);
    expect([suspect.event.needsReview, suspect.event.dupOfId]).toEqual([1, first.event.id]);
    expect(await planForChange(t.db, suspect.event, suspect)).toBe(0);
    // 확신 높은 출처가 또 와도 관리자가 정할 때까지 풀지 않는다
    const again = await merge(JP);
    expect(again.event.id).toBe(suspect.event.id);
    expect(again.event.needsReview).toBe(1);
    const other = await merge({ title: 'MIKU EXPO 2027 in Seoul', venue: 'KSPO DOME', start_date: '2027-02-06', end_date: '2027-02-06' }, { matcher: async () => ({ matchId: null, relation: 'different', confidence: 0.9 }) });
    expect(other.created).toBe(true);
    expect(other.event.needsReview).toBe(0);
  });

  it('후보: 기간이 겹치고 지역이 같거나 장소가 같은 행사만. 후보가 없으면 묻지 않는다', async () => {
    const a = await merge();
    await merge({ title: '오사카 공연', region: 'JP', venue: '오사카성홀' });
    await merge({ title: '봄 팝업', kind: 'popup', venue: '홍대', start_date: '2027-04-01', end_date: '2027-04-10' });
    const c = await findMatchCandidates(t.db, { ...base, ...JP });
    expect(c.map((e) => e.id)).toEqual([a.event.id]);
    const matcher = vi.fn<Matcher>(async () => ({ matchId: null, relation: 'different', confidence: 1 }));
    await merge({ title: '여름 행사', venue: '부산', start_date: '2027-08-01', end_date: '2027-08-02' }, { matcher });
    expect(matcher).not.toHaveBeenCalled();
  });

  it('큰 행사 안의 부스는 따로 등록하고 상위 행사로 연결한다', async () => {
    const fest = await merge({ title: 'AGF 2026', kind: 'other', venue: '킨텍스', start_date: '2026-12-04', end_date: '2026-12-06' });
    const booth = await merge(
      { title: '프로젝트 세카이 부스', kind: 'booth', venue: '킨텍스', start_date: '2026-12-04', end_date: '2026-12-06' },
      { matcher: async (_e, c) => ({ matchId: c[0]!.id, relation: 'part_of', confidence: 0.9 }) },
    );
    expect(booth.created).toBe(true);
    expect(booth.event.parentEventId).toBe(fest.event.id);
  });

  it('시작일이 다르게 뽑혀도 기간이 겹치고 제목이 비슷하면 확인 없이 합친다', async () => {
    const a = await merge();
    const b = await merge({ title: '하츠네 미쿠 심포니 2027 서울', start_date: '2027-02-07', end_date: '2027-02-07' });
    expect(b.event.id).toBe(a.event.id);
  });

  it('파이프라인: 확인 호출 비용을 llm_calls에 남긴다', async () => {
    await merge();
    const { item, source } = await rawItem('https://piapro.jp/news/2');
    await t.db.update(rawItems).set({ title: '初音ミク', body: '初音ミクシンフォニー2027 ソウル公演 開催決定 '.repeat(30), llmStatus: 'pending' }).where(eq(rawItems.id, item.id));
    await t.db.update(sources).set({ adapter: 'rss' }).where(eq(sources.id, source.id));
    const extractor: Extractor = {
      async extract(_i, model) { return { model, result: { ...base, ...JP }, inputTokens: 100, outputTokens: 50 }; },
      async match(_e, c) { return { model: 'claude-haiku-5-5', result: { matchId: c[0]!.id, relation: 'same', confidence: 0.9 }, inputTokens: 300, outputTokens: 20 }; },
    };
    const res = await processPendingItems({ db: t.db, extractor, alerter: { alert: async () => {} }, now: () => NOW });
    expect(res.merged).toBe(1);
    expect(await t.db.select().from(events)).toHaveLength(1);
    expect((await t.db.select().from(llmCalls).where(eq(llmCalls.rawItemId, item.id))).map((c) => c.inputTokens).sort()).toEqual([100, 300]);
  });

  it('확인 요청 형식', () => {
    const text = matchPrompt({ ...base, ...JP }, [{ id: 7, title: base.title, aliases: ['MIKU SYMPHONY 2027 Seoul'], kind: 'concert', region: 'KR', city: '서울', venue: '롯데콘서트홀', startDate: '2027-02-06', endDate: '2027-02-07' }]);
    expect(text).toContain('#7 제목: 하츠네 미쿠 심포니 2027 in 서울 | 다른 표기: MIKU SYMPHONY 2027 Seoul');
    expect(text).toContain('기간: 2027-02-07~2027-02-07');
    expect(MATCH_TOOL.name).toBe('judge_same_event');
  });
});

describe('중복 의심 검수 카드', () => {
  const setup = async () => {
    const first = await merge();
    const suspect = await merge(JP, { matcher: async (_e, c) => ({ matchId: c[0]!.id, relation: 'same', confidence: 0.6 }) });
    return { first: first.event, suspect: suspect.event };
  };

  it('카드에 기존 행사와 [합치기]·[별개 행사] 버튼이 나온다', async () => {
    const { first, suspect } = await setup();
    const post = vi.fn(async (_c: string, _m: unknown) => 'rm-1');
    expect(await postPendingReviews(t.db, { post }, 'admin', NOW)).toBe(1);
    const json = JSON.stringify(post.mock.calls[0]![1]);
    expect(json).toContain('중복 의심');
    expect(json).toContain(`같아 보이는 기존 행사** #${first.id}`);
    expect(json).toContain(`rv:mg:${suspect.id}`);
    expect(json).toContain('별개 행사로 알리기');
    expect(parseReviewId(`rv:mg:${suspect.id}`)).toEqual({ decision: 'mg', eventId: suspect.id });
    expect(JSON.stringify(reviewMessage(first, []))).not.toContain('rv:mg');
  });

  it('합치기: 출처를 기존 행사로 옮기고 알리지 않는다. 같은 표기가 다시 오면 기존 행사로 간다', async () => {
    const { first, suspect } = await setup();
    const r = await decideReview(t.db, suspect.id, 'mg', 'u-admin', NOW);
    expect(r!.queued).toBe(0);
    expect(JSON.stringify(r!.message)).toContain(`기존 행사 #${first.id}에 합침`);
    const [s] = await t.db.select().from(events).where(eq(events.id, suspect.id));
    expect([s!.needsReview, s!.mergedInto, s!.dupOfId]).toEqual([2, first.id, null]);
    expect(await t.db.select().from(eventSources).where(eq(eventSources.eventId, first.id))).toHaveLength(2);
    expect(parseAliases((await t.db.select().from(events).where(eq(events.id, first.id)))[0]!.aliases)).toEqual([JP.title]);
    expect((await merge(JP)).event.id).toBe(first.id);
    expect(JSON.stringify((await decideReview(t.db, suspect.id, 'mg', 'u-admin', NOW))!.message)).toContain('이미 처리된');
  });

  it('별개 행사로 알리기: 새 행사 알림을 보낸다', async () => {
    const { suspect } = await setup();
    const r = await decideReview(t.db, suspect.id, 'ok', 'u-admin', NOW);
    expect(r!.queued).toBe(1);
    const [s] = await t.db.select().from(events).where(eq(events.id, suspect.id));
    expect([s!.needsReview, s!.dupOfId]).toEqual([0, null]);
  });
});

describe('합칠 때 중복 공지 정리', () => {
  it('흡수한 행사의 공지를 지우고 스레드에 안내를 남긴다. 아직 안 보낸 알림은 지운다', async () => {
    const a = await merge();
    const b = await merge({ title: 'MIKU SYMPHONY 2027 Seoul', venue: 'Lotte Concert Hall' });
    expect(b.created).toBe(true);
    await planForChange(t.db, b.event, b);
    await t.db.insert(eventDiscord).values([
      { eventId: a.event.id, noticeMessageId: 'keep-msg' },
      { eventId: b.event.id, noticeMessageId: 'dup-msg', noticeThreadId: 'dup-thread' },
    ]);
    const { mergeEvents } = await import('../src/services/admin.js');
    await mergeEvents(t.db, a.event.id, b.event.id, 'u-admin', NOW);
    expect(await t.db.select().from(notifications).where(eq(notifications.eventId, b.event.id))).toHaveLength(0);
    const bot = { isReady: () => true, post: vi.fn(async () => 'x'), editMessage: vi.fn(), startThread: vi.fn(), deleteMessage: vi.fn(async () => {}) };
    const deps = { db: t.db, notifier: { sendNotice: vi.fn(), alerter: { alert: vi.fn() } } as never, noticeChannelId: NOTICE, bot: bot as never };
    expect(await removeNotice(deps, b.event.id, a.event.id, 'g1')).toBe(true);
    expect(bot.deleteMessage).toHaveBeenCalledWith(NOTICE, 'dup-msg');
    expect(bot.post).toHaveBeenCalledWith('dup-thread', { content: `이 행사는 같은 행사의 다른 공지로 합쳐졌어요. → https://discord.com/channels/g1/${NOTICE}/keep-msg` });
    expect(await removeNotice(deps, b.event.id, a.event.id, 'g1')).toBe(false);
  });
});
