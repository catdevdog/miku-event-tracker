import { describe, expect, it, vi } from 'vitest';
import type { EventRow } from '../src/pipeline/merge.js';
import { calendarLink, diagnosticsCard, eventsCard, noticeCard, parseEventsPageId, recentCard, sourcesCard, type Card } from '../src/notify/cards.js';
import { headline } from '../src/notify/planner.js';
import { sendWithFallback } from '../src/notify/discord.js';
import type { SourceStatusRow } from '../src/services/sources.js';

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  title: 'HATSUNE MIKU EXPO 2027 KOREA',
  kind: 'concert',
  officiality: 'crypton',
  region: 'KR',
  city: '서울',
  venue: '올림픽홀',
  startDate: '2027-03-06',
  endDate: '2027-03-07',
  ticketOpenAt: '2026-12-01T11:00:00.000Z',
  ticketUrl: 'https://ticket.melon.com/performance/index.htm?prodId=1',
  status: 'ticket_scheduled',
  parentEventId: null,
  summaryKo: '서울에서 미쿠 엑스포가 열린다.',
  dedupKey: 'k',
  needsReview: 0,
  mergedInto: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

type Node = { type: number; components?: Node[]; accessory?: Node; content?: string; custom_id?: string; label?: string; url?: string; disabled?: boolean; accent_color?: number; items?: { media: { url: string } }[] };
/** 디스코드는 중첩까지 포함해 컴포넌트 40개, 글자 4000자까지 받는다 */
function count(nodes: Node[]): { components: number; chars: number } {
  let components = 0;
  let chars = 0;
  const walk = (n: Node) => {
    components++;
    chars += n.content?.length ?? 0;
    n.components?.forEach(walk);
    if (n.accessory) walk(n.accessory);
  };
  nodes.forEach(walk);
  return { components, chars };
}
const flat = (card: Card) => {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    n.components?.forEach(walk);
    if (n.accessory) walk(n.accessory);
  };
  (card as unknown as Node[]).forEach(walk);
  return out;
};
const withinLimits = (card: Card) => {
  const c = count(card as unknown as Node[]);
  expect(c.components).toBeLessThanOrEqual(40);
  expect(c.chars).toBeLessThanOrEqual(4000);
};

describe('공지 카드', () => {
  it('머리말·제목 링크·요약·일정·지역 이미지·버튼(예매·원문·캘린더)', () => {
    const card = noticeCard(ev(), headline('reminder', 'ticket_scheduled', 'T-1h'), ['https://x.com/cfm_miku/status/1']);
    withinLimits(card);
    const nodes = flat(card);
    expect(nodes[0]!.type).toBe(17);
    expect(nodes[0]!.accent_color).toBe(0xff6b35);
    const text = nodes.map((n) => n.content ?? '').join('\n');
    expect(text).toContain('-# ⏰ 티켓 오픈 1시간 전　·　🇰🇷 국내 · 공연 · 크립톤 공식');
    expect(text).toContain('## [HATSUNE MIKU EXPO 2027 KOREA](https://ticket.melon.com/performance/index.htm?prodId=1)');
    expect(text).toContain('> 서울에서 미쿠 엑스포가 열린다.');
    expect(text).toContain('🎫 **티켓 오픈**　2026.12.01(화) 20:00 KST · <t:1796122800:R>');
    expect(nodes.find((n) => n.type === 12)!.items![0]!.media.url).toMatch(/region-kr\.png$/);
    expect(nodes.filter((n) => n.type === 2).map((b) => b.label)).toEqual(['🎫 예매하기', '📰 원문 보기', '📅 티켓 오픈 캘린더에 추가', '🔔 알림 받기']);
    expect(nodes.find((n) => n.label === '🔔 알림 받기')?.custom_id).toBe('wt:1');
  });

  it('링크가 없으면 알림 받기 버튼만, 마크다운 기호는 이스케이프', () => {
    const card = noticeCard(ev({ ticketUrl: null, ticketOpenAt: null, startDate: null, endDate: null, title: '*미쿠* [팝업]', status: 'announced' }), headline('new', 'announced', ''), []);
    const nodes = flat(card);
    expect(nodes.filter((n) => n.type === 2).map((b) => b.label)).toEqual(['🔔 알림 받기']);
    expect(flat(noticeCard(ev({ ticketUrl: null, ticketOpenAt: null, startDate: null, status: 'ended' }), headline('new', 'ended', ''), [])).some((n) => n.type === 1)).toBe(false);
    expect(nodes.map((n) => n.content ?? '').join('\n')).toContain('## \\*미쿠\\* ［팝업］');
  });

  it('캘린더 링크: 예매 예정은 티켓 오픈 30분, 그 외는 행사 기간(종일), 512자 이하', () => {
    const t = calendarLink(ev())!;
    expect(t.label).toBe('📅 티켓 오픈 캘린더에 추가');
    expect(new URL(t.url).searchParams.get('dates')).toBe('20261201T110000Z/20261201T113000Z');
    const d = calendarLink(ev({ status: 'announced' }))!;
    expect(new URL(d.url).searchParams.get('dates')).toBe('20270306/20270308');
    expect(new URL(d.url).searchParams.get('location')).toBe('올림픽홀, 서울');
    const long = calendarLink(ev({ status: 'announced', title: '미'.repeat(400) }), `https://example.com/${'a'.repeat(300)}`)!;
    expect(long.url.length).toBeLessThanOrEqual(512);
    expect(calendarLink(ev({ status: 'announced', startDate: null }))).toBeNull();
  });
});

