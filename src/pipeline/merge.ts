import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventSources, eventStateLog, events } from '../db/schema.js';
import type { Extraction, MatchCandidate, MatchResult, Presale } from './extract.js';
import { actionUrl, mayReplaceLink } from './links.js';
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

/** events.aliases (JSON 배열) */
export function parseAliases(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 제목과 다른 표기(별칭) 중 가장 비슷한 것의 유사도 */
export function bestTitleSimilarity(e: Pick<EventRow, 'title' | 'aliases'>, title: string): number {
  return Math.max(titleSimilarity(e.title, title), ...parseAliases(e.aliases).map((a) => titleSimilarity(a, title)));
}

/** events.presales (JSON 배열) */
export function parsePresales(json: string | null | undefined): Presale[] {
  try {
    const v = JSON.parse(json ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is Presale => !!p && typeof (p as Presale).label === 'string');
  } catch {
    return [];
  }
}

/** 선예매 일정 합치기: 이름이 같으면 새 값으로 바꾸고, 새 이름은 추가한다 (5개까지, 시작 시각 순) */
export function mergePresales(existing: Presale[], incoming: Presale[]): Presale[] {
  const out = [...existing];
  for (const p of incoming) {
    const i = out.findIndex((x) => normalizeKey(x.label) === normalizeKey(p.label));
    if (i >= 0) out[i] = { label: out[i]!.label, open_at: p.open_at ?? out[i]!.open_at, close_at: p.close_at ?? out[i]!.close_at };
    else out.push(p);
  }
  return out.sort((a, b) => (a.open_at ?? a.close_at ?? '').localeCompare(b.open_at ?? b.close_at ?? '')).slice(0, 5);
}

/** 알릴 만한 변경 (일정·장소). 표시용 문구는 notify 쪽에서 만든다 */
export interface NotableChange {
  field: 'dates' | 'venue';
  from: string | null;
  to: string | null;
}

const period = (e: Pick<EventRow, 'startDate' | 'endDate'>) => (e.startDate ? `${e.startDate}~${e.endDate ?? e.startDate}` : null);

/** 글자 종류: 한글·가나(한자 포함)·라틴 중 가장 많은 것 */
function script(s: string): 'ko' | 'ja' | 'latin' {
  const ko = (s.match(/[\uac00-\ud7af]/g) ?? []).length;
  const ja = (s.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length;
  const la = (s.match(/[a-z]/gi) ?? []).length;
  return ko >= ja && ko >= la ? 'ko' : ja >= la ? 'ja' : 'latin';
}

/**
 * 같은 장소의 다른 표기로 볼 수 있는지: 언어가 다르거나(롯데콘서트홀 ↔ LOTTE Concert Hall),
 * 한쪽이 다른 쪽을 포함하거나(킨텍스 ↔ 일산 킨텍스 제2전시장), 글자가 꽤 겹치는 경우.
 */
export function sameVenueName(a: string, b: string): boolean {
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  if (!x || !y) return false;
  return x === y || script(a) !== script(b) || x.includes(y) || y.includes(x) || titleSimilarity(a, b) >= 0.3;
}

/**
 * 일정·장소가 바뀌었는지. 장소는 표기만 다른 경우를 변경으로 보지 않는다(sameVenueName).
 * 값이 없어지는 변경(→ 미정)은 알리지 않는다.
 */
export function notableChanges(before: Pick<EventRow, 'startDate' | 'endDate' | 'venue'>, after: Pick<EventRow, 'startDate' | 'endDate' | 'venue'>): NotableChange[] {
  const out: NotableChange[] = [];
  const a = period(before);
  const b = period(after);
  if (b && a !== b) out.push({ field: 'dates', from: a, to: b });
  if (after.venue && (!before.venue || !sameVenueName(before.venue, after.venue))) {
    out.push({ field: 'venue', from: before.venue, to: after.venue });
  }
  return out;
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 두 기간이 겹치는지 (slack일 여유). 한쪽이라도 시작일이 없으면 false */
export function periodsOverlap(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null, slack = 0): boolean {
  if (!aStart || !bStart) return false;
  return aStart <= addDays(bEnd ?? bStart, slack) && bStart <= addDays(aEnd ?? aStart, slack);
}

const sameVenueAs = (ext: Extraction, c: Pick<EventRow, 'venue'>) => !!ext.venue && normalizeKey(c.venue) !== '' && normalizeKey(c.venue) === normalizeKey(ext.venue);

async function findEventRow(db: Db, ext: Extraction): Promise<EventRow | undefined> {
  const key = dedupKey(ext.title, ext.start_date, ext.venue);
  const [exact] = await db.select().from(events).where(eq(events.dedupKey, key)).limit(1);
  if (exact) return exact;

  // 같은 지역, 또는 지역이 다르게 뽑혔어도 시작일이 같은 행사(장소로 확인)
  const candidates = await db
    .select()
    .from(events)
    .where(ext.start_date ? or(eq(events.region, ext.region), eq(events.startDate, ext.start_date)) : eq(events.region, ext.region))
    .orderBy(desc(events.updatedAt))
    .limit(400);

  let best: { e: EventRow; sim: number } | undefined;
  for (const c of candidates) {
    const sim = bestTitleSimilarity(c, ext.title);
    const sameRegion = c.region === ext.region;
    const sameDate = !!ext.start_date && c.startDate === ext.start_date;
    const sameVenue = sameVenueAs(ext, c);
    let ok: boolean;
    if (!sameRegion) ok = sameDate && sameVenue && sim >= 0.5; // 지역만 다르게 뽑힌 경우
    else if (sameDate) ok = (sameVenue && sim >= 0.3) || sim >= 0.5;
    else if (!ext.start_date || !c.startDate) ok = sim >= 0.6; // 한쪽 일정 미정
    else ok = periodsOverlap(ext.start_date, ext.end_date, c.startDate, c.endDate) && sim >= 0.6; // 시작일이 다르게 뽑혔지만 기간이 겹침
    if (ok && (!best || sim > best.sim)) best = { e: c, sim };
  }
  return best?.e;
}

export const MATCH_CANDIDATE_LIMIT = 6;
/** 같은 행사로 확정하는 확신도. 이보다 낮은 same은 중복 의심으로 관리자에게 묻는다 */
export const MATCH_CONFIRM = 0.8;
export const MATCH_SUSPECT = 0.5;
/** 기간이 안 겹쳐도 후보로 넣는 제목 유사도 (일정 변경·연기 확인용) */
export const RESCHEDULE_SIM = 0.75;

/**
 * 제목으로는 못 찾았을 때 Claude에게 물어볼 후보: 기간이 겹치거나(하루 여유) 한쪽 일정이 미정이거나 제목이 거의 같으면서(일정 변경),
 * 지역이 같거나 장소가 같은 행사. 언어가 다른 제목은 글자가 안 겹치므로 제목 유사도를 조건으로 쓰지 않고 순서에만 쓴다.
 */
export async function findMatchCandidates(db: Db, ext: Extraction): Promise<EventRow[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(isNull(events.mergedInto), sql`${events.needsReview} <> 2`))
    .orderBy(desc(events.updatedAt))
    .limit(500);
  const scored: { e: EventRow; score: number }[] = [];
  for (const c of rows) {
    const sameVenue = sameVenueAs(ext, c);
    if (c.region !== ext.region && !sameVenue) continue;
    const sim = bestTitleSimilarity(c, ext.title);
    const undated = !ext.start_date || !c.startDate;
    // 일정이 연기·변경된 행사: 기간은 안 겹치지만 제목이 거의 같고 시작일이 넉 달 안쪽
    const rescheduled = !undated && sim >= RESCHEDULE_SIM && Math.abs(Date.parse(ext.start_date!) - Date.parse(c.startDate!)) <= 120 * 86_400_000;
    if (undated ? !(sameVenue || sim >= 0.2) : !periodsOverlap(ext.start_date, ext.end_date, c.startDate, c.endDate, 1) && !rescheduled) continue;
    const score = sim * 3 + (sameVenue ? 2 : 0) + (c.kind === ext.kind ? 1 : 0) + (!!ext.start_date && c.startDate === ext.start_date ? 1 : 0);
    scored.push({ e: c, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MATCH_CANDIDATE_LIMIT).map((s) => s.e);
}

export const toMatchCandidate = (e: EventRow): MatchCandidate => ({
  id: e.id, title: e.title, aliases: parseAliases(e.aliases), kind: e.kind, region: e.region, city: e.city, venue: e.venue, startDate: e.startDate, endDate: e.endDate,
});

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
  /** 원문 주소·어댑터 (행동 링크 검사용) */
  item?: { url?: string | null; adapter?: string };
  /** 새 행사를 만들기 직전에 같은 행사인지 Claude에게 묻는다 (없으면 묻지 않음) */
  matcher?: (ext: Extraction, candidates: MatchCandidate[]) => Promise<MatchResult>;
}

export interface MergeResult {
  event: EventRow;
  created: boolean;
  /** 상태가 바뀌었으면 이전 상태 (새 행사면 null) */
  statusFrom: EventStatus | null;
  statusChanged: boolean;
  /** 확신이 높은 출처가 확인해 검수 대기가 풀렸으면 true (새 행사처럼 알린다) */
  reviewCleared?: boolean;
  /** 기존 행사의 일정·장소가 바뀌었으면 그 내용 */
  changes?: NotableChange[];
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
    // 소개 글·기사·SNS 주소, 원문 자체 주소는 행동 링크로 쓰지 않는다
    ticketUrl: actionUrl(ext.ticket_url, ctx.item),
  };
  let existing = await findExistingEvent(db, ext);

  // 제목으로 못 찾았으면(언어가 다른 제목, 일정이 다르게 뽑힌 경우) 기간이 겹치는 행사 중에 같은 행사가 있는지 묻는다
  let dupOfId: number | null = null;
  let parentFromMatch: number | null = null;
  if (!existing && ctx.matcher) {
    const candidates = await findMatchCandidates(db, ext);
    if (candidates.length > 0) {
      const m = await ctx.matcher(ext, candidates.map(toMatchCandidate));
      const hit = candidates.find((c) => c.id === m.matchId);
      if (hit && m.relation === 'same' && m.confidence >= MATCH_CONFIRM) existing = hit;
      else if (hit && m.relation === 'same' && m.confidence >= MATCH_SUSPECT) dupOfId = hit.id;
      else if (hit && m.relation === 'part_of' && (ext.kind === 'booth' || ext.kind === 'stage' || ext.parent_event_hint)) parentFromMatch = hit.id;
    }
  }

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
        parentEventId: (await findParent(db, ext.parent_event_hint)) ?? parentFromMatch,
        summaryKo: ext.summary_ko,
        dedupKey: dedupKey(ext.title, ext.start_date, ext.venue),
        // 중복 의심이면 공지하지 않고 관리자에게 [합치기]·[별개 행사]를 묻는다
        needsReview: ctx.needsReview || dupOfId ? 1 : 0,
        dupOfId,
        presales: JSON.stringify(ext.presales ?? []),
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
  // 여러 날 행사의 하루만 적은 출처(둘째 날 공연 안내 등)가 기간을 줄이지 않게, 기존 기간 안에 들어가는 일정은 덮어쓰지 않는다
  const exEnd = existing.endDate ?? existing.startDate;
  const inEnd = incoming.endDate ?? incoming.startDate;
  const withinExisting =
    !!existing.startDate && !!incoming.startDate && incoming.startDate >= existing.startDate && inEnd! <= exEnd! && !(incoming.startDate === existing.startDate && inEnd === exEnd);
  for (const f of UPDATABLE) {
    const v = incoming[f];
    if (withinExisting && (f === 'startDate' || f === 'endDate')) continue;
    // 같은 장소의 다른 언어 표기로는 바꾸지 않는다 (출처마다 표기가 달라 왔다 갔다 하는 것을 막는다)
    if (f === 'venue' && existing.venue && typeof v === 'string' && script(existing.venue) !== script(v)) continue;
    if (v !== null && v !== undefined && v !== existing[f]) {
      // 예매처 링크는 예매처 링크로만 바꾼다
      if (f === 'ticketUrl' && !mayReplaceLink(existing.ticketUrl, v)) continue;
      changed[f] = [existing[f], v];
      updates[f] = v;
    }
  }
  // 다른 출처의 제목 표기를 별칭으로 남긴다 (다음 비교에 쓴다)
  const known = [existing.title, ...parseAliases(existing.aliases)];
  if (!known.some((t) => normalizeKey(t) === normalizeKey(ext.title)) && known.length <= 12) {
    updates.aliases = JSON.stringify([...known.slice(1), ext.title]);
  }
  if (existing.kind === 'other' && ext.kind !== 'other') (updates.kind = ext.kind), (changed.kind = [existing.kind, ext.kind]);
  if (existing.officiality === 'unverified' && ext.officiality !== 'unverified') {
    updates.officiality = ext.officiality;
    changed.officiality = [existing.officiality, ext.officiality];
  }
  if (!existing.summaryKo && ext.summary_ko) updates.summaryKo = ext.summary_ko;
  // 확신이 높은 출처가 확인해 주면 검수 대기를 푼다
  if (ext.presales?.length) {
    const next = JSON.stringify(mergePresales(parsePresales(existing.presales), ext.presales));
    if (next !== existing.presales) (updates.presales = next), (changed.presales = [existing.presales, next]);
  }
  // (중복 의심으로 대기 중인 행사는 관리자가 정할 때까지 풀지 않는다)
  if (existing.needsReview === 1 && !ctx.needsReview && existing.dupOfId == null) (updates.needsReview = 0), (changed.needsReview = [1, 0]);
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
  return {
    event: event!,
    created: false,
    statusFrom: existing.status,
    statusChanged,
    reviewCleared: updates.needsReview === 0,
    changes: notableChanges(existing, event!),
  };
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

/**
 * 이미 저장된 행동 링크 정리 (시작할 때 한 번, 여러 번 돌려도 결과가 같다).
 * 링크 검사를 넣기 전에 들어간 소개 글·기사·SNS 주소, 원문 자체 주소를 비운다. 원문은 '원문 보기'로 계속 보인다.
 * @returns 비운 행사 수
 */
export async function cleanupActionLinks(db: Db): Promise<number> {
  const rows = await db.all<{ id: number; ticket_url: string }>(sql`SELECT id, ticket_url FROM events WHERE ticket_url IS NOT NULL`);
  let cleared = 0;
  for (const r of rows) {
    const srcs = await db.all<{ url: string | null; adapter: string }>(sql`
      SELECT ri.url AS url, s.adapter AS adapter FROM event_sources es
      JOIN raw_items ri ON ri.id = es.raw_item_id JOIN sources s ON s.id = ri.source_id
      WHERE es.event_id = ${r.id}
    `);
    const fromTicketSource = srcs.some((s) => s.adapter === 'ticket' || s.adapter === 'kopis');
    const ok = actionUrl(r.ticket_url) !== null && (fromTicketSource || srcs.every((s) => actionUrl(r.ticket_url, { url: s.url, adapter: s.adapter }) !== null));
    if (ok) continue;
    await db.update(events).set({ ticketUrl: null }).where(eq(events.id, r.id));
    cleared++;
  }
  return cleared;
}
