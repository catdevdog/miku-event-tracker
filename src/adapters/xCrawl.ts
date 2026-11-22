import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { sha256 } from './http.js';

// CLAUDE.md 규칙 10: 게스트 토큰 → 보조 계정 쿠키 → (Playwright, 미구현) 순서. 메인 계정 쿠키는 절대 쓰지 않는다.

/** 이 어댑터가 쓰는 트윗 필드만 */
export interface TweetLike {
  id?: string;
  text?: string;
  permanentUrl?: string;
  timeParsed?: Date;
  isRetweet?: boolean;
  retweetedStatus?: { text?: string; username?: string };
  urls?: string[];
}

export interface TweetSource {
  /** 최근 트윗을 최신순으로 */
  getTweets(handle: string, max: number): AsyncGenerator<TweetLike>;
}

export interface XCrawlDeps {
  /** 게스트 토큰 스크레이퍼 */
  guest: () => Promise<TweetSource>;
  /** 보조 계정 쿠키 스크레이퍼. 쿠키가 없으면 undefined */
  withCookies?: () => Promise<TweetSource>;
  maxTweets?: number;
}

export const FIRST_RUN_DAYS = 30;

interface XState {
  since_id?: string;
  /** 마지막으로 성공한 경로 (guest | cookies) */
  via?: string;
}

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

async function collect(src: TweetSource, handle: string, max: number): Promise<TweetLike[]> {
  const out: TweetLike[] = [];
  for await (const t of src.getTweets(handle, max)) {
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function tweetToItem(handle: string, t: TweetLike): RawItemInput | null {
  if (!t.id) return null;
  const rtText = t.isRetweet && t.retweetedStatus?.text ? `RT @${t.retweetedStatus.username ?? ''}: ${t.retweetedStatus.text}` : '';
  const text = (rtText || t.text || '').trim();
  const urls = (t.urls ?? []).filter(Boolean);
  const body = [text, ...urls].join('\n');
  return {
    externalId: t.id,
    url: t.permanentUrl ?? `https://x.com/${handle}/status/${t.id}`,
    title: text.split('\n')[0]?.slice(0, 120) || `@${handle} 게시물`,
    body,
    publishedAt: t.timeParsed ? t.timeParsed.toISOString() : undefined,
    contentHash: sha256(body),
  };
}

export function createXCrawlAdapter(deps: XCrawlDeps): SourceAdapter {
  const max = deps.maxTweets ?? 20;
  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const handle = source.target.replace(/^@/, '');
      const state = ctx.state as XState;

      let tweets: TweetLike[] = [];
      let via = 'guest';
      let guestError: unknown;
      try {
        tweets = await collect(await deps.guest(), handle, max);
      } catch (err) {
        guestError = err;
      }
      // 게스트가 실패했거나 아무것도 못 받았으면 보조 계정 쿠키로 다시 시도
      if (tweets.length === 0 && deps.withCookies) {
        via = 'cookies';
        try {
          tweets = await collect(await deps.withCookies(), handle, max);
        } catch (err) {
          const g = guestError instanceof Error ? guestError.message : String(guestError ?? '결과 없음');
          const c = err instanceof Error ? err.message : String(err);
          throw new Error(`X 수집 실패 (@${handle}) 게스트: ${g} / 쿠키: ${c} — 쿠키가 만료됐을 수 있습니다`);
        }
      } else if (tweets.length === 0 && guestError) {
        throw new Error(`X 수집 실패 (@${handle}) 게스트: ${guestError instanceof Error ? guestError.message : String(guestError)} — X_AUTH_TOKEN·X_CT0가 없어 쿠키 경로를 쓰지 못했습니다`);
      }

      const sinceId = state.since_id;
      const cutoff = ctx.now.getTime() - FIRST_RUN_DAYS * 86_400_000;
      const items: RawItemInput[] = [];
      let maxId = sinceId;
      for (const t of tweets) {
        if (!t.id || !/^\d+$/.test(t.id)) continue;
        if (!maxId || newer(t.id, maxId)) maxId = t.id;
        if (sinceId && !newer(t.id, sinceId)) continue;
        if (!sinceId && t.timeParsed && t.timeParsed.getTime() < cutoff) continue; // 첫 실행: 30일 이내만
        const item = tweetToItem(handle, t);
        if (item) items.push(item);
      }
      return { items, state: { since_id: maxId, via } };
    },
  };
}

/** 실제 스크레이퍼(@the-convocation/twitter-scraper) 연결 */
export function twitterScraperDeps(cookies?: { authToken?: string; ct0?: string }): XCrawlDeps {
  let guestScraper: Promise<TweetSource> | undefined;
  let cookieScraper: Promise<TweetSource> | undefined;
  const make = async (withCookies: boolean): Promise<TweetSource> => {
    const { Scraper } = await import('@the-convocation/twitter-scraper');
    const scraper = new Scraper();
    if (withCookies && cookies?.authToken && cookies.ct0) {
      await scraper.setCookies([
        `auth_token=${cookies.authToken}; Domain=.x.com; Path=/; Secure; HttpOnly`,
        `ct0=${cookies.ct0}; Domain=.x.com; Path=/; Secure`,
      ]);
    }
    return scraper as unknown as TweetSource;
  };
  return {
    // 스크레이퍼는 재사용한다(게스트 토큰 재발급을 줄이기 위해). 실패하면 다음 실행에서 새로 만든다.
    guest: () => (guestScraper ??= make(false).catch((e: unknown) => ((guestScraper = undefined), Promise.reject(e)))),
    withCookies:
      cookies?.authToken && cookies.ct0
        ? () => (cookieScraper ??= make(true).catch((e: unknown) => ((cookieScraper = undefined), Promise.reject(e))))
        : undefined,
  };
}