describe('/행사 카드', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    ev({ id: i + 1, title: `행사 ${i + 1}`, region: i % 3 === 0 ? 'KR' : i % 3 === 1 ? 'JP' : 'OTHER', ticketUrl: i % 2 ? null : `https://t.example/${i}` }),
  );
  const links = new Map(rows.map((r) => [r.id, r.ticketUrl ?? `https://src.example/${r.id}`]));

  it('8건씩 지역 색 카드 + 예매·원문 버튼 + 페이지 버튼', () => {
    const card = eventsCard(rows, 'all', 0, links);
    withinLimits(card);
    const containers = (card as unknown as Node[]).filter((n) => n.type === 17);
    expect(containers).toHaveLength(8);
    expect(containers.map((c) => c.accent_color).slice(0, 3)).toEqual([0x39c5bb, 0xe8384f, 0x3b82f6]);
    const buttons = flat(card).filter((n) => n.type === 2);
    expect(buttons[0]!.label).toBe('🎫 예매');
    expect(buttons[1]!.label).toBe('🔗 원문');
    const nav = buttons.slice(-3);
    expect(nav.map((b) => [b.custom_id, b.disabled ?? false])).toEqual([
      ['ev:all:-1', true],
      ['ev:pos', true],
      ['ev:all:1', false],
    ]);
    expect(nav[1]!.label).toBe('1 / 3');
  });

  it('마지막 쪽과 범위 밖 쪽, 빈 목록', () => {
    const last = eventsCard(rows, 'domestic', 9, links);
    withinLimits(last);
    expect((last as unknown as Node[]).filter((n) => n.type === 17)).toHaveLength(4);
    expect(flat(last).filter((n) => n.type === 2).slice(-1)[0]).toMatchObject({ custom_id: 'ev:domestic:3', disabled: true });
    const firstText = flat(eventsCard(rows, 'all', 0, links)).find((n) => n.type === 10 && n.content!.startsWith('### '))!.content!;
    expect(firstText.split('\n').slice(1, 3)).toEqual(['📅 2027.03.06(토) ~ 03.07(일)', '📍 서울 · 올림픽홀']);
    const empty = eventsCard([], 'japan', 0, new Map());
    expect(flat(empty).map((n) => n.content ?? '').join('\n')).toContain('조건에 맞는 다가오는 행사가 없어요');
    expect(parseEventsPageId('ev:japan:2')).toEqual({ scope: 'japan', page: 2 });
    expect(parseEventsPageId('ev:pos')).toBeNull();
  });
});

