import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { eventStateLog, events, llmCalls, notifications, rawItems, sources, subscribers } from '../src/db/schema.js';
import { deriveStatus, nextStatus } from '../src/pipeline/state.js';
import { dedupKey, mergeExtraction, sweepStatuses, titleSimilarity } from '../src/pipeline/merge.js';
import { costUsd, createAnthropicExtractor, LlmConfigError, type ExtractInput, type Extraction, type Extractor, TransientLlmError } from '../src/pipeline/extract.js';
import { processPendingItems } from '../src/pipeline/index.js';
import { ensureDefaultSubscriber, planForChange, planNotifications, renderEventMessage } from '../src/notify/planner.js';
import { planReminders, reminderSlot } from '../src/notify/reminders.js';
import { sendQueued } from '../src/notify/sender.js';
import type { Notifier } from '../src/notify/notifier.js';
import { listUpcomingEvents, parseEventScope, type EventScope } from '../src/services/events.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
});
afterEach(() => t.cleanup());

const NOW = new Date('2026-11-22T12:00:00Z'); // 한국 2026-11-22 21:00
const base: Extraction = {
  is_relevant: true,
  title: 'HATSUNE MIKU EXPO 2027 KOREA',
  kind: 'concert',
  officiality: 'crypton',
  region: 'KR',
  city: '서울',
  venue: '올림픽홀',
  start_date: '2027-03-06',
  end_date: '2027-03-07',
  ticket_open_at: null,
  ticket_url: null,
  is_cancelled: false,
  sale_started: null,
  parent_event_hint: null,
  summary_ko: '서울에서 미쿠 엑스포가 열린다.',
  confidence: 0.9,
};
const ext = (over: Partial<Extraction> = {}): Extraction => ({ ...base, ...over });

async function rawItem(sourceName = 'X @cfm_miku', over: Partial<typeof rawItems.$inferInsert> = {}) {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, sourceName));
  const [r] = await t.db
    .insert(rawItems)
    .values({ sourceId: s!.id, externalId: `x-${Math.random()}`, title: '初音ミク MIKU EXPO 2027 KOREA 開催決定', body: 'ソウルで開催', contentHash: 'h', ...over })
    .returning();
  return r!;
}
const ctx = (rawItemId: number, over = {}) => ({ rawItemId, model: 'claude-haiku-5-5', needsReview: false, fromKopis: false, now: NOW, ...over });

describe('상태 전이 (규칙 6)', () => {
  it('일정과 시각으로 상태를 계산한다', () => {
    const d = { startDate: '2027-03-06', endDate: '2027-03-07', ticketOpenAt: null };
    expect(deriveStatus(d, NOW)).toBe('announced');
    expect(deriveStatus({ ...d, ticketOpenAt: '2026-12-01T11:00:00.000Z' }, NOW)).toBe('ticket_scheduled');
    expect(deriveStatus({ ...d, ticketOpenAt: '2026-11-20T11:00:00.000Z' }, NOW)).toBe('on_sale');
    expect(deriveStatus({ ...d, startDate: '2026-11-20', endDate: '2026-11-30' }, NOW)).toBe('ongoing');
    expect(deriveStatus({ ...d, startDate: '2026-11-01', endDate: '2026-11-10' }, NOW)).toBe('ended');
    expect(deriveStatus({ ...d, isCancelled: true }, NOW)).toBe('cancelled');
  });
  it('KOPIS만으로는 판매 중으로 만들지 않는다 (규칙 15)', () => {
    const d = { startDate: '2027-03-06', endDate: null, ticketOpenAt: null, saleStarted: true };
    expect(deriveStatus(d, NOW)).toBe('on_sale');
    expect(deriveStatus({ ...d, fromKopis: true }, NOW)).toBe('announced');
  });
  it('뒤로 가지 않고, 취소는 어디서든', () => {
    expect(nextStatus('on_sale', 'ticket_scheduled')).toBe('on_sale');
    expect(nextStatus('announced', 'ongoing')).toBe('ongoing'); // 예매 없는 팝업
    expect(nextStatus('ongoing', 'cancelled')).toBe('cancelled');
    expect(nextStatus('cancelled', 'on_sale')).toBe('cancelled');
  });
});

