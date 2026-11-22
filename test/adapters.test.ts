import { describe, expect, it } from 'vitest';
import { createRssAdapter } from '../src/adapters/rss.js';
import { createHtmlDiffAdapter, extractLinks, extractTextBlocks, jsonBlocks } from '../src/adapters/htmlDiff.js';
import { createTicketAdapter, parseKstDateTime, parseMelonSearch, parseMelonTicketOpen } from '../src/adapters/ticket.js';
import { buildWindows, createKopisAdapter, kopisDetailBody, parseKopisDetail, parseKopisList } from '../src/adapters/kopis.js';
import { createXCrawlAdapter, type TweetLike, type TweetSource } from '../src/adapters/xCrawl.js';
import { readSeedFiles } from '../src/db/seed.js';
import { fakeFetch, fakeSource, fixture } from './fixtures.js';

const ctx = (over: { state?: Record<string, unknown>; config?: Record<string, unknown>; now?: Date } = {}) => ({
  now: over.now ?? new Date('2026-11-22T12:00:00Z'),
  state: over.state ?? {},
  config: over.config ?? {},
});

describe('rss', () => {
  it('RSS 2.0: 첫 실행은 30일 이내 글만, 다음 실행은 새 글만', async () => {
    const f = fakeFetch([[/blog\.piapro/, fixture('rss/blog-piapro.xml')]]);
    const a = createRssAdapter(f);
    const src = fakeSource({ target: 'https://blog.piapro.net/feed' });
    const r1 = await a.run(src, ctx());
    expect(r1.items.map((i) => i.externalId)).toEqual([
      'https://blog.piapro.net/2026/11/hs2611201.html',
      'https://blog.piapro.net/2026/11/hm2611201.html',
      'https://blog.piapro.net/2026/11/mcs2026112001.html',
    ]);
    expect(r1.items[0]!.publishedAt).toBe('2026-11-20T09:30:57.000Z');
    expect(r1.items[0]!.body).toContain('雪ミク電車');
    const r2 = await a.run(src, ctx({ state: r1.state }));
    expect(r2.items).toEqual([]);
  });

  it('RSS 1.0(RDF): PR TIMES 기업 피드', async () => {
    const a = createRssAdapter(fakeFetch([[/prtimes/, fixture('rss/prtimes-52709.rdf')]]));
    const r = await a.run(fakeSource({ target: 'https://prtimes.jp/companyrdf.php?company_id=52709' }), ctx());
    expect(r.items).toHaveLength(3);
    expect(r.items[2]).toMatchObject({
      externalId: 'https://prtimes.jp/main/html/rd/p/000000730.000052709.html',
      title: '12月30日（水）都内で開催される大型クラブイベント「VIRAL」に、初音ミクが映像出演！',
      publishedAt: '2026-11-13T03:06:57.000Z',
    });
  });

  it('Atom: 유튜브 채널 피드', async () => {
    const a = createRssAdapter(fakeFetch([[/youtube/, fixture('rss/youtube-hatsunemiku.xml')]]));
    const r = await a.run(fakeSource({ target: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCJwGWV914kBlV4dKRn7AEFA' }), ctx());
    expect(r.items[0]).toMatchObject({ url: 'https://www.youtube.com/shorts/2rg8wNZZqpc', publishedAt: '2026-11-22T03:00:40.000Z' });
    expect(r.items[0]!.title).toContain('マジカルミライ 2026');
  });

  it('첫 실행에서 30일보다 오래된 글은 기준점으로만 남긴다', async () => {
    const a = createRssAdapter(fakeFetch([[/./, fixture('rss/blog-piapro.xml')]]));
    const r = await a.run(fakeSource(), ctx({ now: new Date('2027-02-01T00:00:00Z') }));
    expect(r.items).toEqual([]);
    expect((r.state as { seen: string[] }).seen).toHaveLength(3);
  });
});

describe('html_diff', () => {
  const html = fixture('html/mikuexpo.html');

  it('이미지·앵커·공유 링크를 빼고 절대 URL로 뽑는다 (이미지만 있는 링크는 alt 사용)', () => {
    const links = extractLinks(html, 'https://mikuexpo.com/', { selector: 'main' });
    expect(links).toEqual([
      { url: 'https://mikuexpo.com/europe2026/', text: 'HATSUNE MIKU EXPO 2026 EUROPE' },
      { url: 'https://mikuexpo.com/na2026/', text: 'HATSUNE MIKU EXPO 2026 North America Art by y' },
      { url: 'https://mikuexpo.com/asia2025/', text: 'HATSUNE MIKU EXPO 2025 ASIA Art by RITAO' },
      { url: 'https://mikuexpo.com/10th/', text: 'HATSUNE MIKU EXPO 10th Anniversary' },
    ]);
  });

  it('첫 실행은 기준점만 기록하고, 이후 새 링크만 항목으로 낸다', async () => {
    let page = html;
    const a = createHtmlDiffAdapter({ fetchText: fakeFetch([[/./, () => page]]) });
    const src = fakeSource({ adapter: 'html_diff', target: 'https://mikuexpo.com/' });
    const r1 = await a.run(src, ctx());
    expect(r1.items).toEqual([]);
    page = html.replace('<ul class="tour">', '<ul class="tour"><li><a href="/korea2027/">HATSUNE MIKU EXPO 2027 KOREA</a></li>');
    const r2 = await a.run(src, ctx({ state: r1.state }));
    expect(r2.items.map((i) => [i.externalId, i.title])).toEqual([['https://mikuexpo.com/korea2027/', 'HATSUNE MIKU EXPO 2027 KOREA']]);
  });

  it('연도별 페이지: 내년 페이지가 200이 되면 한 번만 알린다', async () => {
    const status = new Map([['https://magicalmirai.com/2026/', 200], ['https://magicalmirai.com/2027/', 404]]);
    const a = createHtmlDiffAdapter({
      fetchText: fakeFetch([[/./, '<body><a href="/2026/">2026</a></body>']]),
      fetchStatus: async (u) => status.get(u) ?? 404,
    });
    const src = fakeSource({ name: 'magicalmirai.com', adapter: 'html_diff', target: 'https://magicalmirai.com/' });
    const config = { year_paths: true, pattern: 'https://magicalmirai.com/{year}/' };
    const r1 = await a.run(src, ctx({ config }));
    expect(r1.items).toEqual([]);
    expect(r1.state).toMatchObject({ liveYears: [2026] });
    status.set('https://magicalmirai.com/2027/', 200);
    const r2 = await a.run(src, ctx({ config, state: r1.state }));
    expect(r2.items.map((i) => i.title)).toEqual(['magicalmirai.com 2027 페이지 공개']);
    const r3 = await a.run(src, ctx({ config, state: r2.state }));
    expect(r3.items).toEqual([]);
  });

  it('text 모드: 링크 없는 사이트는 새 문단을 항목으로 낸다', async () => {
    let page = '<body><h2>EXHIBITION</h2><p>POP-UP SHOP in HMV&amp;BOOKS 2026 なんば 11月27日</p></body>';
    const a = createHtmlDiffAdapter({ renderHtml: async () => page });
    const src = fakeSource({ adapter: 'html_diff', target: 'https://artofmiku.com/' });
    const config = { render: true, mode: 'text' };
    const r1 = await a.run(src, ctx({ config }));
    page = page.replace('</body>', '<p>POP-UP SHOP in SEOUL 2027年3月 弘大 OU-EN Korea</p></body>');
    const r2 = await a.run(src, ctx({ config, state: r1.state }));
    expect(r2.items.map((i) => i.body)).toEqual(['POP-UP SHOP in SEOUL 2027年3月 弘大 OU-EN Korea']);
    expect(extractTextBlocks('<body><nav>메뉴 메뉴 메뉴</nav><p>짧음</p></body>')).toEqual([]);
  });

  it('render 소스인데 렌더러가 없으면 실패한다', async () => {
    const a = createHtmlDiffAdapter({ fetchText: fakeFetch([]) });
    await expect(a.run(fakeSource(), ctx({ config: { render: true } }))).rejects.toThrow(/렌더러/);
  });
});

describe('ticket (멜론티켓)', () => {
  it('검색 결과에서 공연 ID·제목·기간·장소·판매 상태를 뽑는다', () => {
    expect(parseMelonSearch(fixture('ticket/melon-search.html'))).toEqual([
      { prodId: '211664', title: '하츠네 미쿠 HATSUNE MIKU EXPO 2025 in Seoul', period: '2025.11.29 - 2025.11.30', venue: '고려대학교 화정체육관', badges: ['단독판매', '판매종료'] },
    ]);
  });

  it('티켓 오픈 소식에서 오픈 시각(한국 시각 → UTC)을 뽑는다', () => {
    const list = parseMelonTicketOpen(fixture('ticket/melon-ticketopen.html'));
    expect(list[0]).toMatchObject({ csoonId: '10788', title: '하츠네 미쿠 HATSUNE MIKU EXPO 2025 in Seoul 추가 티켓 오픈 안내', openAt: '2025-08-26T03:00:00.000Z', registeredAt: '2025.08.18', badges: ['단독판매'] });
    expect(list[2]!.openAt).toBeNull();
    expect(parseKstDateTime('2026.11.23(월) 20:00')).toBe('2026-11-23T11:00:00.000Z');
  });

  it('검색어마다 요청하고, 같은 내용은 다음 실행에서 다시 내지 않는다', async () => {
    const f = fakeFetch([[/search\/index\.htm/, fixture('ticket/melon-search.html')]]);
    const a = createTicketAdapter(f, 0);
    const src = fakeSource({ adapter: 'ticket', target: 'https://ticket.melon.com/search/index.htm' });
    const config = { site: 'melon', mode: 'search', queries: ['미쿠', '하츠네'] };
    const r1 = await a.run(src, ctx({ config }));
    expect(f.calls).toHaveLength(2);
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]!.body).toContain('판매 상태: 단독판매, 판매종료');
    expect((await a.run(src, ctx({ config, state: r1.state }))).items).toEqual([]);
  });

  it('판매 상태가 바뀌면 새 원문으로 잡는다', async () => {
    let html = fixture('ticket/melon-search.html').replace('판매종료', '판매예정');
    const a = createTicketAdapter(fakeFetch([[/./, () => html]]), 0);
    const config = { site: 'melon', mode: 'search', queries: ['미쿠'] };
    const r1 = await a.run(fakeSource(), ctx({ config }));
    html = html.replace('판매예정', '판매중');
    const r2 = await a.run(fakeSource(), ctx({ config, state: r1.state }));
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0]!.externalId).not.toBe(r1.items[0]!.externalId);
  });

  it('오픈 소식은 POST로 검색어를 보낸다', async () => {
    const f = fakeFetch([[/listTicketOpen/, fixture('ticket/melon-ticketopen.html')]]);
    const r = await createTicketAdapter(f, 0).run(fakeSource(), ctx({ config: { site: 'melon', mode: 'open', queries: ['미쿠'] } }));
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ url: 'https://ticket.melon.com/csoon/detail.htm?csoonId=10788', publishedAt: '2025-08-26T03:00:00.000Z' });
    expect(r.items[0]!.body).toContain('티켓 오픈: 2025.08.26(화) 12:00 (한국 시각)');
  });

  it('구현되지 않은 예매처는 실패한다', async () => {
    await expect(createTicketAdapter(fakeFetch([])).run(fakeSource(), ctx({ config: { site: 'nol' } }))).rejects.toThrow(/미구현/);
  });
});

