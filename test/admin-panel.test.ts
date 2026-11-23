import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { events, jobRuns, keywords, rawItems, sources } from '../src/db/schema.js';
import { mergeExtraction } from '../src/pipeline/merge.js';
import type { Extraction } from '../src/pipeline/extract.js';
import { ensureDefaultSubscriber } from '../src/notify/planner.js';
import { createInteractionHandlers } from '../src/notify/interactions.js';
import { isAdminPanelId, panelSources } from '../src/notify/adminPanel.js';
import { statusBoardData, statusBoardMessage } from '../src/notify/statusBoard.js';
import { isNotifyPaused } from '../src/services/settings.js';
import type { ButtonResult } from '../src/notify/discord.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
  await ensureDefaultSubscriber(t.db, { noticeChannelId: '1', hasWebhook: false });
});
afterEach(() => t.cleanup());

const NOW = new Date('2026-11-23T03:00:00Z');
const base: Extraction = {
  is_relevant: true, title: '하츠네 미쿠 심포니 2027 in 서울', kind: 'concert', officiality: 'crypton', region: 'KR', city: '서울', venue: '롯데콘서트홀',
  start_date: '2027-02-06', end_date: '2027-02-07', ticket_open_at: null, ticket_url: null, is_cancelled: false, sale_started: null,
  parent_event_hint: null, summary_ko: '요약', confidence: 0.9,
};
async function merge(over: Partial<Extraction> = {}) {
  const [s] = await t.db.select().from(sources).where(eq(sources.name, '팝가 (팝업 모음)'));
  const [item] = await t.db.insert(rawItems).values({ sourceId: s!.id, externalId: `x-${Math.random()}`, url: 'https://piapro.net/n', contentHash: 'h' }).returning();
  return (await mergeExtraction(t.db, { ...base, ...over }, { rawItemId: item!.id, model: 'm', needsReview: false, fromKopis: false, now: NOW })).event;
}
const admin = { userId: 'u-admin', isAdmin: true, memberRoleIds: [] as string[] };
const user = { userId: 'u-1', isAdmin: false, memberRoleIds: [] as string[] };
const handlers = (over: Record<string, unknown> = {}) =>
  createInteractionHandlers({ db: t.db, bot: () => undefined, notifier: { sendNotice: vi.fn(), alerter: { alert: vi.fn() } } as never, uptimeSec: () => 0, now: () => NOW, ...over });
const text = (r: ButtonResult | string) => JSON.stringify(r);
/** 카드 안의 custom_id 전부 */
const ids = (r: ButtonResult) => [...text(r).matchAll(/"custom_id":"([^"]+)"/g)].map((m) => m[1]!);

/** 디스코드 제한: 한 줄에 버튼 5개·선택 메뉴 1개, 선택지 25개, 라벨 100자, custom_id 100자 */
function assertValid(r: ButtonResult) {
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.type === 1) {
      const kids = o.components as { type: number }[];
      expect(kids.length).toBeLessThanOrEqual(5);
      if (kids.some((k) => k.type === 3)) expect(kids).toHaveLength(1);
    }
    if (o.type === 3) {
      const options = o.options as { label: string; description?: string }[];
      expect(options.length).toBeGreaterThan(0);
      expect(options.length).toBeLessThanOrEqual(25);
      for (const op of options) {
        expect(op.label.length).toBeLessThanOrEqual(100);
        expect((op.description ?? '').length).toBeLessThanOrEqual(100);
      }
      expect(String(o.placeholder ?? '').length).toBeLessThanOrEqual(150);
    }
    if (typeof o.custom_id === 'string') expect(o.custom_id.length).toBeLessThanOrEqual(100);
    Object.values(o).forEach(walk);
  };
  walk(r);
}