describe('병합 (규칙 5)', () => {
  it('dedup_key와 제목 유사도', () => {
    expect(dedupKey('HATSUNE MIKU EXPO 2027 KOREA', '2027-03-06', '올림픽 홀')).toBe('hatsunemikuexpo2027korea|2027-03-06|올림픽홀');
    expect(titleSimilarity('HATSUNE MIKU EXPO 2027 KOREA', 'HATSUNE MIKU EXPO 2027 in KOREA')).toBeGreaterThan(0.7);
    expect(titleSimilarity('HATSUNE MIKU EXPO 2027 KOREA', '매지컬 미라이 2027')).toBeLessThan(0.2);
  });

  it('새 행사를 만들고, 같은 행사(표기 차이)는 합치며 바뀐 필드를 기록한다', async () => {
    const r1 = await rawItem();
    const m1 = await mergeExtraction(t.db, ext(), ctx(r1.id));
    expect(m1).toMatchObject({ created: true, statusChanged: true });
    expect(m1.event.status).toBe('announced');

    const r2 = await rawItem('멜론티켓 오픈 소식');
    const m2 = await mergeExtraction(t.db, ext({ title: 'HATSUNE MIKU EXPO 2027 in KOREA', venue: '올림픽공원 올림픽홀', ticket_open_at: '2026-12-01T11:00:00.000Z', ticket_url: 'https://ticket.melon.com/csoon/detail.htm?csoonId=1' }), ctx(r2.id));
    expect(m2.created).toBe(false);
    expect(m2.event.id).toBe(m1.event.id);
    expect(m2.event.status).toBe('ticket_scheduled');
    expect(m2.event.ticketOpenAt).toBe('2026-12-01T11:00:00.000Z');
    expect(m2.event.title).toBe('HATSUNE MIKU EXPO 2027 KOREA'); // 제목은 처음 것 유지
    const logs = await t.db.select().from(eventStateLog).where(eq(eventStateLog.eventId, m1.event.id));
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1]!.changedFields!)).toHaveProperty('ticketOpenAt');
    expect(await t.db.select().from(events)).toHaveLength(1);
  });

  it('시작일 미정 행사에 날짜가 생기면 같은 행사로 채운다', async () => {
    const m1 = await mergeExtraction(t.db, ext({ start_date: null, end_date: null, venue: null }), ctx((await rawItem()).id));
    const m2 = await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    expect(m2.event.id).toBe(m1.event.id);
    expect(m2.event.startDate).toBe('2027-03-06');
  });

  it('다른 행사는 따로 만든다', async () => {
    await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    await mergeExtraction(t.db, ext({ title: '초음 미쿠 콜라보 카페 in 홍대', kind: 'cafe', venue: '애니메이트 카페 홍대', start_date: '2027-03-06' }), ctx((await rawItem()).id));
    expect(await t.db.select().from(events)).toHaveLength(2);
  });

  it('시간이 지나면 판매 중 → 진행 중 → 종료로 넘어간다', async () => {
    await mergeExtraction(t.db, ext({ ticket_open_at: '2026-12-01T11:00:00.000Z' }), ctx((await rawItem()).id));
    expect((await sweepStatuses(t.db, new Date('2026-12-01T12:00:00Z')))[0]!.event.status).toBe('on_sale');
    expect((await sweepStatuses(t.db, new Date('2027-03-06T03:00:00Z')))[0]!.event.status).toBe('ongoing');
    expect((await sweepStatuses(t.db, new Date('2027-03-08T03:00:00Z')))[0]!.event.status).toBe('ended');
    expect(await sweepStatuses(t.db, new Date('2027-03-09T03:00:00Z'))).toEqual([]);
  });
});

