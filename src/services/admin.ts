import { and, asc, desc, eq, isNull, like, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { EVENT_KINDS, KEYWORD_TIERS, eventAttendees, eventSources, eventStateLog, eventWatchers, events, keywords, notifications, sources } from '../db/schema.js';
import { detectLang } from '../db/seed.js';
import { normalizeKey, notableChanges, parseAliases, type EventRow, type NotableChange } from '../pipeline/merge.js';
import { deriveStatus, type EventStatus } from '../pipeline/state.js';

/**
 * /관리 명령의 DB 작업. 시드가 매 시작마다 덮어쓰는 필드(enabled, tier)는 건드리지 않고
 * 따로 둔 필드(sources.paused, keywords.disabled)를 쓴다. 재배포해도 관리자 설정이 유지된다.
 */

// ── 수집처 ────────────────────────────────────────────────

export async function sourceChoices(db: Db, q: string): Promise<{ name: string; value: string }[]> {
  const rows = await db
    .select({ name: sources.name, enabled: sources.enabled, paused: sources.paused })
    .from(sources)
    .where(and(ne(sources.adapter, 'manual'), q ? like(sources.name, `%${q}%`) : undefined))
    .orderBy(asc(sources.id))
    .limit(25);
  return rows.map((r) => ({ name: `${r.enabled ? (r.paused ? '⏸️' : '▶️') : '⚫'} ${r.name}`, value: r.name }));
}

export type SourceAction = 'pause' | 'resume' | 'run';

/** 멈춤·재개·지금 수집(다음 1분 틱에 실행). 결과 문장을 돌려준다 */
export async function sourceAction(db: Db, name: string, action: SourceAction): Promise<string> {
  const [s] = await db.select().from(sources).where(and(eq(sources.name, name), ne(sources.adapter, 'manual')));
  if (!s) return `"${name}" 수집처를 찾을 수 없어요. 목록에서 골라 주세요.`;
  if (s.enabled !== 1 || s.target === 'TODO') return `**${s.name}**은(는) 시드에서 꺼 둔 수집처라(주소·형식 미확인) 여기서 켤 수 없어요.`;
  if (action === 'pause') {
    await db.update(sources).set({ paused: 1 }).where(eq(sources.id, s.id));
    return `⏸️ **${s.name}** 수집을 멈췄어요. 재배포해도 유지돼요.`;
  }
  if (action === 'resume') {
    await db.update(sources).set({ paused: 0, lastRunAt: null }).where(eq(sources.id, s.id));
    return `▶️ **${s.name}** 수집을 다시 시작해요 (1분 안에 실행).`;
  }
  if (s.paused === 1) return `**${s.name}**은(는) 멈춘 상태예요. 먼저 재개해 주세요.`;
  await db.update(sources).set({ lastRunAt: null }).where(eq(sources.id, s.id));
  return `🔄 **${s.name}**을(를) 1분 안에 수집해요. 결과는 \`/소스\`·\`/최근수집\`에서 볼 수 있어요.`;
}

// ── 키워드 ────────────────────────────────────────────────

export type KeywordTier = (typeof KEYWORD_TIERS)[number];
export const TIER_KO: Record<KeywordTier, string> = { strong: '강(단독 통과)', weak: '약(맥락과 함께)', context: '맥락', exclude: '제외' };

export async function addKeyword(db: Db, term: string, tier: KeywordTier): Promise<string> {
  const t = term.trim();
  if (t.length < 2 || t.length > 40) return '키워드는 2~40자로 입력해 주세요.';
  await db
    .insert(keywords)
    .values({ term: t, tier, lang: detectLang(t), disabled: 0 })
    .onConflictDoUpdate({ target: keywords.term, set: { tier, disabled: 0 } });
  return `➕ 키워드 **${t}** → ${TIER_KO[tier]}. 다음 판정부터 적용돼요.\n-# seed/keywords.json에 같은 단어가 있으면 재배포 때 시드의 등급으로 돌아가요.`;
}

export async function removeKeyword(db: Db, term: string): Promise<string> {
  const t = term.trim();
  const [k] = await db.select().from(keywords).where(eq(keywords.term, t));
  if (!k || k.disabled === 1) return `**${t}**은(는) 사전에 없어요.`;
  await db.update(keywords).set({ disabled: 1 }).where(eq(keywords.id, k.id));
  return `➖ 키워드 **${t}**(${TIER_KO[k.tier]})를 뺐어요. 재배포해도 다시 켜지지 않아요. 다시 쓰려면 추가하세요.`;
}

export async function listKeywords(db: Db): Promise<Record<KeywordTier, string[]>> {
  const rows = await db.select({ term: keywords.term, tier: keywords.tier }).from(keywords).where(eq(keywords.disabled, 0)).orderBy(asc(keywords.id));
  const out: Record<KeywordTier, string[]> = { strong: [], weak: [], context: [], exclude: [] };
  for (const r of rows) out[r.tier].push(r.term);
  return out;
}

// ── 행사 ──────────────────────────────────────────────────

const REGION_SHORT: Record<string, string> = { KR: '국내', JP: '일본', OTHER: '해외' };

/** 자동완성 후보 "#12 · 12.04 · AGF 2026 미쿠 부스 (국내)". publicOnly면 숨김·검수 대기·합쳐진 행사 제외 */
export async function eventChoices(db: Db, q: string, opts: { publicOnly?: boolean } = {}): Promise<{ name: string; value: string }[]> {
  const term = q.trim().replace(/^#/, '');
  const idMatch = /^\d+$/.test(term) ? eq(events.id, Number(term)) : undefined;
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        isNull(events.mergedInto),
        opts.publicOnly ? eq(events.needsReview, 0) : undefined,
        term ? (idMatch ? or(idMatch, like(events.title, `%${term}%`)) : like(events.title, `%${term}%`)) : undefined,
      ),
    )
    // 다가오는 행사 먼저, 그다음 최근 갱신
    .orderBy(sql`CASE WHEN ${events.status} IN ('ended','cancelled') THEN 1 ELSE 0 END`, desc(events.updatedAt))
    .limit(25);
  return rows.map((e) => ({ name: eventLabel(e), value: String(e.id) }));
}

