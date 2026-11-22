import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { AdapterRegistry, SourceAdapter } from './types.js';
import type { ImplementedAdapter } from './implemented.js';
import { createRssAdapter } from './rss.js';
import { createHtmlDiffAdapter } from './htmlDiff.js';
import { renderHtml } from './render.js';
import { createTicketAdapter } from './ticket.js';
import { createKopisAdapter } from './kopis.js';
import { createXCrawlAdapter, twitterScraperDeps } from './xCrawl.js';
import { createNaverAdapter } from './naver.js';
import { loadKeywordSet } from '../pipeline/keywordFilter.js';

/**
 * 구현된 어댑터 목록. 키는 implemented.ts의 IMPLEMENTED_ADAPTERS와 같아야 한다(Record 타입으로 강제).
 * 여기에 없는 어댑터(instagram, playwright)의 소스는 실행 때 job_runs에 'skipped'로만 남는다. instagram은 6단계에서 추가한다.
 */
export function createAdapters(config: Config, db: Db): AdapterRegistry {
  const registry: Record<ImplementedAdapter, SourceAdapter> = {
    rss: createRssAdapter(),
    html_diff: createHtmlDiffAdapter({ renderHtml }),
    ticket: createTicketAdapter(),
    kopis: createKopisAdapter({ serviceKey: config.KOPIS_SERVICE_KEY, loadKeywords: () => loadKeywordSet(db) }),
    x_crawl: createXCrawlAdapter(twitterScraperDeps({ authToken: config.X_AUTH_TOKEN, ct0: config.X_CT0 })),
    naver: createNaverAdapter({ clientId: config.NAVER_CLIENT_ID, clientSecret: config.NAVER_CLIENT_SECRET }),
  };
  return registry;
}