describe('kopis', () => {
  const keywords = readSeedFiles().keywords;

  it('목록·상세를 파싱하고 예매처 두 형태를 모두 읽는다', () => {
    expect(parseKopisList(fixture('kopis/list.xml')).map((r) => r.mt20id)).toEqual(['PF270001', 'PF270002', 'PF270003']);
    expect(parseKopisList('<dbs/>')).toEqual([]);
    const d = parseKopisDetail(fixture('kopis/detail.xml'))!;
    expect(d.relates).toEqual([
      { name: '멜론티켓', url: 'https://ticket.melon.com/performance/index.htm?prodId=999999' },
      { name: 'NOL 티켓', url: 'https://nol.yanolja.com/ticket/places/000000' },
    ]);
    const flat = parseKopisDetail('<dbs><db><mt20id>A</mt20id><prfnm>B</prfnm><relates><relatenm>티켓링크</relatenm><relateurl>http://t/1</relateurl><relatenm>예스24</relatenm><relateurl>http://y/2</relateurl></relates></db></dbs>')!;
    expect(flat.relates).toEqual([{ name: '티켓링크', url: 'http://t/1' }, { name: '예스24', url: 'http://y/2' }]);
    expect(kopisDetailBody(d)).toContain('예매처: 멜론티켓 https://ticket.melon.com/performance/index.htm?prodId=999999 / NOL 티켓');
    expect(() => parseKopisList('<html>error</html>')).toThrow(/KOPIS 응답 형식/);
  });

  it('31일 창: 오늘-30일 ~ 오늘+365일', () => {
    const w = buildWindows(new Date('2026-11-22T00:00:00Z'), { window_days: 31, lookback_days: 30, horizon_days: 365 });
    expect(w[0]).toEqual(['20261023', '20261122']);
    expect(w[1]).toEqual(['20261123', '20261223']);
    expect(w.at(-1)![1]).toBe('20271122');
    expect(w).toHaveLength(13);
  });

  it('제목을 키워드로 걸러 해당 공연만 상세 조회하고, 서비스키는 오류에 남기지 않는다', async () => {
    const f = fakeFetch([
      [/pblprfr\/PF270001/, fixture('kopis/detail.xml')],
      [/pblprfr\/PF270003/, '<dbs><db><mt20id>PF270003</mt20id><prfnm>MIKU 라이브 투어</prfnm></db></dbs>'],
      [/stdate=20261023/, fixture('kopis/list.xml')],
      [/pblprfr\?/, '<dbs/>'],
    ]);
    const a = createKopisAdapter({ serviceKey: 'SECRETKEY', fetchText: f, loadKeywords: async () => keywords });
    const src = fakeSource({ adapter: 'kopis', target: 'http://www.kopis.or.kr/openApi/restful/pblprfr' });
    const r = await a.run(src, ctx({ config: { request_delay_ms: 0 } }));
    expect(r.items.map((i) => i.title)).toEqual(['하츠네 미쿠 심포니 2027 in 서울', 'MIKU 라이브 투어']);
    expect(r.items[0]!.url).toBe('https://ticket.melon.com/performance/index.htm?prodId=999999');
    expect(f.calls.filter((u) => u.includes('afterdate'))).toHaveLength(0); // 첫 실행은 afterdate 없음
    expect(r.state).toMatchObject({ last_afterdate: '20261122' });

    // 다음 실행: afterdate = 마지막 날짜 - 1일
    const f2 = fakeFetch([[/./, '<dbs/>']]);
    await createKopisAdapter({ serviceKey: 'SECRETKEY', fetchText: f2, loadKeywords: async () => keywords }).run(src, ctx({ state: r.state, config: { request_delay_ms: 0 } }));
    expect(f2.calls[0]).toContain('afterdate=20261121');

    const failing = createKopisAdapter({
      serviceKey: 'SECRETKEY',
      fetchText: async (u) => Promise.reject(new Error(`HTTP 500 ${u}`)),
      loadKeywords: async () => keywords,
    });
    const err = await failing.run(src, ctx()).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('SECRETKEY');
  });

  it('서비스키가 없으면 실패한다', async () => {
    await expect(createKopisAdapter({ loadKeywords: async () => keywords }).run(fakeSource(), ctx())).rejects.toThrow(/KOPIS_SERVICE_KEY/);
  });
});

