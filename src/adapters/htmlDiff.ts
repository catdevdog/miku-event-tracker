import * as cheerio from 'cheerio';
import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { fetchStatus as defaultFetchStatus, fetchText as defaultFetchText, rememberSeen, sha256, squash, type FetchText } from './http.js';

export interface HtmlDiffConfig {
  /** 링크·본문을 볼 범위 (CSS 선택자). 기본 body */
  selector?: string;
  /** links: 새로 생긴 링크를 항목으로 (기본) / text: 새로 생긴 문단을 항목으로 (링크가 없는 사이트) */
  mode?: 'links' | 'text';
  /** 스크립트로 그리는 사이트면 Playwright로 렌더링한 HTML을 쓴다 */
  render?: boolean;
  /** 제외할 링크 URL 정규식 */
  exclude?: string[];
  /** 연도별 경로 감시: pattern의 {year}를 올해·내년으로 바꿔 페이지가 생기는지(200) 본다 */
  year_paths?: boolean;
  pattern?: string;
}

interface HtmlDiffState {
  seen?: string[];
  liveYears?: number[];
}

export type RenderHtml = (url: string) => Promise<string>;

export interface HtmlDiffDeps {
  fetchText?: FetchText;
  fetchStatus?: (url: string) => Promise<number>;
  renderHtml?: RenderHtml;
}

/** 이미지·파일·공유 버튼처럼 소식이 아닌 링크 */
const DEFAULT_EXCLUDE = [
  /\.(?:jpe?g|png|gif|webp|svg|pdf|zip|mp3|mp4)(?:[?#]|$)/i,
  /^(?:javascript|mailto|tel):/i,
  /(?:twitter|x)\.com\/(?:share|intent)/i,
  /facebook\.com\/sharer/i,
  /line\.me\/R\/msg/i,
];

export interface PageLink {
  url: string;
  text: string;
}

/** 범위 안의 링크를 (절대 URL, 텍스트)로 뽑는다. 같은 URL은 처음 것만, 페이지 안 앵커(#)는 뺀다. */
export function extractLinks(html: string, baseUrl: string, cfg: Pick<HtmlDiffConfig, 'selector' | 'exclude'> = {}): PageLink[] {
  const $ = cheerio.load(html);
  const scope = $(cfg.selector ?? 'body');
  const extra = (cfg.exclude ?? []).map((r) => new RegExp(r, 'i'));
  const base = new URL(baseUrl);
  const out = new Map<string, PageLink>();
  scope.find('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href || href.startsWith('#')) return;
    if (DEFAULT_EXCLUDE.some((r) => r.test(href))) return;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(abs.protocol)) return;
    // 같은 페이지 안 앵커
    if (abs.hash && abs.origin + abs.pathname + abs.search === base.origin + base.pathname + base.search) return;
    abs.hash = '';
    const url = abs.toString();
    if (DEFAULT_EXCLUDE.some((r) => r.test(url)) || extra.some((r) => r.test(url))) return;
    const text = squash($(el).text()) || squash($(el).find('img').attr('alt') ?? '') || squash($(el).attr('title') ?? '');
    if (!text) return;
    if (!out.has(url)) out.set(url, { url, text: text.slice(0, 300) });
  });
  return [...out.values()];
}

/** 범위 안 본문을 문단 단위로 나눈다 (8자 미만 조각은 메뉴·버튼으로 보고 버림). */
export function extractTextBlocks(html: string, selector = 'body'): string[] {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, header, footer').remove();
  const blocks: string[] = [];
  $(selector)
    .find('h1, h2, h3, h4, h5, p, li, dt, dd, td, span, div')
    .each((_, el) => {
      // 자식 블록이 있는 컨테이너는 건너뛰고 말단만 모은다
      if ($(el).children('h1, h2, h3, h4, h5, p, li, div, ul, ol, table, dl').length > 0) return;
      const t = squash($(el).text());
      if (t.length >= 8) blocks.push(t.slice(0, 1000));
    });
  return [...new Set(blocks)];
}

/** 한국 시간 기준 연도 */
const kstYear = (d: Date) => new Date(d.getTime() + 9 * 3600_000).getUTCFullYear();

/**
 * 페이지 변화 감시 어댑터.
 * - 첫 실행은 현재 페이지를 기준점으로만 기록하고 항목을 내보내지 않는다(기존 링크가 전부 새 소식으로 잡히는 것을 막음).
 * - 이후 새로 생긴 링크(또는 문단)만 항목으로 돌려준다.
 * - year_paths면 내년 페이지가 404 → 200으로 바뀌는 순간을 발표 신호로 돌려준다.
 */
export function createHtmlDiffAdapter(deps: HtmlDiffDeps = {}): SourceAdapter {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const fetchStatus = deps.fetchStatus ?? defaultFetchStatus;

  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const cfg = ctx.config as HtmlDiffConfig;
      const state = ctx.state as HtmlDiffState;
      const firstRun = !Array.isArray(state.seen);
      const items: RawItemInput[] = [];

      let html: string;
      if (cfg.render) {
        if (!deps.renderHtml) throw new Error('render=true 소스인데 렌더러가 없습니다');
        html = await deps.renderHtml(source.target);
      } else {
        html = (await fetchText(source.target)).text;
      }

      let seenNow: string[];
      if (cfg.mode === 'text') {
        const blocks = extractTextBlocks(html, cfg.selector);
        const ids = blocks.map((b) => sha256(b).slice(0, 16));
        const seen = new Set(state.seen ?? []);
        if (!firstRun) {
          blocks.forEach((b, i) => {
            if (seen.has(ids[i]!)) return;
            items.push({
              externalId: `${source.target}#${ids[i]}`,
              url: source.target,
              title: b.slice(0, 120),
              body: b,
              contentHash: sha256(b),
            });
          });
        }
        seenNow = ids;
      } else {
        const links = extractLinks(html, source.target, cfg);
        const seen = new Set(state.seen ?? []);
        if (!firstRun) {
          for (const l of links) {
            if (seen.has(l.url)) continue;
            items.push({ externalId: l.url, url: l.url, title: l.text, body: l.text, contentHash: sha256(`${l.url}\n${l.text}`) });
          }
        }
        seenNow = links.map((l) => l.url);
      }

      let liveYears = state.liveYears ?? [];
      if (cfg.year_paths && cfg.pattern) {
        const y = kstYear(ctx.now);
        for (const year of [y, y + 1]) {
          if (liveYears.includes(year)) continue;
          const url = cfg.pattern.replace('{year}', String(year));
          const status = await fetchStatus(url);
          if (status === 200) {
            liveYears = [...liveYears, year];
            if (!firstRun) {
              items.push({
                externalId: url,
                url,
                title: `${source.name} ${year} 페이지 공개`,
                body: `${source.name}의 ${year}년 페이지(${url})가 새로 열렸습니다.`,
                contentHash: sha256(url),
              });
            }
          }
        }
      }

      return { items, state: { seen: rememberSeen(state.seen ?? [], seenNow, 2000), liveYears } };
    },
  };
}