describe('알림 (규칙 7)', () => {
  beforeEach(async () => {
    await ensureDefaultSubscriber(t.db, { noticeChannelId: '123456789012345680', hasWebhook: false });
  });

  it('기본 구독자는 한 번만 만든다', async () => {
    await ensureDefaultSubscriber(t.db, { noticeChannelId: '123456789012345680', hasWebhook: false });
    expect(await t.db.select().from(subscribers)).toHaveLength(1);
  });

  it('새 행사는 new, 같은 알림은 두 번 큐에 넣지 않는다', async () => {
    const m = await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    expect(await planForChange(t.db, m.event, m)).toBe(1);
    expect(await planNotifications(t.db, m.event, 'new')).toBe(0);
    const [n] = await t.db.select().from(notifications);
    expect(n).toMatchObject({ reason: 'new', eventStatus: 'announced', status: 'queued' });
  });

  it('검수 대기·종료된 새 행사는 알리지 않는다', async () => {
    const m1 = await mergeExtraction(t.db, ext(), ctx((await rawItem()).id, { needsReview: true }));
    expect(await planForChange(t.db, m1.event, m1)).toBe(0);
    const m2 = await mergeExtraction(t.db, ext({ title: '매지컬 미라이 2026', start_date: '2026-08-01', end_date: '2026-08-03' }), ctx((await rawItem()).id));
    expect(m2.event.status).toBe('ended');
    expect(await planForChange(t.db, m2.event, m2)).toBe(0);
  });

  it('상태 변경은 예매 예정·판매 중·취소일 때만', async () => {
    const m = await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    expect(await planForChange(t.db, { ...m.event, status: 'ongoing' }, { created: false, statusChanged: true })).toBe(0);
    expect(await planForChange(t.db, { ...m.event, status: 'on_sale' }, { created: false, statusChanged: true })).toBe(1);
    expect(await planForChange(t.db, { ...m.event, status: 'cancelled' }, { created: false, statusChanged: true })).toBe(1);
  });

  it('리마인더: 24시간 전과 1시간 전 두 번, 각각 한 번만', async () => {
    expect(reminderSlot('2026-12-01T11:00:00.000Z', new Date('2026-11-30T10:00:00Z'))).toBe(null);
    expect(reminderSlot('2026-12-01T11:00:00.000Z', new Date('2026-11-30T12:00:00Z'))).toBe('T-24h');
    expect(reminderSlot('2026-12-01T11:00:00.000Z', new Date('2026-12-01T10:30:00Z'))).toBe('T-1h');
    expect(reminderSlot('2026-12-01T11:00:00.000Z', new Date('2026-12-01T11:00:00Z'))).toBe(null);

    await mergeExtraction(t.db, ext({ ticket_open_at: '2026-12-01T11:00:00.000Z' }), ctx((await rawItem()).id));
    expect(await planReminders(t.db, new Date('2026-11-30T12:00:00Z'))).toBe(1);
    expect(await planReminders(t.db, new Date('2026-11-30T18:00:00Z'))).toBe(0);
    expect(await planReminders(t.db, new Date('2026-12-01T10:30:00Z'))).toBe(1);
    expect(await planReminders(t.db, new Date('2026-12-01T10:50:00Z'))).toBe(0);
    const slots = (await t.db.select().from(notifications)).map((n) => n.slot);
    expect(slots).toEqual(['T-24h', 'T-1h']);
  });

  it('임베드: 머리말, 한국 시각 + 상대 시각, 구분, 예매·출처 링크', async () => {
    const m = await mergeExtraction(t.db, ext({ ticket_open_at: '2026-12-01T11:00:00.000Z', ticket_url: 'https://ticket.melon.com/x' }), ctx((await rawItem()).id));
    const msg = renderEventMessage(m.event, 'reminder', 'T-1h', ['https://x.com/cfm_miku/status/1']);
    const embed = msg.embeds![0] as { author: { name: string }; title: string; url: string; description: string; fields: { name: string; value: string }[]; image?: { url: string } };
    expect(embed.author.name).toBe('⏰ 티켓 오픈 1시간 전');
    expect(embed.title).toBe('HATSUNE MIKU EXPO 2027 KOREA');
    expect(embed.url).toBe('https://ticket.melon.com/x');
    expect(embed.description).toContain('📅 **일정**　2027.03.06(토) ~ 03.07(일)');
    expect(embed.description).toContain('📍 **장소**　서울 · 올림픽홀');
    expect(embed.description).toContain('🎫 **티켓 오픈**　2026.12.01(화) 20:00 KST · <t:1796122800:R>');
    expect(embed.description).toContain('🇰🇷 국내 · 🎤 공연 · 크립톤 공식');
    expect(embed.fields).toEqual([
      { name: '바로가기', value: '[🎫 예매하기](https://ticket.melon.com/x)', inline: true },
      { name: '출처', value: '[x.com](https://x.com/cfm_miku/status/1)', inline: true },
    ]);
    expect(embed.image?.url).toBe('https://raw.githubusercontent.com/catdevdog/miku-event-tracker/main/assets/region-kr.png');
    expect(msg.card).toHaveLength(1);
    const jp = renderEventMessage({ ...m.event, region: 'JP' }, 'new').embeds![0] as { image?: { url: string } };
    expect(jp.image?.url).toMatch(/\/assets\/region-jp\.png$/);
    const other = renderEventMessage({ ...m.event, region: 'OTHER' }, 'new').embeds![0] as { image?: { url: string } };
    expect(other.image?.url).toMatch(/\/assets\/region-overseas\.png$/);
  });

  it('발송: 공지 채널은 notifier로, 실패하면 3회까지 다시 시도', async () => {
    const m = await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    await planForChange(t.db, m.event, m);
    let fail = true;
    const notifier: Notifier = { sendNotice: vi.fn(async () => { if (fail) throw new Error('Missing Access'); return 'bot' as const; }), alerter: { alert: async () => {} } };
    const deps = { db: t.db, notifier, noticeChannelId: '123456789012345680' };
    expect(await sendQueued(deps)).toEqual({ sent: 0, failed: 1 });
    expect(await sendQueued(deps)).toEqual({ sent: 0, failed: 1 });
    fail = false;
    expect(await sendQueued(deps)).toEqual({ sent: 1, failed: 0 });
    const [n] = await t.db.select().from(notifications);
    expect(n).toMatchObject({ status: 'sent', attempts: 3 });
    expect(await sendQueued(deps)).toEqual({ sent: 0, failed: 0 });
  });
});