describe('관리 패널', () => {
  it('상태판에 패널 버튼 두 줄이 붙고, 알림 상태에 따라 문구가 바뀐다', async () => {
    const msg = statusBoardMessage(await statusBoardData(t.db, NOW));
    expect(ids(msg)).toEqual(['ad:src', 'ad:evt', 'ad:kw', 'ad:pause', 'ad:setup', 'ad:dup', 'ad:cal', 'ad:diag', 'ad:refresh']);
    expect(text(msg)).toContain('⏸️ 알림 일시정지');
    assertValid(msg);
    expect(isAdminPanelId('ad:src')).toBe(true);
    expect(isAdminPanelId('rv:ok:1')).toBe(false);
  });

  it('관리자가 아니면 버튼·선택·입력 창 모두 거절', async () => {
    const h = handlers();
    expect(await h.onButton!('ad:src', user)).toEqual({ reply: expect.stringContaining('관리자') });
    expect(await h.onSelect!('ad:srcsel:0', ['1'], user)).toEqual({ reply: expect.stringContaining('관리자') });
    expect(await h.onModal!('ad:kwadd', { term: '테스트', tier: '강' }, user)).toContain('관리자');
    expect(await isNotifyPaused(t.db)).toBe(false);
    expect(await h.onSelect!('other', ['1'], admin)).toBeNull();
  });

  it('수집처: 목록(문제 있는 곳 먼저, 25개씩) → 고르기 → 멈춤·재개·지금 수집', async () => {
    const h = handlers();
    const [popga] = await t.db.select().from(sources).where(eq(sources.name, '팝가 (팝업 모음)'));
    await t.db.update(sources).set({ consecutiveFailures: 3 }).where(eq(sources.id, popga!.id));
    await t.db.insert(jobRuns).values({ sourceId: popga!.id, startedAt: NOW.toISOString(), status: 'error', error: 'HTTP 503' });
    expect((await panelSources(t.db))[0]!.id).toBe(popga!.id);
    const list = await h.onButton!('ad:src', admin);
    expect(ids(list)).toEqual(['ad:srcsel:0', 'ad:srcsel:1']); // 켜진 수집처 33곳
    assertValid(list);
    const one = await h.onSelect!('ad:srcsel:0', [String(popga!.id)], admin);
    expect(text(one)).toContain('경보 (연속 실패 3회)');
    expect(text(one)).toContain('HTTP 503');
    expect(ids(one)).toEqual([`ad:sa:pause:${popga!.id}`, `ad:sa:run:${popga!.id}`, 'ad:src']);
    const paused = await h.onButton!(`ad:sa:pause:${popga!.id}`, admin);
    expect(text(paused)).toContain('수집을 멈췄어요');
    expect(ids(paused)[0]).toBe(`ad:sa:resume:${popga!.id}`);
    expect((await t.db.select().from(sources).where(eq(sources.id, popga!.id)))[0]!.paused).toBe(1);
    expect(text(await h.onButton!(`ad:sa:resume:${popga!.id}`, admin))).toContain('다시 시작');
  });

  it('행사: 목록 → 상세 + 관리 버튼 → 유형 변경·숨기기·수정 창', async () => {
    const e = await merge();
    const h = handlers();
    const list = await h.onButton!('ad:evt', admin);
    expect(ids(list)).toEqual(['ad:evtsel', 'ad:evtfind', 'ad:evt']);
    assertValid(list);
    const view = await h.onSelect!('ad:evtsel', [String(e.id)], admin);
    expect(text(view)).toContain('하츠네 미쿠 심포니 2027 in 서울');
    expect(ids(view).filter((i) => i.startsWith('ad:'))).toEqual([`ad:ee:${e.id}`, `ad:ek:${e.id}`, `ad:eh:hide:${e.id}`, `ad:em:${e.id}`, 'ad:evt']);
    assertValid(view);
    expect(await h.onButton!(`ad:ee:${e.id}`, admin)).toMatchObject({ modal: { customId: `ed:${e.id}` } });
    const kinds = await h.onButton!(`ad:ek:${e.id}`, admin);
    assertValid(kinds);
    expect(text(await h.onSelect!(`ad:eksel:${e.id}`, ['live_viewing'], admin))).toContain('🎤 공연 → 🎬 상영·라이브뷰잉');
    const hidden = await h.onButton!(`ad:eh:hide:${e.id}`, admin);
    expect(text(hidden)).toContain('숨겼어요');
    expect(ids(hidden)).toContain(`ad:eh:show:${e.id}`);
    expect((await t.db.select().from(events).where(eq(events.id, e.id)))[0]).toMatchObject({ needsReview: 2, kind: 'live_viewing' });
    // 이름으로 찾기: 한 건이면 바로 상세, 없으면 안내
    expect(await h.onButton!('ad:evtfind', admin)).toMatchObject({ modal: { customId: 'ad:evtfind' } });
    expect(text(await h.onModal!('ad:evtfind', { q: '심포니' }, admin))).toContain(`ad:ee:${e.id}`);
    expect(text(await h.onModal!('ad:evtfind', { q: '없는행사' }, admin))).toContain('찾는 행사가 없어요');
  });

  it('합치기: 비슷한 행사가 위에 → 확인 → 합침', async () => {
    const keep = await merge();
    const dup = await merge({ title: '하츠네 미쿠 심포니 서울 공연', venue: 'Lotte Hall', start_date: '2027-03-01', end_date: '2027-03-01' });
    await merge({ title: '전혀 다른 팝업', kind: 'popup', venue: '부산', start_date: '2027-06-01', end_date: '2027-06-03' });
    const h = handlers();
    const pick = await h.onButton!(`ad:em:${keep.id}`, admin);
    assertValid(pick);
    const first = /"options":\[\{"label":"([^"]+)","value":"(\d+)"/.exec(text(pick))!;
    expect(Number(first[2])).toBe(dup.id);
    const confirm = await h.onSelect!(`ad:emsel:${keep.id}`, [String(dup.id)], admin);
    expect(ids(confirm)).toEqual([`ad:emok:${keep.id}:${dup.id}`, `ad:ev:${keep.id}`]);
    expect((await t.db.select().from(events).where(eq(events.id, dup.id)))[0]!.mergedInto).toBeNull(); // 아직 안 합침
    expect(text(await h.onButton!(`ad:emok:${keep.id}:${dup.id}`, admin))).toContain('합쳤어요');
    expect((await t.db.select().from(events).where(eq(events.id, dup.id)))[0]!.mergedInto).toBe(keep.id);
  });

  it('키워드: 목록 → 추가(입력 창) → 삭제(선택 메뉴)', async () => {
    const h = handlers();
    const list = await h.onButton!('ad:kw', admin);
    expect(ids(list)).toEqual(['ad:kwadd', 'ad:kwdel']);
    expect(await h.onButton!('ad:kwadd', admin)).toMatchObject({ modal: { customId: 'ad:kwadd' } });
    expect(text(await h.onModal!('ad:kwadd', { term: '원더리벳', tier: '약' }, admin))).toContain('원더리벳');
    expect((await t.db.select().from(keywords).where(eq(keywords.term, '원더리벳')))[0]!.tier).toBe('weak');
    expect(text(await h.onModal!('ad:kwadd', { term: '테스트', tier: '최강' }, admin))).toContain('등급은 강 / 약 / 맥락 / 제외');
    const del = await h.onButton!('ad:kwdel', admin);
    assertValid(del);
    expect(ids(del).filter((i) => i.startsWith('ad:kwdelsel'))).toHaveLength(3); // 56개 → 25개씩
    const [kw] = await t.db.select().from(keywords).where(eq(keywords.term, '원더리벳'));
    expect(text(await h.onSelect!('ad:kwdelsel:0', [String(kw!.id)], admin))).toContain('뺐어요');
    expect((await t.db.select().from(keywords).where(eq(keywords.id, kw!.id)))[0]!.disabled).toBe(1);
  });

  it('바로 실행 버튼: 알림 일시정지 토글(패널 갱신), 중복검사, 달력, 설정, 점검, 새로고침', async () => {
    const refreshBoard = vi.fn(async () => 'edited');
    const h = handlers({
      refreshBoard,
      dupSweep: async () => ({ checked: 2, flagged: 1, more: false }),
      postCalendar: async () => '🗓️ 올렸어요',
      setupNow: async () => ({ members: { added: 1, initialized: 1, failed: 0 }, missing: [], errors: [] }),
    });
    expect(await h.onButton!('ad:pause', admin)).toEqual({ reply: expect.stringContaining('일시정지 중') });
    expect(await isNotifyPaused(t.db)).toBe(true);
    expect(refreshBoard).toHaveBeenCalledTimes(1);
    expect(text(await h.onButton!('ad:refresh', admin))).toContain('▶️ 알림 재개');
    expect(await h.onButton!('ad:pause', admin)).toEqual({ reply: expect.stringContaining('보내고 있어요') });
    expect(await h.onButton!('ad:dup', admin)).toEqual({ reply: expect.stringContaining('의심되는 쌍: **1건**') });
    expect(await h.onButton!('ad:cal', admin)).toEqual({ reply: '🗓️ 올렸어요' });
    expect(await h.onButton!('ad:setup', admin)).toEqual({ reply: expect.stringContaining('1명에게 줬어요') });
    expect(text(await h.onButton!('ad:diag', admin))).toContain('행사 현황');
  });
});
