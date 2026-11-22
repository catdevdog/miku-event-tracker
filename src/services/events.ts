import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, eventSources, EVENT_REGIONS, rawItems, sources } from '../db/schema.js';

export type EventRegion = (typeof EVENT_REGIONS)[number];

/** 조회 범위. domestic=KR, japan=JP, overseas=OTHER(일본 제외 해외), all=전체 */
export const EVENT_SCOPES = ['all', 'domestic', 'japan', 'overseas'] as const;
export type EventScope = (typeof EVENT_SCOPES)[number];
const SCOPE_REGION: Record<EventScope, EventRegion | undefined> = { all: undefined, domestic: 'KR', japan: 'JP', overseas: 'OTHER' };

/** 알 수 없는 값은 전체로 */
export function parseEventScope(v: string | null | undefined): EventScope {
  return (EVENT_SCOPES as readonly string[]).includes(v ?? '') ? (v as EventScope) : 'all';
}

/**
 * 다가오는(또는 진행 중인) 확정 행사. 슬래시 명령, 추후 멘션 질의·공개 웹이 같이 쓴다.
 * 검수 대기·종료·취소는 뺀다. 시작일 미정은 뒤로.
 */
export async function listUpcomingEvents(db: Db, opts: { scope?: EventScope; limit?: number } = {}) {
  const region = SCOPE_REGION[opts.scope ?? 'all'];
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.needsReview, 0),
        sql`${events.status} NOT IN ('ended','cancelled')`,
        region ? eq(events.region, region) : undefined,
      ),
    )
    .orderBy(sql`${events.startDate} IS NULL`, asc(events.startDate), asc(events.id))
    .limit(opts.limit ?? 25);
}

/**
 * 행사별 대표 링크: 예매 URL, 없으면 가장 최근 원문 URL. 네이버 검색 결과 링크는 쓰지 않는다(약관).
 * /행사 카드의 버튼에 쓴다.
 */
export async function eventLinks(db: Db, rows: Pick<typeof events.$inferSelect, 'id' | 'ticketUrl'>[]): Promise<Map<number, string>> {
  const links = new Map<number, string>();
  const need: number[] = [];
  for (const r of rows) {
    if (r.ticketUrl) links.set(r.id, r.ticketUrl);
    else need.push(r.id);
  }
  if (need.length === 0) return links;
  const src = await db
    .select({ eventId: eventSources.eventId, url: rawItems.url })
    .from(eventSources)
    .innerJoin(rawItems, eq(rawItems.id, eventSources.rawItemId))
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(and(inArray(eventSources.eventId, need), ne(sources.adapter, 'naver')))
    .orderBy(desc(eventSources.createdAt));
  for (const s of src) if (s.url && !links.has(s.eventId)) links.set(s.eventId, s.url);
  return links;
}