describe('processPendingItems', () => {
  function fakeExtractor(results: Record<string, Extraction | Error>): Extractor & { calls: { model: string; input: ExtractInput }[] } {
    const calls: { model: string; input: ExtractInput }[] = [];
    return {
      calls,
      async extract(input, model) {
        calls.push({ model, input });
        const r = results[model];
        if (r instanceof Error) throw r;
        return { model, result: r!, inputTokens: 1000, outputTokens: 200 };
      },
    };
  }
  const alerter = { alert: vi.fn(async () => {}) };

  beforeEach(async () => {
    await ensureDefaultSubscriber(t.db, { noticeChannelId: '123456789012345680', hasWebhook: false });
  });

  it('키워드에 안 걸리면 skipped, 걸리면 추출 → 행사 → 알림 큐, 호출 비용 기록', async () => {
    await rawItem('X @cfm_miku', { title: '新しいソフトウェア発売', body: 'Voice Drive' });
    const hit = await rawItem();
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext() });
    const r = await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW });
    expect(r).toMatchObject({ skipped: 1, merged: 1, queued: 1, errors: 0 });
    expect(ex.calls).toHaveLength(1);
    const [item] = await t.db.select().from(rawItems).where(eq(rawItems.id, hit.id));
    expect(item).toMatchObject({ keywordHit: 'strong', llmStatus: 'done' });
    const [call] = await t.db.select().from(llmCalls);
    expect(call!.costUsd).toBeCloseTo(costUsd('claude-haiku-5-5', 1000, 200));
    expect(call!.costUsd).toBeCloseTo(0.0002);
  });

  it('확신이 낮으면 Sonnet으로 다시 판정하고, 그래도 낮으면 검수 대기로 두고 알리지 않는다', async () => {
    await rawItem();
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext({ confidence: 0.5 }), 'claude-sonnet-5-5': ext({ confidence: 0.6 }) });
    const r = await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW });
    expect(ex.calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(r.queued).toBe(0);
    const [e] = await t.db.select().from(events);
    expect(e!.needsReview).toBe(1);
  });

  it('관련 없음 판정은 행사를 만들지 않는다', async () => {
    await rawItem();
    await processPendingItems({ db: t.db, extractor: fakeExtractor({ 'claude-haiku-5-5': ext({ is_relevant: false }) }), alerter, now: () => NOW });
    expect(await t.db.select().from(events)).toHaveLength(0);
  });

  it('API 일시 장애면 멈추고 원문은 pending으로 남긴다', async () => {
    await rawItem();
    await rawItem();
    const r = await processPendingItems({ db: t.db, extractor: fakeExtractor({ 'claude-haiku-5-5': new TransientLlmError('529') }), alerter, now: () => NOW });
    expect(r.paused).toBe(true);
    expect((await t.db.select().from(rawItems)).every((i) => i.llmStatus === 'pending')).toBe(true);
  });

  it('네이버 원문은 검색 결과 대신 원문 페이지를 LLM에 넘긴다 (규칙 9)', async () => {
    await rawItem('네이버 검색 (뉴스·블로그·카페)', { title: '하츠네 미쿠 팝업 후기', body: '검색 결과 요약 하츠네 미쿠', url: 'https://blog.naver.com/x/1' });
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext({ kind: 'popup' }) });
    const page = `원문 페이지 본문 ${'내용 '.repeat(100)}`;
    await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW, fetchPage: async () => page });
    expect(ex.calls[0]!.input.body).toBe(page);
    expect(ex.calls[0]!.input.title).toBeNull();
  });

  it('네이버 블로그는 PostView 주소로 본문을 가져오고, 본문이 너무 짧으면(회원 전용 카페 등) LLM을 건너뛴다', async () => {
    await rawItem('네이버 검색 (뉴스·블로그·카페)', { title: '하츠네 미쿠 팝업 후기', body: '하츠네 미쿠', url: 'https://blog.naver.com/mikufan39/224000000001' });
    await rawItem('네이버 검색 (뉴스·블로그·카페)', { title: '하츠네 미쿠 카페 예약', body: '하츠네 미쿠', url: 'https://cafe.naver.com/vocaloidkr/123456' });
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext({ kind: 'popup' }) });
    const fetchPage = vi.fn(async (u: string) => (u.includes('PostView') ? `하츠네 미쿠 팝업 후기 ${'본문 '.repeat(100)}` : '네이버 카페'));
    const r = await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW, fetchPage });
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(['https://blog.naver.com/PostView.naver?blogId=mikufan39&logNo=224000000001', 'https://cafe.naver.com/vocaloidkr/123456']);
    expect(ex.calls).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it('본문이 짧은 링크 항목은 원문 페이지를 가져온다', async () => {
    await rawItem('mikuexpo.com', { title: 'HATSUNE MIKU EXPO 2027 KOREA', body: 'HATSUNE MIKU EXPO 2027 KOREA', url: 'https://mikuexpo.com/korea2027/' });
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext() });
    const fetchPage = vi.fn(async () => '서울 올림픽홀 2027년 3월 6일~7일');
    await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW, fetchPage });
    expect(fetchPage).toHaveBeenCalledWith('https://mikuexpo.com/korea2027/');
    expect(ex.calls[0]!.input.body).toContain('올림픽홀');
  });

  it('짧은 링크 항목이 키워드에서 떨어지면 원문 페이지로 다시 판정한다 (출연진에만 미쿠가 있는 행사)', async () => {
    await rawItem('팝가 (팝업 모음)', { title: '원더리벳 2026 | 라인업·타임테이블·티켓 가격', body: '', url: 'https://popga.co.kr/content/magazine/527' });
    const page = '원더리벳 2026 킨텍스 제2전시장 DAY 2 12:00 양치기소년단 13:00 WONDER STAGE TAK with 하츠네 미쿠 & 카사네 테토';
    const fetchPage = vi.fn(async () => page);
    const ex = fakeExtractor({
      'claude-haiku-5-5': ext({ title: 'TAK with 하츠네 미쿠 & 카사네 테토', kind: 'stage', officiality: 'licensed', city: '고양', venue: '킨텍스 제2전시장', start_date: '2026-11-21', end_date: '2026-11-21', parent_event_hint: '원더리벳 2026' }),
    });
    const r = await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(ex.calls[0]!.input.body).toBe(page);
    expect(r.merged).toBe(1);
    const [item] = await t.db.select().from(rawItems);
    expect(item).toMatchObject({ keywordHit: 'strong', llmStatus: 'done' });
    expect((await t.db.select().from(events))[0]).toMatchObject({ kind: 'stage', venue: '킨텍스 제2전시장' });
  });

  it('원문 페이지에도 키워드가 없으면 그대로 버리고, X·KOPIS는 페이지를 가져오지 않는다', async () => {
    await rawItem('팝가 (팝업 모음)', { title: '코난 팝업 오픈', body: '', url: 'https://popga.co.kr/popup/1' });
    await rawItem('X @cfm_miku', { title: '新しいソフトウェア発売', body: 'Voice Drive', url: 'https://x.com/cfm_miku/status/1' });
    const fetchPage = vi.fn(async () => '명탐정 코난 팝업 홍대');
    const ex = fakeExtractor({ 'claude-haiku-5-5': ext() });
    const r = await processPendingItems({ db: t.db, extractor: ex, alerter, now: () => NOW, fetchPage });
    expect(r.skipped).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(ex.calls).toHaveLength(0);
  });

  it('API 키가 없으면 키워드 판정만 하고 pending으로 둔다', async () => {
    await rawItem();
    await processPendingItems({ db: t.db, alerter, now: () => NOW });
    const [i] = await t.db.select().from(rawItems);
    expect(i).toMatchObject({ keywordHit: 'strong', llmStatus: 'pending' });
  });

  it('키·요청 형식 오류는 원문을 그대로 두고 한 번 알린다', async () => {
    await rawItem();
    const al = { alert: vi.fn(async () => {}) };
    const r = await processPendingItems({ db: t.db, extractor: fakeExtractor({ 'claude-haiku-5-5': new LlmConfigError('Claude API 요청 오류 (401)') }), alerter: al, now: () => NOW });
    expect(r.paused).toBe(true);
    expect(al.alert).toHaveBeenCalledTimes(1);
    expect((await t.db.select().from(rawItems))[0]!.llmStatus).toBe('pending');
  });
});

