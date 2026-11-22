import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventSources, eventStateLog, events } from '../db/schema.js';
import type { Extraction } from './extract.js';
import { deriveStatus, nextStatus, type EventStatus } from './state.js';

export type EventRow = typeof events.$inferSelect;

/** 비교용 정규화: NFKC → 소문자 → 글자·숫자만 */
export function normalizeKey(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** CLAUDE.md 규칙 5 */
export function dedupKey(title: string, startDate: string | null, venue: string | null): string {
  return `${normalizeKey(title)}|${startDate ?? ''}|${normalizeKey(venue)}`;
}

const bigrams = (s: string) => {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
};

/** 정규화한 제목의 글자 2개 묶음 유사도 (0~1) */
export function titleSimilarity(a: string, b: string): number {
  const A = bigrams(normalizeKey(a));
  const B = bigrams(normalizeKey(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 같은 행사를 찾는다. dedup_key가 같으면 바로, 아니면 출처마다 제목 표기가 달라지는 경우를 위해
 * 같은 시작일(또는 시작일 미정)·같은 지역의 행사 중 제목이 비슷한 것을 고른다.
 */
export async function findExistingEvent(db: Db, ext: Extraction): Promise<EventRow | undefined> {
  return followMerged(db, await findEventRow(db, ext));
}

/** /관리 합치기로 흡수된 행사(merged_into)면 남긴 행사로 바꾼다. 새 출처가 숨긴 행사에 붙지 않게 하기 위해서다. */
export async function followMerged(db: Db, e: EventRow | undefined): Promise<EventRow | undefined> {
  for (let i = 0; e?.mergedInto && i < 5; i++) {
    const [next] = await db.select().from(events).where(eq(events.id, e.mergedInto)).limit(1);
    if (!next) break;
    e = next;
  }
  return e;
}

async function findEventRow(db: Db, ext: Extraction): Promise<EventRow | undefined> {
  const key = dedupKey(ext.title, ext.start_date, ext.venue);
  const [exact] = await db.select().from(events).where(eq(events.dedupKey, key)).limit(1);
  if (exact) return exact;

  const dateCond = ext.start_date ? or(eq(events.startDate, ext.start_date), isNull(events.startDate)) : undefined;
  const candidates = await db
    .select()
    .from(events)
    .where(and(eq(events.region, ext.region), dateCond))
    .orderBy(desc(events.updatedAt))
    .limit(300);

  let best: { e: EventRow; sim: number } | undefined;
  for (const c of candidates) {
    const sim = titleSimilarity(c.title, ext.title);
    const sameDate = !!ext.start_date && c.startDate === ext.start_date;
    const sameVenue = !!ext.venue && normalizeKey(c.venue) === normalizeKey(ext.venue) && normalizeKey(c.venue) !== '';
    const ok = sameDate ? (sameVenue && sim >= 0.3) || sim >= 0.5 : sim >= 0.6;
    if (ok && (!best || sim > best.sim)) best = { e: c, sim };
  }
  return best?.e;
}

async function findParent(db: Db, hint: string | null, selfId?: number): Promise<number | null> {
  if (!hint) return null;
  const rows = await db.select({ id: events.id, title: events.title }).from(events).orderBy(desc(events.updatedAt)).limit(300);
  let best: { id: number; sim: number } | undefined;
  for (const r of rows) {
    if (r.id === selfId) continue;
    const sim = titleSimilarity(r.title, hint);
    if (sim >= 0.5 && (!best || sim > best.sim)) best = { id: r.id, sim };
  }
  return best?.id ?? null;
}

export interface MergeContext {
  rawItemId: number;
  model: string;
  needsReview: boolean;
  fromKopis: boolean;
  now: Date;
}

export interface MergeResult {
  event: EventRow;
  created: boolean;
  /** 상태가 바뀌었으면 이전 상태 (새 행사면 null) */
  statusFrom: EventStatus | null;
  statusChanged: boolean;
  /** 확신이 높은 출처가 확인해 검수 대기가 풀렸으면 true (새 행사처럼 알린다) */
  reviewCleared?: boolean;
}

const UPDATABLE = ['city', 'venue', 'startDate', 'endDate', 'ticketOpenAt', 'ticketUrl'] as const;

/** 추출 결과를 행사에 반영한다 (새로 만들거나 기존 행사에 합친다). */
export async function mergeExtraction(db: Db, ext: Extraction, ctx: MergeContext): Promise<MergeResult> {
  const nowIso = ctx.now.toISOString();
  const incoming = {
    city: ext.city,
    venue: ext.venue,
    startDate: ext.start_date,
    endDate: ext.end_date ?? ext.start_date,
    ticketOpenAt: ext.ticket_open_at,
    ticketUrl: ext.ticket_url,
  };
  const existing = await findExistingEvent(db, ext);

  if (!existing) {
    const status = deriveStatus(
      { ...incoming, isCancelled: ext.is_cancelled, saleStarted: ext.sale_started, fromKopis: ctx.fromKopis },
      ctx.now,
    );
    const [event] = await db
      .insert(events)
      .values({
        title: ext.title,
        kind: ext.kind,
        officiality: ext.officiality,
        region: ext.region,
        ...incoming,
        status,
        parentEventId: await findParent(db, ext.parent_event_hint),
        summaryKo: ext.summary_ko,
        dedupKey: dedupKey(ext.title, ext.start_date, ext.venue),
        needsReview: ctx.needsReview ? 1 : 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();
    await db.insert(eventStateLog).values({ eventId: event!.id, fromStatus: null, toStatus: status, rawItemId: ctx.rawItemId, createdAt: nowIso });
    await linkSource(db, event!.id, ext, ctx);
    return { event: event!, created: true, statusFrom: null, statusChanged: true };
  }

  // 기존 행사 갱신: 새 값이 있고 다르면 덮어쓴다 (나중 정보가 더 정확하다고 본다)
  const changed: Record<string, [unknown, unknown]> = {};
  const updates: Partial<EventRow> = {};
  for (const f of UPDATABLE) {
    const v = incoming[f];
    if (v !== null && v !== undefined && v !== existing[f]) {
      changed[f] = [existing[f], v];
      updates[f] = v;
    }
  }
  if (existing.kind === 'other' && ext.kind !== 'other') (updates.kind = ext.kind), (changed.kind = [existing.kind, ext.kind]);
  if (existing.officiality === 'unverified' && ext.officiality !== 'unverified') {
    updates.officiality = ext.officiality;
    changed.officiality = [existing.officiality, ext.officiality];
  }
  if (!existing.summaryKo && ext.summary_ko) updates.summaryKo = ext.summary_ko;
  // 확신이 높은 출처가 확인해 주면 검수 대기를 푼다
  if (existing.needsReview === 1 && !ctx.needsReview) (updates.needsReview = 0), (changed.needsReview = [1, 0]);
  if (existing.parentEventId === null && ext.parent_event_hint) {
    const parent = await findParent(db, ext.parent_event_hint, existing.id);
    if (parent) updates.parentEventId = parent;
  }

  const merged = { ...existing, ...updates };
  const newKey = dedupKey(merged.title, merged.startDate, merged.venue);
  if (newKey !== existing.dedupKey) {
    const [clash] = await db.select({ id: events.id }).from(events).where(eq(events.dedupKey, newKey)).limit(1);
    if (!clash) updates.dedupKey = newKey;
  }

  const derived = deriveStatus(
    { ...merged, isCancelled: ext.is_cancelled, saleStarted: ext.sale_started, fromKopis: ctx.fromKopis },
    ctx.now,
  );
  const status = nextStatus(existing.status, derived);
  const statusChanged = status !== existing.status;
  if (statusChanged) updates.status = status;

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = nowIso;
    await db.update(events).set(updates).where(eq(events.id, existing.id));
  }
  if (statusChanged || Object.keys(changed).length > 0) {
    await db.insert(eventStateLog).values({
      eventId: existing.id,
      fromStatus: existing.status,
      toStatus: status,
      changedFields: Object.keys(changed).length ? JSON.stringify(changed) : null,
      rawItemId: ctx.rawItemId,
      createdAt: nowIso,
    });
  }
  await linkSource(db, existing.id, ext, ctx);
  const [event] = await db.select().from(events).where(eq(events.id, existing.id));
  return { event: event!, created: false, statusFrom: existing.status, statusChanged, reviewCleared: updates.needsReview === 0 };
}

async function linkSource(db: Db, eventId: number, ext: Extraction, ctx: MergeContext) {
  await db
    .insert(eventSources)
    .values({ eventId, rawItemId: ctx.rawItemId, extracted: JSON.stringify(ext), confidence: ext.confidence, model: ctx.model, createdAt: ctx.now.toISOString() })
    .onConflictDoNothing();
}

/** 시간이 지나 상태가 바뀌어야 하는 행사 (판매 시작·진행 중·종료) */
export async function sweepStatuses(db: Db, now: Date): Promise<{ event: EventRow; from: EventStatus }[]> {
  const rows = await db.select().from(events).where(sql`${events.status} NOT IN ('ended','cancelled')`);
  const changed: { event: EventRow; from: EventStatus }[] = [];
  for (const e of rows) {
    const next = nextStatus(e.status, deriveStatus(e, now));
    if (next === e.status) continue;
    const nowIso = now.toISOString();
    await db.update(events).set({ status: next, updatedAt: nowIso }).where(eq(events.id, e.id));
    await db.insert(eventStateLog).values({ eventId: e.id, fromStatus: e.status, toStatus: next, createdAt: nowIso });
    changed.push({ event: { ...e, status: next, updatedAt: nowIso }, from: e.status });
  }
  return changed;
}
