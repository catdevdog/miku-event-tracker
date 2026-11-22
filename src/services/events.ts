import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, EVENT_REGIONS } from '../db/schema.js';

export type EventRegion = (typeof EVENT_REGIONS)[number];

/**
 * 다가오는(또는 진행 중인) 확정 행사. 슬래시 명령, 추후 멘션 질의·공개 웹이 같이 쓴다.
 * 검수 대기·종료·취소는 뺀다. 시작일 미정은 뒤로.
 */
export async function listUpcomingEvents(db: Db, opts: { scope?: 'domestic' | 'overseas' | 'all'; limit?: number } = {}) {
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.needsReview, 0),
        sql`${events.status} NOT IN ('ended','cancelled')`,
        opts.scope === 'domestic' ? eq(events.region, 'KR') : opts.scope === 'overseas' ? ne(events.region, 'KR') : undefined,
      ),
    )
    .orderBy(sql`${events.startDate} IS NULL`, asc(events.startDate), asc(events.id))
    .limit(opts.limit ?? 25);
}
