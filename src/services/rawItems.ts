import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rawItems, sources } from '../db/schema.js';

export interface RecentRawItem {
  source: string;
  title: string | null;
  url: string | null;
  fetchedAt: string;
  keywordHit: string | null;
  llmStatus: string;
}

/** 최근 수집 원문 (/최근수집, 관리 화면). 본문은 넣지 않는다. */
export async function listRecentRawItems(db: Db, limit = 15): Promise<RecentRawItem[]> {
  return db
    .select({
      source: sources.name,
      title: rawItems.title,
      url: rawItems.url,
      fetchedAt: rawItems.fetchedAt,
      keywordHit: rawItems.keywordHit,
      llmStatus: rawItems.llmStatus,
    })
    .from(rawItems)
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .orderBy(desc(rawItems.id))
    .limit(limit);
}
