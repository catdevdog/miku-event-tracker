import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { createNaverAdapter, cleanText, itemDate, nextKstMidnight, NaverApiError, NAVER_HOST, type NaverState } from '../src/adapters/naver.js';
import { AlertNowError, type AdapterContext } from '../src/adapters/types.js';
import { naverReadableUrl } from '../src/pipeline/pageText.js';
import { purgeExpiredItems } from '../src/pipeline/purge.js';
import { seedDatabase } from '../src/db/seed.js';
import { eventSources, eventStateLog, events, jobRuns, llmCalls, rawItems, sources } from '../src/db/schema.js';
import { runSource } from '../src/scheduler/runner.js';
import { fakeSource, fixture } from './fixtures.js';
import { makeTestDb } from './helpers.js';

const NOW = new Date('2026-11-22T16:30:00Z'); // 한국 2026-11-23 01:30
const KIND_OF = (url: URL) => url.pathname.split('/').pop() as 'news' | 'blog' | 'cafearticle';

/** 경로별 fixture를 돌려주는 가짜 fetch. 요청(URL·헤더)을 기록한다. */
function fakeApi(handler?: (url: URL) => Response | undefined) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const custom = handler?.(url);
    if (custom) return custom;
    return new Response(fixture(`naver/${KIND_OF(url)}.json`), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const CONFIG = { queries: ['하츠네 미쿠'], request_delay_ms: 0 };
const ctx = (state: NaverState = {}, now = NOW, config: Record<string, unknown> = CONFIG): AdapterContext => ({ now, state, config });
const keys = { clientId: 'id-test', clientSecret: 'secret-test' };

describe('네이버 검색 응답 정리', () => {
  it('<b> 태그와 HTML 엔티티를 지운다', () => {
    expect(cleanText('&quot;<b>하츠네 미쿠</b>&quot; 3D 무대 &amp; 팝업')).toBe('"하츠네 미쿠" 3D 무대 & 팝업');
  });

  it('작성 시각: 뉴스 pubDate, 블로그 postdate(KST 자정), 카페글 없음', () => {
    expect(itemDate('news', { title: '', link: 'x', description: '', pubDate: 'Sun, 22 Nov 2026 18:30:00 +0900' })).toBe('2026-11-22T09:30:00.000Z');
    expect(itemDate('blog', { title: '', link: 'x', description: '', postdate: '20261122' })).toBe('2026-11-21T15:00:00.000Z');
    expect(itemDate('cafearticle', { title: '', link: 'x', description: '' })).toBeUndefined();
  });

  it('다음 날 0시(KST)', () => {
    expect(nextKstMidnight(new Date('2026-11-22T16:30:00Z'))).toBe('2026-11-23T15:00:00.000Z');
    expect(nextKstMidnight(new Date('2026-11-22T14:59:00Z'))).toBe('2026-11-22T15:00:00.000Z');
  });

  it('블로그 link는 본문이 있는 PostView 주소로 바꾼다', () => {
    expect(naverReadableUrl('https://blog.naver.com/mikufan39/224000000001')).toBe('https://blog.naver.com/PostView.naver?blogId=mikufan39&logNo=224000000001');
    expect(naverReadableUrl('https://m.blog.naver.com/mikufan39/224000000001')).toBe('https://blog.naver.com/PostView.naver?blogId=mikufan39&logNo=224000000001');
    expect(naverReadableUrl('https://n.news.naver.com/mnews/article/003/0000001001')).toBe('https://n.news.naver.com/mnews/article/003/0000001001');
  });
});

describe('네이버 검색 어댑터', () => {
  it('HTTPS 호스트·인증 헤더·최신순 100건으로 부르고, 첫 실행은 최근 14일 글만 낸다(카페글은 기준점만)', async () => {
    const api = fakeApi();
    const r = await createNaverAdapter({ ...keys, fetchImpl: api.impl }).run(fakeSource({ adapter: 'naver' }), ctx());
    expect(api.calls).toHaveLength(3); // 종류 3개 × 검색어 1개, 첫 실행은 첫 페이지만
    const first = api.calls[0]!;
    expect(first.url.origin).toBe(NAVER_HOST);
    expect(first.url.pathname).toBe('/search/v1/news');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({ query: '하츠네 미쿠', display: '100', start: '1', sort: 'date', format: 'json' });
    expect(first.headers).toMatchObject({ 'X-NCP-APIGW-API-KEY-ID': 'id-test', 'X-NCP-APIGW-API-KEY': 'secret-test' });

    expect(r.items.map((i) => i.externalId)).toEqual([
      'https://n.news.naver.com/mnews/article/003/0000001001',
      'https://www.example-news.co.kr/news/articleView.html?idxno=1000',
      'https://blog.naver.com/mikufan39/224000000001',
    ]);
    const item = r.items[0]!;
    expect(item.title).toBe('"하츠네 미쿠" 3D 무대, 원더리벳 2026서 국내 첫선');
    expect(item.body).toContain('킨텍스 제2전시장 & WONDER STAGE');
    expect(item.publishedAt).toBe('2026-11-22T09:30:00.000Z');
    expect(item.purgeAfter).toBe('2026-12-12T16:30:00.000Z'); // 수집 + 20일
    const state = r.state as NaverState;
    expect(Object.keys(state.combos!)).toEqual(['news:하츠네 미쿠', 'blog:하츠네 미쿠', 'cafearticle:하츠네 미쿠']);
    expect(state.combos!['cafearticle:하츠네 미쿠']!.seen).toEqual(['https://cafe.naver.com/vocaloidkr/123456']);
  });

  it('다음 실행은 본 글이 나오면 멈추고 새 글만 낸다 (날짜 없는 카페글 포함)', async () => {
    const adapter = createNaverAdapter({ ...keys, fetchImpl: fakeApi().impl });
    const first = await adapter.run(fakeSource(), ctx());
    const newer = (kind: string) => ({
      lastBuildDate: '', total: 50, start: 1, display: 100,
      items: [
        { title: `새 글 ${kind}`, link: `https://example.com/${kind}/new`, description: '<b>하츠네 미쿠</b>', pubDate: 'Mon, 23 Nov 2026 01:00:00 +0900', postdate: '20261123' },
        ...JSON.parse(fixture(`naver/${kind}.json`)).items,
      ],
    });
    const api = fakeApi((url) => new Response(JSON.stringify(newer(KIND_OF(url))), { status: 200 }));
    const second = await createNaverAdapter({ ...keys, fetchImpl: api.impl }).run(fakeSource(), ctx(first.state as NaverState));
    expect(api.calls).toHaveLength(3);
    expect(second.items.map((i) => i.externalId)).toEqual(['https://example.com/news/new', 'https://example.com/blog/new', 'https://example.com/cafearticle/new']);
    expect((second.state as NaverState).combos!['news:하츠네 미쿠']!.seen[0]).toBe('https://example.com/news/new');
  });

  it('한 페이지가 모두 새 글이면 다음 페이지(start=101…)를 본다', async () => {
    const seenLink = 'https://example.com/old';
    const page = (start: number) => ({
      total: 1000, start, display: 100,
      items: start === 1
        ? Array.from({ length: 100 }, (_, i) => ({ title: `글 ${i}`, link: `https://example.com/p1/${i}`, description: '', pubDate: 'Mon, 23 Nov 2026 01:00:00 +0900' }))
        : [{ title: '새 글', link: 'https://example.com/p2/0', description: '', pubDate: 'Mon, 23 Nov 2026 00:00:00 +0900' }, { title: '본 글', link: seenLink, description: '' }],
    });
    const api = fakeApi((url) => new Response(JSON.stringify(page(Number(url.searchParams.get('start')))), { status: 200 }));
    const state: NaverState = { combos: { 'news:하츠네 미쿠': { seen: [seenLink] } } };
    const r = await createNaverAdapter({ ...keys, fetchImpl: api.impl }).run(fakeSource(), ctx(state, NOW, { ...CONFIG, endpoints: { news: '/search/v1/news' } }));
    const newsCalls = api.calls.filter((c) => c.url.pathname.endsWith('/news'));
    expect(newsCalls.map((c) => c.url.searchParams.get('start'))).toEqual(['1', '101']);
    expect(r.items).toHaveLength(101);
  });

  it('429면 모은 글과 상태를 저장하고 다음 날 0시(KST)까지 건너뛴다', async () => {
    const api = fakeApi((url) => (KIND_OF(url) === 'blog' ? new Response('{"error":{"errorCode":"429","message":"호출 한도 초과"}}', { status: 429 }) : undefined));
    const r = await createNaverAdapter({ ...keys, fetchImpl: api.impl }).run(fakeSource(), ctx());
    expect(r.items).toHaveLength(2); // 뉴스까지
    const state = r.state as NaverState;
    expect(state.blocked_until).toBe('2026-11-23T15:00:00.000Z');
    expect(Object.keys(state.combos!)).toEqual(['news:하츠네 미쿠']);
    expect(r.notes![0]).toContain('하루 호출 한도');

    const api2 = fakeApi();
    const skipped = await createNaverAdapter({ ...keys, fetchImpl: api2.impl }).run(fakeSource(), ctx(state, new Date('2026-11-23T14:59:00Z')));
    expect(skipped).toEqual({ items: [] });
    expect(api2.calls).toHaveLength(0);
    await createNaverAdapter({ ...keys, fetchImpl: api2.impl }).run(fakeSource(), ctx(state, new Date('2026-11-23T15:00:00Z')));
    expect(api2.calls.length).toBeGreaterThan(0);
  });

  it('401·400·403·404는 바로 알리는 오류, 500은 일반 실패, 키가 없으면 실패', async () => {
    const err = (status: number, body: string) => createNaverAdapter({ ...keys, fetchImpl: fakeApi(() => new Response(body, { status })).impl }).run(fakeSource(), ctx());
    await expect(err(401, '{"error":{"errorCode":"401","message":"인증 실패"}}')).rejects.toBeInstanceOf(AlertNowError);
    await expect(err(400, '{"errorCode":"SE02","errorMessage":"Invalid display value"}')).rejects.toThrow(/SE02/);
    const e500 = await err(500, '{"errorCode":"SE99","errorMessage":"System Error"}').catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(NaverApiError);
    expect(e500).not.toBeInstanceOf(AlertNowError);
    await expect(createNaverAdapter({}).run(fakeSource(), ctx())).rejects.toThrow(/NAVER_CLIENT_ID/);
  });
});

describe('네이버 원문 보관 기한·러너 경보', () => {
  let t: Awaited<ReturnType<typeof makeTestDb>>;
  beforeEach(async () => {
    t = await makeTestDb();
    await seedDatabase(t.db);
  });
  afterEach(() => t.cleanup());

  it('purge_after가 지난 원문을 지우고, 연결은 정리하되 행사와 비용 기록은 남긴다', async () => {
    const [naver] = await t.db.select().from(sources).where(eq(sources.adapter, 'naver'));
    const [old] = await t.db.insert(rawItems).values({ sourceId: naver!.id, externalId: 'old', contentHash: 'h', purgeAfter: '2026-11-22T00:00:00.000Z' }).returning();
    await t.db.insert(rawItems).values({ sourceId: naver!.id, externalId: 'fresh', contentHash: 'h', purgeAfter: '2026-12-12T00:00:00.000Z' });
    await t.db.insert(rawItems).values({ sourceId: naver!.id, externalId: 'keep', contentHash: 'h' });
    const [ev] = await t.db.insert(events).values({ title: '미쿠 팝업', kind: 'popup', officiality: 'licensed', region: 'KR', dedupKey: 'k' }).returning();
    await t.db.insert(eventSources).values({ eventId: ev!.id, rawItemId: old!.id, extracted: '{}' });
    await t.db.insert(eventStateLog).values({ eventId: ev!.id, toStatus: 'announced', rawItemId: old!.id });
    await t.db.insert(llmCalls).values({ rawItemId: old!.id, model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.001 });

    expect(await purgeExpiredItems(t.db, new Date('2026-11-23T00:00:00Z'))).toBe(1);
    expect((await t.db.select().from(rawItems)).map((r) => r.externalId).sort()).toEqual(['fresh', 'keep']);
    expect(await t.db.select().from(eventSources)).toHaveLength(0);
    expect(await t.db.select().from(events)).toHaveLength(1);
    expect(await t.db.select().from(llmCalls).where(isNull(llmCalls.rawItemId))).toHaveLength(1);
    expect(await t.db.select().from(eventStateLog).where(isNull(eventStateLog.rawItemId))).toHaveLength(1);
  });

  it('바로 알리는 오류는 첫 실패에서 경보한다', async () => {
    const [naver] = await t.db.select().from(sources).where(eq(sources.adapter, 'naver'));
    const messages: string[] = [];
    const deps = {
      db: t.db,
      adapters: { naver: { run: async () => Promise.reject(new AlertNowError('네이버 검색 API 오류 (HTTP 401 401) 인증 실패')) } },
      alerter: { alert: async (m: string) => void messages.push(m) },
      owner: 'test',
    };
    expect(await runSource(deps, naver!)).toBe('error');
    expect(messages).toEqual(['수집 오류: 네이버 검색 (뉴스·블로그·카페)\n네이버 검색 API 오류 (HTTP 401 401) 인증 실패']);
    const [run] = await t.db.select().from(jobRuns);
    expect(run!.status).toBe('error');
  });
});