describe('x_crawl', () => {
  const tweet = (id: string, text: string, daysAgo: number): TweetLike => ({
    id,
    text,
    permanentUrl: `https://x.com/cfm_miku/status/${id}`,
    timeParsed: new Date(new Date('2026-11-22T12:00:00Z').getTime() - daysAgo * 86_400_000),
    urls: [],
  });
  const source = (tweets: TweetLike[], fail = false): (() => Promise<TweetSource>) => async () => ({
    async *getTweets() {
      if (fail) throw new Error('guest token rejected');
      yield* tweets;
    },
  });
  const src = fakeSource({ adapter: 'x_crawl', target: 'cfm_miku' });

  it('게스트로 받고, 첫 실행은 30일 이내만, 다음 실행은 since_id 이후만', async () => {
    const tweets = [tweet('300', '初音ミク「マジカルミライ 2027」開催決定！', 1), tweet('200', '新グッズ', 10), tweet('100', '昔の告知', 60)];
    const a = createXCrawlAdapter({ guest: source(tweets) });
    const r1 = await a.run(src, ctx());
    expect(r1.items.map((i) => i.externalId)).toEqual(['300', '200']);
    expect(r1.state).toMatchObject({ since_id: '300', via: 'guest' });
    const a2 = createXCrawlAdapter({ guest: source([tweet('301', '追加公演', 0), ...tweets]) });
    expect((await a2.run(src, ctx({ state: r1.state }))).items.map((i) => i.externalId)).toEqual(['301']);
  });

  it('게스트가 실패하면 보조 계정 쿠키로 받는다', async () => {
    const a = createXCrawlAdapter({ guest: source([], true), withCookies: source([tweet('500', 'ライブ', 0)]) });
    const r = await a.run(src, ctx());
    expect(r.items.map((i) => i.externalId)).toEqual(['500']);
    expect(r.state).toMatchObject({ via: 'cookies' });
  });

  it('둘 다 실패하면 쿠키 만료 가능성을 담아 실패한다', async () => {
    const a = createXCrawlAdapter({ guest: source([], true), withCookies: source([], true) });
    await expect(a.run(src, ctx())).rejects.toThrow(/쿠키가 만료/);
    const noCookie = createXCrawlAdapter({ guest: source([], true) });
    await expect(noCookie.run(src, ctx())).rejects.toThrow(/X_AUTH_TOKEN/);
  });
});