export function eventLabel(e: Pick<EventRow, 'id' | 'title' | 'startDate' | 'region' | 'needsReview'>): string {
  const date = e.startDate ? e.startDate.slice(5).replace('-', '.') : '미정';
  const flag = e.needsReview === 2 ? ' · 숨김' : e.needsReview === 1 ? ' · 검수 대기' : '';
  return `#${e.id} · ${date} · ${e.title} (${REGION_SHORT[e.region] ?? e.region}${flag})`.slice(0, 100);
}

export async function getEvent(db: Db, id: number): Promise<EventRow | undefined> {
  const [e] = await db.select().from(events).where(eq(events.id, id));
  return e;
}

/** 수정 입력 창 기본값 */
export function editDefaults(e: EventRow): Record<string, string> {
  return {
    title: e.title,
    dates: e.startDate ? (e.endDate && e.endDate !== e.startDate ? `${e.startDate} ~ ${e.endDate}` : e.startDate) : '',
    venue: [e.city, e.venue].filter(Boolean).join(' / '),
    ticket_open: e.ticketOpenAt ? kstInput(e.ticketOpenAt) : '',
    ticket_url: e.ticketUrl ?? '',
  };
}

/** UTC ISO → "2026-12-01 20:00" (한국 시간) */
export function kstInput(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface EventEdit {
  title?: string;
  dates?: string;
  venue?: string;
  ticket_open?: string;
  ticket_url?: string;
}

/** 입력 창 값 → 행사 필드. 형식이 틀리면 오류 문장 */
export function parseEventEdit(input: EventEdit): { fields: Partial<EventRow> } | { error: string } {
  const fields: Partial<EventRow> = {};
  const title = input.title?.trim();
  if (title !== undefined) {
    if (!title) return { error: '제목은 비울 수 없어요.' };
    fields.title = title.slice(0, 200);
  }
  if (input.dates !== undefined) {
    const d = input.dates.trim();
    if (!d) {
      fields.startDate = null;
      fields.endDate = null;
    } else {
      const [s, e] = d.split(/\s*~\s*/);
      if (!s || !YMD.test(s) || (e && !YMD.test(e))) return { error: '일정은 `2026-12-04` 또는 `2026-12-04 ~ 2026-12-06` 형식으로 써 주세요.' };
      if (e && e < s) return { error: '끝나는 날이 시작일보다 빨라요.' };
      fields.startDate = s;
      fields.endDate = e ?? s;
    }
  }
  if (input.venue !== undefined) {
    const v = input.venue.trim();
    const [city, ...rest] = v.split(/\s*\/\s*/);
    if (!v) {
      fields.city = null;
      fields.venue = null;
    } else if (rest.length) {
      fields.city = city || null;
      fields.venue = rest.join(' / ') || null;
    } else {
      fields.venue = v;
    }
  }
  if (input.ticket_open !== undefined) {
    const t = input.ticket_open.trim();
    if (!t) fields.ticketOpenAt = null;
    else {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
      if (!m) return { error: '티켓 오픈은 한국 시간 `2026-12-01 20:00` 형식으로 써 주세요.' };
      fields.ticketOpenAt = new Date(Date.parse(`${m[1]}T${m[2]}:${m[3]}:00+09:00`)).toISOString();
    }
  }
  if (input.ticket_url !== undefined) {
    const u = input.ticket_url.trim();
    if (!u) fields.ticketUrl = null;
    else {
      try {
        const url = new URL(u);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      } catch {
        return { error: '예매 링크는 http(s) 주소로 써 주세요.' };
      }
      fields.ticketUrl = u;
    }
  }
  return { fields };
}

export interface EditResult {
  event: EventRow;
  changed: string[];
  statusChanged: boolean;
  /** 알릴 만한 일정·장소 변경 */
  notable: NotableChange[];
}

/**
 * 관리자 수정. 바뀐 필드를 event_state_log에 남기고, 상태는 고친 값으로 다시 계산한다
 * (잘못 들어간 티켓 일정을 고치는 경우가 있으므로 앞으로만 가는 규칙을 적용하지 않음. 취소는 유지).
 */
export async function editEvent(db: Db, id: number, fields: Partial<EventRow>, by: string, now = new Date()): Promise<EditResult | null> {
  const e = await getEvent(db, id);
  if (!e) return null;
  const keys = ['title', 'startDate', 'endDate', 'city', 'venue', 'ticketOpenAt', 'ticketUrl'] as const;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (k in fields && fields[k] !== e[k]) changes[k] = { from: e[k], to: fields[k] };
  }
  const next = { ...e, ...fields };
  const status: EventStatus =
    e.status === 'cancelled'
      ? 'cancelled'
      : deriveStatus({ startDate: next.startDate, endDate: next.endDate, ticketOpenAt: next.ticketOpenAt, saleStarted: e.status === 'on_sale' && !next.ticketOpenAt }, now);
  if (Object.keys(changes).length === 0 && status === e.status) return { event: e, changed: [], statusChanged: false, notable: [] };
  const nowIso = now.toISOString();
  const [updated] = await db
    .update(events)
    .set({ ...Object.fromEntries(Object.keys(changes).map((k) => [k, fields[k as keyof EventRow]])), status, updatedAt: nowIso })
    .where(eq(events.id, id))
    .returning();
  await db.insert(eventStateLog).values({
    eventId: id,
    fromStatus: e.status,
    toStatus: status,
    changedFields: JSON.stringify({ ...changes, by: `admin:${by}` }),
    createdAt: nowIso,
  });
  return { event: updated!, changed: Object.keys(changes), statusChanged: status !== e.status, notable: notableChanges(e, updated!) };
}