describe('목록 카드', () => {
  const src = (name: string, over: Partial<SourceStatusRow>): SourceStatusRow => ({
    name, adapter: 'rss', enabled: true, paused: false, implemented: true, lastRunAt: null, lastSuccessAt: '2026-11-22T14:05:00.000Z', consecutiveFailures: 0, ...over,
  });

  it('/소스는 상태별 묶음 카드', () => {
    const card = sourcesCard([
      src('PR TIMES', {}),
      src('X @cfm_miku', { consecutiveFailures: 3 }),
      src('네이버 검색 (뉴스·블로그·카페)', { implemented: false }),
      src('NOL 티켓', { enabled: false }),
    ]);
    withinLimits(card);
    const text = flat(card).map((n) => n.content ?? '').join('\n');
    expect(text).toContain('### 🔴 경보 (3회 이상 연속 실패) · 1');
    expect(text).toContain('🟢 **PR TIMES** · 11-22 23:05');
    expect(text).toContain('🔧 **네이버 검색**');
    expect(text).toContain('⚫ **NOL 티켓**');
    expect(text).toContain('실제 수집 2/4곳 · 경보 1곳');
  });

  it('/최근수집은 판정 결과별 묶음, 제목은 원문 링크', () => {
    const card = recentCard([
      { source: '멜론티켓', title: '하츠네 미쿠 EXPO', url: 'https://ticket.melon.com/x', fetchedAt: '2026-11-22T14:05:00.000Z', keywordHit: 'strong', llmStatus: 'done' },
      { source: '팝가 (팝업 모음)', title: '코난 팝업', url: null, fetchedAt: '2026-11-22T14:06:00.000Z', keywordHit: 'none', llmStatus: 'skipped' },
    ]);
    const text = flat(card).map((n) => n.content ?? '').join('\n');
    expect(text).toContain('### ✅ Claude 판정 완료 · 1');
    expect(text).toContain('`11-22 23:05` **멜론티켓** · [하츠네 미쿠 EXPO](https://ticket.melon.com/x)');
    expect(text).toContain('`11-22 23:06` **팝가** · 코난 팝업');
  });

  it('/점검 카드', () => {
    const card = diagnosticsCard({
      regions: [
        { region: 'KR', upcoming: 0, ended: 1, cancelled: 0, needsReview: 0 },
        { region: 'JP', upcoming: 2, ended: 0, cancelled: 0, needsReview: 1 },
        { region: 'OTHER', upcoming: 0, ended: 0, cancelled: 0, needsReview: 0 },
      ],
      recentKr: [ev({ status: 'ended', startDate: '2025-11-29', endDate: '2025-11-30', title: 'HATSUNE MIKU EXPO 2025 in Seoul' })],
      krSources: [
        { name: '멜론티켓', adapter: 'ticket', schedulable: true, implemented: true, lastJobStatus: 'ok', consecutiveFailures: 0, lastSuccessAt: '2026-11-22T14:00:00.000Z', collected: 3, passed: 2, extracted: 1, linked: 1 },
        { name: '네이버 검색 (뉴스·블로그·카페)', adapter: 'naver', schedulable: true, implemented: false, lastJobStatus: 'skipped', consecutiveFailures: 0, lastSuccessAt: null, collected: 0, passed: 0, extracted: 0, linked: 0 },
      ],
      pendingItems: 4,
      errorItems: 0,
    });
    withinLimits(card);
    const text = flat(card).map((n) => n.content ?? '').join('\n');
    expect(text).toContain('🇰🇷 **국내**　다가옴 **0** · 종료 1 · 취소 0 · 검수 0');
    expect(text).toContain('✅ 종료 · 2025.11.29(토) ~ 11.30(일) · HATSUNE MIKU EXPO 2025 in Seoul');
    expect(text).toContain('### 🛰️ 국내 수집처 1/2곳 수집 중');
    expect(text).toContain('🟢 **멜론티켓** · 수집 3 · 통과 2 · 판정 1 · 행사 1');
    expect(text).toContain('🔧 **네이버 검색** · 수집기 구현 전');
    expect(text).toContain('전체 판정 대기 4건');
  });
});

describe('카드 발송 대체', () => {
  const msg = { card: noticeCard(ev(), headline('new', 'ticket_scheduled', ''), []), embeds: [{ title: 'x' }] };
  it('카드가 형식 오류(400)로 거부되면 임베드로 다시 보낸다', async () => {
    const plain = vi.fn(async () => {});
    const log = { warn: vi.fn() };
    const r = await sendWithFallback(msg, async () => { throw Object.assign(new Error('Invalid Form Body'), { status: 400 }); }, plain, log);
    expect(r).toBe('plain');
    expect(plain).toHaveBeenCalledWith({ content: undefined, embeds: [{ title: 'x' }], allowedMentions: { parse: [] } });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
  it('권한 오류 같은 다른 실패는 그대로 던진다(웹후크 대체는 notifier가 맡음)', async () => {
    await expect(sendWithFallback(msg, async () => { throw Object.assign(new Error('Missing Access'), { status: 403 }); }, async () => {})).rejects.toThrow('Missing Access');
  });
  it('카드가 없으면 바로 일반 메시지', async () => {
    const card = vi.fn(async () => {});
    expect(await sendWithFallback({ content: 'hi' }, card, async () => {})).toBe('plain');
    expect(card).not.toHaveBeenCalled();
  });
});
