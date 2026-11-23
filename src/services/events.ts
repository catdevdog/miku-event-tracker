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
export async function listUpcomingEvents(db: Db, opts: { scope?: EventScope; limit?: number; kinds?: readonly string[] } = {}) {
  const region = SCOPE_REGION[opts.scope ?? 'all'];
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.needsReview, 0),
        sql`${events.status} NOT IN ('ended','cancelled')`,
        region ? eq(events.region, region) : undefined,
        opts.kinds?.length ? inArray(events.kind, opts.kinds as (typeof events.$inferSelect)['kind'][]) : undefined,
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

export interface EventDetail {
  event: typeof events.$inferSelect;
  /** 원문 링크 (네이버 검색 결과 제외, 최근 것부터) */
  sources: { name: string; url: string }[];
  /** 상태·필드 변경 이력 (최근 것부터) */
  history: { at: string; from: string | null; to: string; fields: string[] }[];
  parent?: { id: number; title: string };
}

/** /행사 검색 상세 */
export async function getEventDetail(db: Db, id: number): Promise<EventDetail | null> {
  const [event] = await db.select().from(events).where(eq(events.id, id));
  if (!event) return null;
  const srcRows = await db
    .select({ name: sources.name, url: rawItems.url, adapter: sources.adapter })
    .from(eventSources)
    .innerJoin(rawItems, eq(rawItems.id, eventSources.rawItemId))
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(eq(eventSources.eventId, id))
    .orderBy(desc(eventSources.createdAt));
  const seen = new Set<string>();
  const srcs = srcRows
    .filter((r) => r.url && r.adapter !== 'naver' && !seen.has(r.url) && seen.add(r.url))
    .map((r) => ({ name: r.name, url: r.url! }));
  const log = await db.all<{ created_at: string; from_status: string | null; to_status: string; changed_fields: string | null }>(sql`
    SELECT created_at, from_status, to_status, changed_fields FROM event_state_log WHERE event_id = ${id} ORDER BY id DESC LIMIT 6
  `);
  const history = log.map((l) => {
    let fields: string[] = [];
    try {
      fields = Object.keys((JSON.parse(l.changed_fields ?? '{}') as Record<string, unknown>) ?? {}).filter((k) => k !== 'by');
    } catch {
      /* 형식이 다른 옛 기록 */
    }
    return { at: l.created_at, from: l.from_status, to: l.to_status, fields };
  });
  let parent: EventDetail['parent'];
  if (event.parentEventId) {
    const [p] = await db.select({ id: events.id, title: events.title }).from(events).where(eq(events.id, event.parentEventId));
    if (p) parent = p;
  }
  return { event, sources: srcs, history, ...(parent ? { parent } : {}) };
}
