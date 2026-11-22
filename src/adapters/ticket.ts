import * as cheerio from 'cheerio';
import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { fetchText as defaultFetchText, rememberSeen, sha256, sleep, squash, type FetchText } from './http.js';

export interface TicketConfig {
  site: 'melon' | 'nol' | 'yes24' | 'ticketlink';
  /** search: 공연 검색 결과 / open: 티켓 오픈 소식 */
  mode?: 'search' | 'open';
  queries?: string[];
}

const MELON = 'https://ticket.melon.com';
const YES24 = 'https://ticket.yes24.com';

export interface MelonPerformance {
  prodId: string;
  title: string;
  period: string;
  venue: string;
  badges: string[];
}

/** 멜론티켓 통합검색(/search/index.htm?q=) 결과의 공연 목록. 서버에서 그린 HTML이라 fetch로 충분하다. */
export function parseMelonSearch(html: string): MelonPerformance[] {
  const $ = cheerio.load(html);
  const out: MelonPerformance[] = [];
  $('.box_movie table tbody tr').each((_, tr) => {
    const href = $(tr).find('a[href*="prodId="]').first().attr('href') ?? '';
    const prodId = /prodId=(\d+)/.exec(href)?.[1];
    if (!prodId) return;
    out.push({
      prodId,
      title: squash($(tr).find('.show_title').text()),
      period: squash($(tr).find('.show_date').text()),
      venue: squash($(tr).find('.show_loc').text()),
      badges: $(tr)
        .find('.ico_list')
        .map((_, b) => squash($(b).text()))
        .get()
        .filter(Boolean),
    });
  });
  return out;
}

export interface MelonTicketOpen {
  csoonId: string;
  title: string;
  /** UTC ISO. "오픈일정 보기"처럼 시각이 없으면 null */
  openAt: string | null;
  openText: string;
  registeredAt: string;
  badges: string[];
}

/** "2025.08.26(화) 12:00" (한국 시각) → UTC ISO */
export function parseKstDateTime(text: string): string | null {
  const m = /(\d{4})\.(\d{2})\.(\d{2})\([^)]*\)\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(`${y}-${mo}-${d}T${h!.padStart(2, '0')}:${mi}:00+09:00`).toISOString();
}

/** 멜론티켓 "티켓오픈소식" 목록(POST /csoon/ajax/listTicketOpen.htm) */
export function parseMelonTicketOpen(html: string): MelonTicketOpen[] {
  const $ = cheerio.load(html);
  const out: MelonTicketOpen[] = [];
  $('ul.list_ticket_cont > li').each((_, li) => {
    const a = $(li).find('a.tit').first();
    const csoonId = /csoonId=(\d+)/.exec(a.attr('href') ?? '')?.[1];
    if (!csoonId) return;
    const openText = squash($(li).find('.ticket_data .date').text());
    out.push({
      csoonId,
      title: squash(a.text()),
      openAt: parseKstDateTime(openText),
      openText,
      registeredAt: squash($(li).find('dd.txt_date').text()),
      badges: $(li)
        .find('.point .ico_list')
        .map((_, b) => squash($(b).text()))
        .get()
        .filter(Boolean),
    });
  });
  return out;
}

function melonPerformanceItem(p: MelonPerformance): RawItemInput {
  const url = `${MELON}/performance/index.htm?prodId=${p.prodId}`;
  const body = [`공연명: ${p.title}`, `기간: ${p.period}`, `장소: ${p.venue}`, `판매 상태: ${p.badges.join(', ') || '-'}`, `예매처: 멜론티켓 ${url}`].join('\n');
  const hash = sha256(body);
  // 판매 상태·일정이 바뀌면 새 원문으로 잡히도록 내용 해시를 ID에 넣는다.
  return { externalId: `melon:prod:${p.prodId}:${hash.slice(0, 12)}`, url, title: p.title, body, lang: 'ko', contentHash: hash };
}

function melonOpenItem(o: MelonTicketOpen): RawItemInput {
  const url = `${MELON}/csoon/detail.htm?csoonId=${o.csoonId}`;
  const body = [
    `제목: ${o.title}`,
    `티켓 오픈: ${o.openText || '-'}${o.openAt ? ' (한국 시각)' : ''}`,
    `판매 형태: ${o.badges.join(', ') || '-'}`,
    `등록일: ${o.registeredAt || '-'}`,
    `예매처: 멜론티켓 ${url}`,
  ].join('\n');
  const hash = sha256(body);
  return {
    externalId: `melon:csoon:${o.csoonId}:${hash.slice(0, 12)}`,
    url,
    title: o.title,
    body,
    lang: 'ko',
    publishedAt: o.openAt ?? undefined,
    contentHash: hash,
  };
}

export interface Yes24Performance {
  perfId: string;
  title: string;
  period: string;
  venue: string;
  badges: string[];
}

/** YES24 공연 검색(POST /New/Search/Ajax/axPerfList.aspx) 결과. 제목에 없어도 출연진으로 걸린 공연이 나온다 */
export function parseYes24Search(html: string): Yes24Performance[] {
  const $ = cheerio.load(html);
  const out: Yes24Performance[] = [];
  $('.srch-list-item').each((_, el) => {
    const a = $(el).find('.item-tit a').first();
    const perfId = /\/Perf\/(\d+)/.exec(a.attr('href') ?? '')?.[1];
    if (!perfId) return;
    const cells = $(el).children('div');
    out.push({
      perfId,
      title: squash(a.text()),
      period: squash(cells.eq(2).text()),
      venue: squash(cells.eq(3).text()),
      badges: $(el).find('.item-state span').map((_, b) => squash($(b).text())).get().filter(Boolean),
    });
  });
  return out;
}

