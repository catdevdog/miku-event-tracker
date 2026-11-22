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

interface TicketState {
  seen?: string[];
}

/**
 * 예매처 어댑터. 지금은 멜론티켓만 구현돼 있다(검색·오픈 소식 모두 서버 렌더링이라 fetch 사용).
 * NOL·YES24·티켓링크는 요청 형식을 확인한 뒤 추가한다.
 */
export function createTicketAdapter(fetchText: FetchText = defaultFetchText, delayMs = 500): SourceAdapter {
  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const cfg = ctx.config as unknown as TicketConfig;
      const state = ctx.state as TicketState;
      if (cfg.site !== 'melon') throw new Error(`예매처 어댑터 미구현: ${cfg.site}`);
      const queries = cfg.queries?.length ? cfg.queries : ['미쿠'];

      const all = new Map<string, RawItemInput>();
      for (const [i, q] of queries.entries()) {
        if (i > 0) await sleep(delayMs);
        if (cfg.mode === 'open') {
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
