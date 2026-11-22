import * as cheerio from 'cheerio';
import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { sha256, sleep, squash } from './http.js';
import { AlertNowError } from './types.js';

// 명세: docs/naver.md (NAVER API HUB 검색 API)

export const NAVER_HOST = 'https://naverapihub.apigw.ntruss.com';

export type NaverKind = 'news' | 'blog' | 'cafearticle';

export interface NaverConfig {
  endpoints?: Partial<Record<NaverKind, string>>;
  queries?: string[];
  sort?: 'date' | 'sim';
  display?: number;
  max_start?: number;
  purge_days?: number;
  /** 조합을 처음 돌 때 낼 글의 기간(일). 날짜가 없는 카페글은 첫 실행에 내지 않는다. */
  first_run_days?: number;
  request_delay_ms?: number;
}

interface ComboState {
  /** 최근에 본 글 link (최신 순, 최대 SEEN_MAX개). 이 중 하나가 나오면 페이지 넘기기를 멈춘다. */
  seen: string[];
}

export interface NaverState extends Record<string, unknown> {
  combos?: Record<string, ComboState>;
  /** 429(하루 한도 초과) 뒤 다음 날 0시(KST)까지 건너뛴다 */
  blocked_until?: string;
}

/** 종류별 응답 항목. 필드는 NAVER API HUB 문서(2026-11-22 확인) 기준 */
export interface NaverItem {
  title: string;
  link: string;
  description: string;
  /** 뉴스: 원문 기사 주소 */
  originallink?: string;
  /** 뉴스: "Thu, 11 Jun 2026 18:34:00 +0900" */
  pubDate?: string;
  /** 블로그 */
  bloggername?: string;
  bloggerlink?: string;
  /** 블로그: "20260611" */
  postdate?: string;
  /** 카페글 (날짜 없음) */
  cafename?: string;
  cafeurl?: string;
}

export interface NaverResponse {
  lastBuildDate?: string;
  total: number;
  start: number;
  display: number;
  items: NaverItem[];
}

export class NaverApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    detail: string,
  ) {
    super(`네이버 검색 API 오류 (HTTP ${status}${code ? ` ${code}` : ''}) ${detail}`.trim());
    this.name = 'NaverApiError';
  }
}

const SEEN_MAX = 300;
const DEFAULTS = {
  endpoints: { news: '/search/v1/news', blog: '/search/v1/blog', cafearticle: '/search/v1/cafearticle' } as Record<NaverKind, string>,
  sort: 'date' as const,
  display: 100,
  max_start: 1000,
  purge_days: 20,
  first_run_days: 14,
  request_delay_ms: 200,
};

/** <b> 강조 태그와 HTML 엔티티를 지운다 (키워드 판정 전, 명세) */
export function cleanText(s: string | undefined): string {
  if (!s) return '';
  return squash(cheerio.load(`<p>${s}</p>`)('p').text());
}