export interface Yes24TicketOpen {
  noticeId: string;
  title: string;
  openText: string;
  openAt: string | null;
  badges: string[];
}

/** YES24 티켓 오픈 공지(POST /New/Notice/Ajax/axList.aspx, searchText로 거름) */
export function parseYes24TicketOpen(html: string): Yes24TicketOpen[] {
  const $ = cheerio.load(html);
  const out: Yes24TicketOpen[] = [];
  $('.noti-tbl tr').each((_, tr) => {
    const a = $(tr).find('a[href^="#id="]').first();
    const noticeId = /#id=(\d+)/.exec(a.attr('href') ?? '')?.[1];
    if (!noticeId) return;
    const tds = $(tr).find('td');
    const openText = squash(tds.eq(2).text());
    out.push({
      noticeId,
      title: squash(a.find('em').not(':has(span)').last().text() || a.text()),
      openText,
      openAt: parseKstDateTime(openText),
      badges: a.find('em span').map((_, b) => squash($(b).text())).get().filter(Boolean),
    });
  });
  return out;
}

function yes24PerformanceItem(p: Yes24Performance): RawItemInput {
  const url = `${YES24}/Perf/${p.perfId}`;
  const body = [`공연명: ${p.title}`, `기간: ${p.period}`, `장소: ${p.venue}`, `판매 상태: ${p.badges.join(', ') || '-'}`, `예매처: YES24 티켓 ${url}`].join('\n');
  const hash = sha256(body);
  return { externalId: `yes24:perf:${p.perfId}:${hash.slice(0, 12)}`, url, title: p.title, body, lang: 'ko', contentHash: hash };
}

function yes24OpenItem(o: Yes24TicketOpen): RawItemInput {
  const url = `${YES24}/Notice#id=${o.noticeId}`;
  const body = [
    `제목: ${o.title}`,
    `티켓 오픈: ${o.openText || '-'}${o.openAt ? ' (한국 시각)' : ''}`,
    `판매 형태: ${o.badges.join(', ') || '-'}`,
    `예매처: YES24 티켓 ${url}`,
  ].join('\n');
  const hash = sha256(body);
  return { externalId: `yes24:notice:${o.noticeId}:${hash.slice(0, 12)}`, url, title: o.title, body, lang: 'ko', publishedAt: o.openAt ?? undefined, contentHash: hash };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' };

async function yes24Fetch(fetchText: FetchText, mode: TicketConfig['mode'], q: string): Promise<RawItemInput[]> {
  if (mode === 'open') {
    const body = new URLSearchParams({ page: '1', size: '20', genre: '', province: '', order: '1', searchType: 'All', searchText: q }).toString();
    const { text } = await fetchText(`${YES24}/New/Notice/Ajax/axList.aspx`, { method: 'POST', body, headers: { ...FORM, referer: `${YES24}/Notice?Gcode=009_208_002` } });
    return parseYes24TicketOpen(text).map(yes24OpenItem);
  }
  const body = new URLSearchParams({ SearchText: q, SearchSubText: '', SearchType: '', BookingType: '', PerfCurPage: '1', PageSize: '20', SortType: '1' }).toString();
  const { text } = await fetchText(`${YES24}/New/Search/Ajax/axPerfList.aspx`, { method: 'POST', body, headers: { ...FORM, referer: `${YES24}/Search/${encodeURIComponent(q)}` } });
  return parseYes24Search(text).map(yes24PerformanceItem);
}

interface TicketState {
  seen?: string[];
}

/**
 * 예매처 어댑터. 멜론티켓·YES24 티켓 (검색·오픈 소식 모두 서버가 그린 HTML이라 fetch 사용).
 * 티켓링크는 자동화 차단(스크립트 확인)이 있어 쓰지 않고, NOL은 검색 주소가 없어 보류(docs/ticket-sites.md).
 */
export function createTicketAdapter(fetchText: FetchText = defaultFetchText, delayMs = 500): SourceAdapter {
  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const cfg = ctx.config as unknown as TicketConfig;
      const state = ctx.state as TicketState;
      if (cfg.site !== 'melon' && cfg.site !== 'yes24') throw new Error(`예매처 어댑터 미구현: ${cfg.site}`);
      const queries = cfg.queries?.length ? cfg.queries : ['미쿠'];

      const all = new Map<string, RawItemInput>();
      for (const [i, q] of queries.entries()) {
        if (i > 0) await sleep(delayMs);
        if (cfg.site === 'yes24') {
          for (const item of await yes24Fetch(fetchText, cfg.mode, q)) all.set(item.externalId, item);
        } else if (cfg.mode === 'open') {
          const body = new URLSearchParams({ orderType: '0', pageIndex: '1', schGcode: 'GENRE_ALL', schText: q, schDt: '' }).toString();
          const { text } = await fetchText(`${MELON}/csoon/ajax/listTicketOpen.htm`, {
            method: 'POST',
            body,
            headers: {
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'x-requested-with': 'XMLHttpRequest',
              referer: `${MELON}/csoon/index.htm`,
            },
          });
          for (const o of parseMelonTicketOpen(text)) {
            const item = melonOpenItem(o);
            all.set(item.externalId, item);
          }
        } else {
          const { text } = await fetchText(`${MELON}/search/index.htm?q=${encodeURIComponent(q)}`);
          for (const p of parseMelonSearch(text)) {
            const item = melonPerformanceItem(p);
            all.set(item.externalId, item);
          }
        }
      }

      const seen = new Set(state.seen ?? []);
      const items = [...all.values()].filter((i) => !seen.has(i.externalId));
      return { items, state: { seen: rememberSeen(state.seen ?? [], [...all.keys()], 1000) } };
    },
  };
}
