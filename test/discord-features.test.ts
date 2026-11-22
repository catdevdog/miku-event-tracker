import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { seedDatabase } from '../src/db/seed.js';
import { eventDiscord, events, llmCalls, notifications, rawItems, sources } from '../src/db/schema.js';
import { mergeExtraction, type EventRow } from '../src/pipeline/merge.js';
import type { Extraction } from '../src/pipeline/extract.js';
import { ensureDefaultSubscriber, planForChange } from '../src/notify/planner.js';
import { decideReview, parseReviewId, postPendingReviews, reviewMessage } from '../src/notify/review.js';
import { guildEventSpec, specHash, syncGuildEvents, type GuildEventApi } from '../src/notify/guildEvents.js';
import { weekRangeKst, weeklyData, weeklyMessage } from '../src/notify/weekly.js';
import { createDiscordJobs } from '../src/notify/discordJobs.js';
import { createQaAnswerer, qaEvents, qaSystemPrompt } from '../src/services/qa.js';
import { listUpcomingEvents } from '../src/services/events.js';
import type { Notifier } from '../src/notify/notifier.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
  await ensureDefaultSubscriber(t.db, { noticeChannelId: '123456789012345680', hasWebhook: false });
});
afterEach(() => t.cleanup());

const NOW = new Date('2026-11-23T00:00:00Z'); // 한국 2026-11-23(월) 09:00
const base: Extraction = {
  is_relevant: true, title: '하츠네 미쿠 팝업 in 홍대', kind: 'popup', officiality: 'licensed', region: 'KR', city: '서울', venue: 'AK플라자 홍대',
  start_date: '2026-12-10', end_date: '2026-12-24', ticket_open_at: null, ticket_url: null, is_cancelled: false, sale_started: null,
  parent_event_hint: null, summary_ko: '홍대에서 미쿠 팝업이 열린다.', confidence: 0.5,
};
async function rawItem(name = '팝가 (팝업 모음)') {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, name));
  const [r] = await t.db.insert(rawItems).values({ sourceId: s!.id, externalId: `x-${Math.random()}`, url: 'https://popga.co.kr/popup/1', contentHash: 'h' }).returning();
  return r!;
}
const merge = async (over: Partial<Extraction> = {}, needsReview = true) =>
  mergeExtraction(t.db, { ...base, ...over }, { rawItemId: (await rawItem()).id, model: 'claude-sonnet-5-5', needsReview, fromKopis: false, now: NOW });

type Node = { type: number; components?: Node[]; accessory?: Node; content?: string; custom_id?: string; label?: string };
const flat = (nodes: unknown[]) => {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    out.push(n);
    n.components?.forEach(walk);
    if (n.accessory) walk(n.accessory);
  };
  (nodes as Node[]).forEach(walk);
  return out;
};
const text = (nodes: unknown[]) => flat(nodes).map((n) => n.content ?? '').join('\n');

describe('검수 대기 → 디스코드 승인', () => {
  it('카드를 한 번만 올리고, 승인하면 알림을 큐에 넣는다 (두 번 눌러도 한 번)', async () => {
    const m = await merge();
    expect(m.event.needsReview).toBe(1);
    const poster = { post: vi.fn(async (_ch: string, _m: unknown) => 'msg-1') };
    expect(await postPendingReviews(t.db, poster, 'admin-ch', NOW)).toBe(1);
    expect(await postPendingReviews(t.db, poster, 'admin-ch', NOW)).toBe(0);
    const card = poster.post.mock.calls[0]![1] as { card: unknown[] };
    const buttons = flat(card.card).filter((n) => n.type === 2);
    expect(buttons.map((b) => b.custom_id)).toEqual([`rv:ok:${m.event.id}`, `rv:no:${m.event.id}`]);
    expect(text(card.card)).toContain('🔍 검수 대기');
    expect(text(card.card)).toContain('[팝가 (팝업 모음)](https://popga.co.kr/popup/1) · 확신도 0.50');
    expect((await t.db.select().from(eventDiscord))[0]).toMatchObject({ reviewChannelId: 'admin-ch', reviewMessageId: 'msg-1' });

    expect(parseReviewId(`rv:ok:${m.event.id}`)).toEqual({ decision: 'ok', eventId: m.event.id });
    const r = await decideReview(t.db, m.event.id, 'ok', '111', NOW);
    expect(r!.queued).toBe(1);
    expect(text(r!.message.card!)).toContain('✅ 승인됨 · <@111>');
    expect(flat(r!.message.card!).some((n) => n.type === 2)).toBe(false);
    expect((await listUpcomingEvents(t.db)).map((e) => e.id)).toEqual([m.event.id]);
    const again = await decideReview(t.db, m.event.id, 'no', '222', NOW);
    expect(again!.queued).toBe(0);
    expect(text(again!.message.card!)).toContain('이미 처리된 행사');
    expect(await t.db.select().from(notifications)).toHaveLength(1);
  });

  it('무시하면 2로 두고, 확신 높은 출처가 와도 다시 풀지 않으며 알리지 않는다', async () => {
    const m = await merge();
    await decideReview(t.db, m.event.id, 'no', '111', NOW);
    const later = await merge({ confidence: 0.95 }, false);
    expect(later.event.needsReview).toBe(2);
    expect(later.reviewCleared).toBe(false);
    expect(await planForChange(t.db, later.event, later)).toBe(0);
    expect(await listUpcomingEvents(t.db)).toHaveLength(0);
  });

  it('검수 대기가 확신 높은 출처로 풀리면 그때 새 행사로 알린다', async () => {
    await merge();
    const later = await merge({ confidence: 0.95 }, false);
    expect(later.reviewCleared).toBe(true);
    expect(await planForChange(t.db, later.event, later)).toBe(1);
  });

  it('버튼이 안 되는 대체 임베드에는 안내 문구', () => {
    const msg = reviewMessage({ id: 1, title: 'x', kind: 'popup', officiality: 'licensed', region: 'KR', city: null, venue: null, startDate: null, endDate: null, ticketOpenAt: null, ticketUrl: null, status: 'announced', parentEventId: null, summaryKo: null, dedupKey: 'k', needsReview: 1, createdAt: '', updatedAt: '' }, []);
    expect(JSON.stringify(msg.embeds)).toContain('버튼을 쓸 수 없습니다');
  });
});

