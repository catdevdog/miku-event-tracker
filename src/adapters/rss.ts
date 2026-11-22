import Parser from 'rss-parser';
import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { fetchText as defaultFetchText, rememberSeen, sha256, stripTags, type FetchText } from './http.js';

const parser = new Parser();

/** 첫 실행에서 이보다 오래된 글은 "이미 본 것"으로만 기록하고 내보내지 않는다. */
export const FIRST_RUN_DAYS = 30;

interface RssState {
  seen?: string[];
}

/**
 * RSS 2.0 / RSS 1.0(RDF) / Atom 공통 어댑터.
 * 새 글만 돌려준다. 본 글 ID는 sources.state.seen에 최근 500개까지 둔다.
 */
export function createRssAdapter(fetchText: FetchText = defaultFetchText): SourceAdapter {
  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const state = ctx.state as RssState;
      const firstRun = !Array.isArray(state.seen);
      const { text } = await fetchText(source.target, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
      const feed = await parser.parseString(text);

      const all: RawItemInput[] = [];
      for (const item of feed.items) {
        const url = item.link?.trim();
        const externalId = (url || item.guid || item.id || '').trim();
        if (!externalId) continue;
        const title = (item.title ?? '').trim();
        const body = stripTags(
          item.contentSnippet || (item as { summary?: string }).summary || item.content || item['content:encoded'] || '',
        ).slice(0, 4000);
        const publishedAt = item.isoDate ? new Date(item.isoDate).toISOString() : undefined;
        all.push({ externalId, url, title, body, publishedAt, contentHash: sha256(`${title}\n${url ?? ''}\n${body}`) });
      }

      const seen = new Set(state.seen ?? []);
      const cutoff = ctx.now.getTime() - FIRST_RUN_DAYS * 86_400_000;
      const fresh = all.filter((i) => !seen.has(i.externalId));
      const items = firstRun ? fresh.filter((i) => i.publishedAt && new Date(i.publishedAt).getTime() >= cutoff) : fresh;

      return {
        items,
        state: { seen: rememberSeen(state.seen ?? [], all.map((i) => i.externalId), 500) },
      };
    },
  };
}