describe('Anthropic 추출기', () => {
  const toolResponse = (input: unknown) => ({
    content: [{ type: 'tool_use', id: 't', name: 'record_event', input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 900, output_tokens: 150 },
  });
  const input = { sourceName: 'X @cfm_miku', sourceLayer: 'L1', body: '本文', now: NOW };

  it('강제 도구 호출로 보내고 결과를 검증한다', async () => {
    const create = vi.fn(async () => toolResponse({ ...base, ticket_open_at: '2026-12-01T20:00:00+09:00' }));
    const ex = createAnthropicExtractor('k', { messages: { create } } as never);
    const r = await ex.extract(input, 'claude-haiku-5-5');
    const req = (create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'record_event', disable_parallel_tool_use: true });
    expect(req.tools[0].strict).toBe(true);
    expect(req.system).toContain('오늘은 2026-11-22');
    expect(r.result.ticket_open_at).toBe('2026-12-01T11:00:00.000Z');
    expect(r).toMatchObject({ inputTokens: 900, outputTokens: 150 });
  });

  it('Sonnet은 처음부터 auto + strict로 보내고, 강제 호출을 거부하는 모델은 auto로 바꿔 다시 보낸다', async () => {
    const create = vi.fn(async () => toolResponse(base));
    const ex = createAnthropicExtractor('k', { messages: { create } } as never);
    await ex.extract(input, 'claude-sonnet-5-5');
    expect((create.mock.calls[0] as unknown as [Record<string, any>])[0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect((create.mock.calls[0] as unknown as [Record<string, any>])[0].tools[0].strict).toBe(true);

    const create2 = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('400 tool_choice: type "tool" and "any" are not supported for this model.'), { status: 400 }))
      .mockResolvedValue(toolResponse(base));
    const ex2 = createAnthropicExtractor('k', { messages: { create: create2 } } as never);
    await ex2.extract(input, 'claude-haiku-5-5');
    await ex2.extract(input, 'claude-haiku-5-5');
    expect(create2.mock.calls.map((c) => ((c as unknown as [Record<string, any>])[0].tool_choice as { type: string }).type)).toEqual(['tool', 'auto', 'auto']);
  });

  it('auto에서 도구를 부르지 않으면 오류(원문 단위 실패)', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: '모르겠습니다' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    const ex = createAnthropicExtractor('k', { messages: { create } } as never);
    await expect(ex.extract(input, 'claude-sonnet-5-5')).rejects.toThrow(/도구 호출이 없는 응답/);
  });

  it('strict를 거부하면 strict 없이 한 번 더 보낸다', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('tools.0.strict: not supported'), { status: 400 }))
      .mockResolvedValue(toolResponse(base));
    const ex = createAnthropicExtractor('k', { messages: { create } } as never);
    await ex.extract(input, 'claude-haiku-5-5');
    expect((create.mock.calls[1] as unknown as [Record<string, any>])[0].tools[0].strict).toBe(false);
  });

  it('상태 코드별로 일시 오류와 설정 오류를 구분한다', async () => {
    const mk = (status: number) => createAnthropicExtractor('k', { messages: { create: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status })) } } as never);
    await expect(mk(529).extract(input, 'm')).rejects.toBeInstanceOf(TransientLlmError);
    await expect(mk(401).extract(input, 'm')).rejects.toBeInstanceOf(LlmConfigError);
  });
});