/** 숨기기(needs_review=2)·다시 보이기(0). 숨긴 국내 행사는 서버 이벤트에서도 지워진다 */
export async function setEventHidden(db: Db, id: number, hidden: boolean, now = new Date()): Promise<EventRow | null> {
  const [e] = await db
    .update(events)
    .set({ needsReview: hidden ? 2 : 0, updatedAt: now.toISOString() })
    .where(eq(events.id, id))
    .returning();
  return e ?? null;
}

/**
 * 합치기: absorb 행사의 출처·하위 행사·개인 리마인더를 keep으로 옮기고, keep에 비어 있는 필드를 채운다.
 * absorb는 숨기고(needs_review=2) merged_into=keep으로 둬서 이후 같은 제목의 새 출처도 keep으로 간다.
 */
export async function mergeEvents(db: Db, keepId: number, absorbId: number, by: string, now = new Date()): Promise<string> {
  if (keepId === absorbId) return '같은 행사를 골랐어요.';
  const keep = await getEvent(db, keepId);
  const absorb = await getEvent(db, absorbId);
  if (!keep || !absorb) return '행사를 찾을 수 없어요.';
  if (keep.mergedInto) return `#${keep.id}은(는) 이미 다른 행사에 합쳐졌어요. 남길 행사로 #${keep.mergedInto}을(를) 고르세요.`;
  if (absorb.mergedInto) return `#${absorb.id}은(는) 이미 #${absorb.mergedInto}에 합쳐졌어요.`;
  const nowIso = now.toISOString();

  await db.run(sql`
    INSERT OR IGNORE INTO event_sources (event_id, raw_item_id, extracted, confidence, model, created_at)
    SELECT ${keepId}, raw_item_id, extracted, confidence, model, created_at FROM event_sources WHERE event_id = ${absorbId}
  `);
  await db.delete(eventSources).where(eq(eventSources.eventId, absorbId));
  await db.run(sql`INSERT OR IGNORE INTO event_watchers (event_id, user_id, created_at) SELECT ${keepId}, user_id, created_at FROM event_watchers WHERE event_id = ${absorbId}`);
  await db.delete(eventWatchers).where(eq(eventWatchers.eventId, absorbId));
  await db.run(sql`INSERT OR IGNORE INTO event_attendees (event_id, user_id, created_at) SELECT ${keepId}, user_id, created_at FROM event_attendees WHERE event_id = ${absorbId}`);
  await db.delete(eventAttendees).where(eq(eventAttendees.eventId, absorbId));
  await db.update(events).set({ parentEventId: keepId }).where(eq(events.parentEventId, absorbId));

  const fill: Partial<EventRow> = {};
  for (const k of ['city', 'venue', 'startDate', 'endDate', 'ticketOpenAt', 'ticketUrl', 'summaryKo'] as const) {
    if (keep[k] == null && absorb[k] != null) (fill as Record<string, unknown>)[k] = absorb[k];
  }
  // 흡수한 행사의 제목·별칭을 남긴 행사의 별칭으로 (다음에 같은 표기가 오면 바로 찾는다)
  const names = [keep.title, ...parseAliases(keep.aliases)];
  for (const t of [absorb.title, ...parseAliases(absorb.aliases)]) {
    if (!names.some((n) => normalizeKey(n) === normalizeKey(t)) && names.length <= 12) names.push(t);
  }
  await db.update(events).set({ ...fill, aliases: JSON.stringify(names.slice(1)), updatedAt: nowIso }).where(eq(events.id, keepId));
  await db.update(events).set({ needsReview: 2, mergedInto: keepId, dupOfId: null, updatedAt: nowIso }).where(eq(events.id, absorbId));
  // 흡수한 행사의 아직 안 보낸 알림은 보내지 않는다
  await db.delete(notifications).where(and(eq(notifications.eventId, absorbId), eq(notifications.status, 'queued')));
  await db.insert(eventStateLog).values({
    eventId: keepId,
    fromStatus: keep.status,
    toStatus: keep.status,
    changedFields: JSON.stringify({ merged_from: absorbId, filled: Object.keys(fill), by: `admin:${by}` }),
    createdAt: nowIso,
  });
  return `🔗 #${absorb.id} **${absorb.title}** → #${keep.id} **${keep.title}**에 합쳤어요.${Object.keys(fill).length ? ` 비어 있던 ${Object.keys(fill).length}개 항목을 채웠어요.` : ''}`;
}

export type EventKind = (typeof EVENT_KINDS)[number];

/** 유형 변경 (잘못 분류된 행사). 바뀐 내용을 event_state_log에 남긴다 */
export async function setEventKind(db: Db, id: number, kind: EventKind, by: string, now = new Date()): Promise<EventRow | null> {
  const e = await getEvent(db, id);
  if (!e) return null;
  if (e.kind === kind) return e;
  const nowIso = now.toISOString();
  const [updated] = await db.update(events).set({ kind, updatedAt: nowIso }).where(eq(events.id, id)).returning();
  await db.insert(eventStateLog).values({
    eventId: id,
    fromStatus: e.status,
    toStatus: e.status,
    changedFields: JSON.stringify({ kind: { from: e.kind, to: kind }, by: `admin:${by}` }),
    createdAt: nowIso,
  });
  return updated ?? null;
}