/** 글 작성 시각(ISO). 뉴스 pubDate, 블로그 postdate(KST 자정), 카페글은 없음 */
export function itemDate(kind: NaverKind, it: NaverItem): string | undefined {
  if (kind === 'news' && it.pubDate) {
    const t = Date.parse(it.pubDate);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  if (kind === 'blog' && it.postdate && /^\d{8}$/.test(it.postdate)) {
    const d = it.postdate;
    return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`).toISOString();
  }
  return undefined;
}

/** 다음 날 0시(KST)의 UTC ISO */
export function nextKstMidnight(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const next = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1) - 9 * 3600_000;
  return new Date(next).toISOString();
}

function parseResponse(text: string): NaverResponse {
  const v = JSON.parse(text) as Partial<NaverResponse>;
  if (!v || !Array.isArray(v.items)) throw new Error('네이버 검색 응답에 items 배열이 없습니다');
  for (const it of v.items) {
    if (!it || typeof it.link !== 'string' || !it.link) throw new Error('네이버 검색 응답 항목에 link가 없습니다');
  }
  return { total: Number(v.total ?? 0), start: Number(v.start ?? 1), display: Number(v.display ?? v.items.length), lastBuildDate: v.lastBuildDate, items: v.items };
}

/** 오류 본문: API Gateway는 {error:{errorCode,message}}, 검색 API는 {errorCode,errorMessage} */
function parseError(status: number, text: string): NaverApiError {
  let code: string | undefined;
  let message = text.slice(0, 200);
  try {
    const v = JSON.parse(text) as { error?: { errorCode?: string; message?: string }; errorCode?: string; errorMessage?: string };
    code = v.errorCode ?? v.error?.errorCode;
    message = v.errorMessage ?? v.error?.message ?? message;
  } catch {
    // 본문이 JSON이 아니면 그대로
  }
  return new NaverApiError(status, code, squash(message));
}

export interface NaverDeps {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}

export function createNaverAdapter(deps: NaverDeps): SourceAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function search(path: string, query: string, start: number, cfg: Required<Pick<NaverConfig, 'display' | 'sort'>>): Promise<NaverResponse> {
    const url = new URL(path, NAVER_HOST);
    url.searchParams.set('query', query);
    url.searchParams.set('display', String(cfg.display));
    url.searchParams.set('start', String(start));
    url.searchParams.set('sort', cfg.sort);
    url.searchParams.set('format', 'json');
    // 키는 헤더로만 보내므로 오류 메시지의 URL에 시크릿이 들어가지 않는다.
    const res = await fetchImpl(url, {
      headers: { 'X-NCP-APIGW-API-KEY-ID': deps.clientId!, 'X-NCP-APIGW-API-KEY': deps.clientSecret!, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw parseError(res.status, text);
    return parseResponse(text);
  }

  return {
    async run(_source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      if (!deps.clientId || !deps.clientSecret) throw new Error('NAVER_CLIENT_ID·NAVER_CLIENT_SECRET이 설정되지 않았습니다');
      const cfg = ctx.config as NaverConfig;
      const endpoints = { ...DEFAULTS.endpoints, ...cfg.endpoints };
      const kinds = Object.keys(endpoints) as NaverKind[];
      const queries = cfg.queries ?? [];
      const display = Math.min(100, Math.max(1, cfg.display ?? DEFAULTS.display));
      const maxStart = Math.min(1000, cfg.max_start ?? DEFAULTS.max_start);
      const purgeDays = cfg.purge_days ?? DEFAULTS.purge_days;
      const firstRunDays = cfg.first_run_days ?? DEFAULTS.first_run_days;
      const delay = cfg.request_delay_ms ?? DEFAULTS.request_delay_ms;
      const sort = cfg.sort ?? DEFAULTS.sort;

      const prev = ctx.state as NaverState;
      if (prev.blocked_until && ctx.now.getTime() < Date.parse(prev.blocked_until)) {
        return { items: [] }; // 하루 한도 초과 상태: 다음 날 0시(KST)까지 호출하지 않는다
      }
      const state: NaverState = { combos: { ...prev.combos } };
      const purgeAfter = new Date(ctx.now.getTime() + purgeDays * 86_400_000).toISOString();
      const firstRunFrom = ctx.now.getTime() - firstRunDays * 86_400_000;
      const out = new Map<string, RawItemInput>();
      let calls = 0;

      try {
        for (const kind of kinds) {
          for (const query of queries) {
            const key = `${kind}:${query}`;
            const firstRun = !prev.combos?.[key];
            const seen = new Set(prev.combos?.[key]?.seen ?? []);
            const fresh: NaverItem[] = [];

            for (let start = 1; start <= maxStart; start += display) {
              if (calls > 0 && delay > 0) await sleep(delay);
              const res = await search(endpoints[kind], query, start, { display, sort });
              calls++;
              let reachedSeen = false;
              for (const it of res.items) {
                if (seen.has(it.link)) {
                  reachedSeen = true;
                  break; // 최신순이므로 본 글 뒤는 모두 본 글
                }
                fresh.push(it);
              }
              // 첫 실행은 첫 페이지만. 본 글이 나왔거나 결과가 끝났으면 멈춘다.
              if (firstRun || reachedSeen || res.items.length < display || start + display > Math.min(maxStart, res.total)) break;
            }

            state.combos![key] = { seen: [...new Set([...fresh.map((f) => f.link), ...(prev.combos?.[key]?.seen ?? [])])].slice(0, SEEN_MAX) };

            for (const it of fresh) {
              const publishedAt = itemDate(kind, it);
              // 첫 실행: 최근 first_run_days일 글만 (날짜 없는 카페글은 기준점만 잡는다)
              if (firstRun && (!publishedAt || Date.parse(publishedAt) < firstRunFrom)) continue;
              if (out.has(it.link)) continue;
              const title = cleanText(it.title);
              const body = cleanText(it.description);
              out.set(it.link, {
                externalId: it.link,
                url: it.link,
                title,
                body,
                lang: 'ko',
                publishedAt,
                contentHash: sha256(`${title}\n${body}`),
                purgeAfter,
              });
            }
          }
        }
      } catch (err) {
        if (err instanceof NaverApiError && err.status === 429) {
          // 하루 한도 초과: 지금까지 모은 글과 상태는 저장하고 다음 날 0시(KST)까지 건너뛴다
          state.blocked_until = nextKstMidnight(ctx.now);
          return {
            items: [...out.values()],
            state,
            notes: [`하루 호출 한도를 넘었습니다 (HTTP 429). ${state.blocked_until} (다음 날 0시 KST)까지 네이버 검색을 건너뜁니다. 오늘 호출 ${calls}회`],
          };
        }
        if (err instanceof NaverApiError && [400, 401, 403, 404].includes(err.status)) {
          // 키·구독·요청 형식 문제: 재시도해도 같으므로 바로 알린다 (500은 일시 오류로 보고 실패 횟수로만 센다)
          throw new AlertNowError(err.message, { cause: err });
        }
        throw err;
      }
      return { items: [...out.values()], state };
    },
  };
}
