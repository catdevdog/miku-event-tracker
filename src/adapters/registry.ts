import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { AdapterRegistry } from './types.js';
import { createRssAdapter } from './rss.js';
import { createHtmlDiffAdapter } from './htmlDiff.js';
import { renderHtml } from './render.js';
import { createTicketAdapter } from './ticket.js';
import { createKopisAdapter } from './kopis.js';
import { createXCrawlAdapter, twitterScraperDeps } from './xCrawl.js';
import { loadKeywordSet } from '../pipeline/keywordFilter.js';

/**
 * 구현된 어댑터 목록. 여기에 없는 어댑터(instagram, naver, playwright)의 소스는
 * 실행 때 job_runs에 'skipped'로만 남는다. instagram·naver는 6단계에서 추가한다.
 */
export function createAdapters(config: Config, db: Db): AdapterRegistry {
  return {
    rss: createRssAdapter(),
    html_diff: createHtmlDiffAdapter({ renderHtml }),
    ticket: createTicketAdapter(),
    kopis: createKopisAdapter({ serviceKey: config.KOPIS_SERVICE_KEY, loadKeywords: () => loadKeywordSet(db) }),
    x_crawl: createXCrawlAdapter(twitterScraperDeps({ authToken: config.X_AUTH_TOKEN, ct0: config.X_CT0 })),
  };
}