describe('html_diff json 모드 (AGF 공식 사이트 데이터)', () => {
  const stage = (rows: { stageTime: string; stageName: string; guest: string }[]) => JSON.stringify({ intReturn: 0, listData: rows.map((r) => ({ stageDay: '12-05', ...r })) });
  const board = JSON.stringify({ intReturn: 0, con: 1, listData: [{ idx: 88, title: '(필독) 프레스 참가 신청 안내', writeday: '2026-06-25 15:32:22.500', numm: 54, content: '<p>프레스 <b>ID</b> 발급</p>' }] });
  const cfg = {
    mode: 'json',
    json: {
      list_path: 'listData',
      fields: ['stageTime', 'stageName', 'guest', 'title', 'writeday', 'content'],
      page_url: 'https://www.agfkorea.com/stage?idx=1',
      urls: [
        { url: 'https://api.example/getStageTimeline?gubun=red&stageDay=12-05', label: 'RED 스테이지 12-05' },
        { url: 'https://api.example/getBoardList?board_id=1', label: '공지' },
      ],
    },
  };

  it('첫 실행은 기준점만, 다음 실행은 새 행만 내고 조회수 같은 빠진 필드는 무시한다', async () => {
    let rows = [{ stageTime: '13:00~13:45', stageName: '페이트/그랜드 오더 스테이지', guest: '타카하시 리에' }];
    let boardBody = board;
    const fetchText = fakeFetch([
      [/getStageTimeline/, () => stage(rows)],
      [/getBoardList/, () => boardBody],
    ]);
    const adapter = createHtmlDiffAdapter({ fetchText });
    const src = fakeSource({ adapter: 'html_diff', target: 'https://www.agfkorea.com/stage?idx=1' });
    const first = await adapter.run(src, { now: new Date(), state: {}, config: cfg });
    expect(first.items).toEqual([]);

    rows = [...rows, { stageTime: '16:45~17:30', stageName: 'TAK with 하츠네 미쿠 & 카사네 테토', guest: 'TAK' }];
    boardBody = board.replace('"numm":54', '"numm":99'); // 조회수만 바뀜
    const second = await adapter.run(src, { now: new Date(), state: first.state!, config: cfg });
    expect(second.items.map((i) => i.body)).toEqual(['RED 스테이지 12-05 · 16:45~17:30 · TAK with 하츠네 미쿠 & 카사네 테토 · TAK']);
    expect(second.items[0]!.url).toBe('https://www.agfkorea.com/stage?idx=1');
  });

  it('HTML 필드는 태그를 지우고, 목록이 없는 응답은 건너뛴다', async () => {
    const fetchText = fakeFetch([
      [/getStageTimeline/, JSON.stringify({ intReturn: 1 })],
      [/getBoardList/, board],
    ]);
    expect(await jsonBlocks(cfg.json, fetchText)).toEqual(['공지 · (필독) 프레스 참가 신청 안내 · 2026-06-25 15:32:22.500 · 프레스 ID 발급']);
  });
});