describe('서버 예약 이벤트', () => {
  const api = (over: Partial<GuildEventApi> = {}) => {
    let n = 0;
    return {
      canManageEvents: vi.fn(async () => true),
      createGuildEvent: vi.fn(async () => `ge-${++n}`),
      editGuildEvent: vi.fn(async () => {}),
      deleteGuildEvent: vi.fn(async () => {}),
      ...over,
    };
  };

  it('국내·확정·시작 전 행사만, 시작일 10시 ~ 종료일 21시(KST)', async () => {
    const e = (await merge({}, false)).event;
    const spec = guildEventSpec(e, 'https://popga.co.kr/popup/1', NOW)!;
    expect(spec).toMatchObject({ name: '하츠네 미쿠 팝업 in 홍대', location: 'AK플라자 홍대, 서울', startIso: '2026-12-10T01:00:00.000Z', endIso: '2026-12-24T12:00:00.000Z' });
    expect(spec.description).toContain('🔗 https://popga.co.kr/popup/1');
    expect(spec.imageUrl).toMatch(/region-kr\.png$/);
    expect(guildEventSpec({ ...e, region: 'JP' }, undefined, NOW)).toBeNull();
    expect(guildEventSpec({ ...e, needsReview: 1 }, undefined, NOW)).toBeNull();
    expect(guildEventSpec({ ...e, status: 'ongoing' }, undefined, NOW)).toBeNull();
    expect(guildEventSpec(e, undefined, new Date('2026-12-10T01:00:00Z'))).toBeNull();
  });

  it('만들고, 바뀌면 고치고, 취소되면 지운다. 서버에서 지워진 이벤트는 다음에 다시 만든다', async () => {
    const e = (await merge({}, false)).event;
    const a = api();
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ created: 0, updated: 0 });
    await t.db.update(events).set({ venue: 'AK플라자 홍대 2층' }).where(eq(events.id, e.id));
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ updated: 1 });
    expect(a.editGuildEvent).toHaveBeenCalledWith('ge-1', expect.objectContaining({ location: 'AK플라자 홍대 2층, 서울' }));

    const gone = api({ editGuildEvent: vi.fn(async () => Promise.reject(Object.assign(new Error('Unknown Guild Scheduled Event'), { code: 10070 }))) });
    await t.db.update(events).set({ venue: '다른 곳' }).where(eq(events.id, e.id));
    expect((await syncGuildEvents(t.db, gone, NOW)).errors).toEqual([]);
    expect((await t.db.select().from(eventDiscord))[0]!.guildEventId).toBeNull();
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ created: 1 });

    await t.db.update(events).set({ status: 'cancelled' }).where(eq(events.id, e.id));
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ deleted: 1 });
    expect(a.deleteGuildEvent).toHaveBeenCalledWith('ge-2');
  });

  it('권한이 없으면 건너뛰고, 해시는 내용이 같으면 같다', async () => {
    await merge({}, false);
    const a = api({ canManageEvents: vi.fn(async () => false) });
    expect(await syncGuildEvents(t.db, a, NOW)).toMatchObject({ noPermission: true, created: 0 });
    expect(a.createGuildEvent).not.toHaveBeenCalled();
    const s = { name: 'a', description: 'b', location: 'c', startIso: 'd', endIso: 'e' };
    expect(specHash(s)).toBe(specHash({ ...s, imageUrl: 'x' }));
  });
});