describe('/행사 조회 범위', () => {
  it('국내·일본·해외(일본 제외)·전체로 거른다', async () => {
    await mergeExtraction(t.db, ext(), ctx((await rawItem()).id));
    await mergeExtraction(t.db, ext({ title: '初音ミク マジカルミライ 2027', region: 'JP', city: '千葉', venue: '幕張メッセ', start_date: '2027-08-20', end_date: '2027-08-22' }), ctx((await rawItem()).id));
    await mergeExtraction(t.db, ext({ title: 'MIKU EXPO 2027 NORTH AMERICA', region: 'OTHER', city: 'Los Angeles', venue: 'Peacock Theater', start_date: '2027-05-01', end_date: '2027-05-01' }), ctx((await rawItem()).id));
    const regions = async (scope: EventScope) => (await listUpcomingEvents(t.db, { scope })).map((e) => e.region);
    expect(await regions('domestic')).toEqual(['KR']);
    expect(await regions('japan')).toEqual(['JP']);
    expect(await regions('overseas')).toEqual(['OTHER']);
    expect(await regions('all')).toEqual(['KR', 'OTHER', 'JP']);
    expect(parseEventScope('japan')).toBe('japan');
    expect(parseEventScope(null)).toBe('all');
    expect(parseEventScope('moon')).toBe('all');
  });
});