describe('이번 주 요약', () => {
  it('주 범위는 월~일 (KST)', () => {
    expect(weekRangeKst(NOW)).toEqual({ mon: '2026-11-23', sun: '2026-11-29', fromIso: '2026-11-22T15:00:00.000Z', toIso: '2026-11-29T15:00:00.000Z' });
    expect(weekRangeKst(new Date('2026-11-29T14:59:00Z')).mon).toBe('2026-11-23'); // 일요일 23:59 KST
  });

  it('이번 주 진행·티켓 오픈·새 행사 묶음, 없으면 보내지 않는다', async () => {
    expect(weeklyMessage(await weeklyData(t.db, NOW))).toBeNull();
    await merge({ title: '미쿠 콜라보 카페', kind: 'cafe', start_date: '2026-11-20', end_date: '2026-11-26' }, false);
    await merge({ title: 'MIKU EXPO 2027 KOREA', kind: 'concert', start_date: '2027-03-06', end_date: '2027-03-07', ticket_open_at: '2026-11-25T11:00:00.000Z', city: '서울', venue: '올림픽홀' }, false);
    await merge({ title: '검수 대기 행사', start_date: '2026-11-24', end_date: '2026-11-24' }, true);
    const d = await weeklyData(t.db, NOW);
    expect(d.happening.map((e) => e.title)).toEqual(['미쿠 콜라보 카페']);
    expect(d.ticketOpens.map((e) => e.title)).toEqual(['MIKU EXPO 2027 KOREA']);
    expect(d.added).toHaveLength(2);
    const msg = weeklyMessage(d)!;
    const s = text(msg.card!);
    expect(s).toContain('## 🗓️ 이번 주 미쿠 행사\n-# 11.23(월) ~ 11.29(일) · 한국 시간');
    expect(s).toContain('### 🎪 이번 주에 열려요 · 1');
    expect(s).toContain('⏰ 2026.11.25(수) 20:00 · <t:');
    expect(s).not.toContain('검수 대기 행사');
  });

  it('같은 주에는 한 번만 보낸다 (재시작해도)', async () => {
    await merge({ start_date: '2026-11-24', end_date: '2026-11-24' }, false);
    const sendNotice = vi.fn(async () => 'bot' as const);
    const jobs = (owner: number) =>
      createDiscordJobs({ db: t.db, bot: () => undefined, notifier: { sendNotice, alerter: { alert: async () => {} } } as Notifier, alerter: { alert: async () => {} }, now: () => NOW, log: { log: () => {}, warn: () => {}, error: () => {} } }).weekly();
    expect(await jobs(1)).toBe(true);
    expect(await jobs(2)).toBe(false);
    expect(sendNotice).toHaveBeenCalledTimes(1);
  });
});

describe('멘션 질문 답변', () => {
  it('확정 행사(다가오는 것 + 최근 60일 안에 끝난 것)만 넣는다', async () => {
    await merge({ title: '다가오는 팝업' }, false);
    await merge({ title: '검수 대기 팝업' }, true);
    await merge({ title: '최근 끝난 카페', kind: 'cafe', start_date: '2026-11-01', end_date: '2026-11-10' }, false);
    await merge({ title: '오래전 공연', kind: 'concert', start_date: '2025-11-29', end_date: '2025-11-30' }, false);
    expect((await qaEvents(t.db, NOW)).map((e) => e.title).sort()).toEqual(['다가오는 팝업', '최근 끝난 카페']);
  });

  it('Claude에 오늘 날짜와 행사 목록을 넘기고 비용을 기록한다', async () => {
    await merge({ title: '다가오는 팝업' }, false);
    const create = vi.fn(async (_req: unknown) => ({ content: [{ type: 'text', text: '- **다가오는 팝업** · 12.10~12.24 · AK플라자 홍대' }], usage: { input_tokens: 800, output_tokens: 60 } }));
    const qa = createQaAnswerer(t.db, 'k', { messages: { create } } as unknown as Anthropic, () => NOW);
    expect(await qa.answer('이번 달 국내 미쿠 행사 뭐 있어?')).toContain('다가오는 팝업');
    const req = create.mock.calls[0]![0] as { system: string; messages: { content: string }[]; model: string };
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.system).toContain('오늘은 2026-11-23');
    expect(req.messages[0]!.content).toContain('- 다가오는 팝업 | 지역 국내(서울) | 장소 AK플라자 홍대 | 기간 2026-12-10~2026-12-24');
    expect(req.messages[0]!.content).toContain('[질문]\n이번 달 국내 미쿠 행사 뭐 있어?');
    const [call] = await t.db.select().from(llmCalls).where(isNull(llmCalls.rawItemId));
    expect(call).toMatchObject({ model: 'claude-haiku-5-5', inputTokens: 800, outputTokens: 60 });
    expect(qaSystemPrompt(NOW)).toContain('지어내지 않는다');
  });
});
