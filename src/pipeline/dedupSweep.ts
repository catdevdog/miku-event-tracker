import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventDistinct, events, llmCalls } from '../db/schema.js';
import { costUsd, type Extraction, type Extractor } from './extract.js';
import { MATCH_SUSPECT, findMatchCandidates, toMatchCandidate, type EventRow } from './merge.js';

/**
 * 이미 등록된 행사끼리의 중복 검사. 새로 들어오는 글은 병합 단계에서 걸러지지만
 * 그 전에 따로 등록된 행사는 남아 있으므로, 다가오는 확정 행사를 한 번 훑어 Claude에게 같은 행사인지 묻는다.
 * - 같다고 하면(확신 0.5 이상) 나중에 등록된 쪽에 dup_of_id를 적는다. 관리자 채널에 [합치기]·[별개 행사] 카드가 올라간다.
 *   둘 다 이미 공지된 행사라 자동으로 합치지 않는다.
 * - 다르다고 하면 event_distinct에 적어 다시 묻지 않는다.
 */
export interface SweepResult {
  checked: number;
  flagged: number;
  /** 호출 한도에 걸려 남은 행사가 있으면 true */
  more: boolean;
}

const asExtraction = (e: EventRow): Extraction =>
  ({
    is_relevant: true, title: e.title, kind: e.kind, officiality: e.officiality, region: e.region, city: e.city, venue: e.venue,
    start_date: e.startDate, end_date: e.endDate, ticket_open_at: e.ticketOpenAt, ticket_url: e.ticketUrl, is_cancelled: false,
    sale_started: null, parent_event_hint: null, summary_ko: e.summaryKo ?? '', confidence: 1,
  }) as Extraction;

export const pairKey = (a: number, b: number) => (a < b ? { aId: a, bId: b } : { aId: b, bId: a });

export async function markDistinct(db: Db, a: number, b: number, now = new Date()): Promise<void> {
  await db.insert(eventDistinct).values({ ...pairKey(a, b), createdAt: now.toISOString() }).onConflictDoNothing();
}

export async function sweepDuplicates(db: Db, extractor: Pick<Extractor, 'match'>, now = new Date(), cap = 30): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, flagged: 0, more: false };
  if (!extractor.match) return result;
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.needsReview, 0), isNull(events.mergedInto), isNull(events.dupOfId), sql`${events.status} NOT IN ('ended','cancelled')`))
    .orderBy(events.id);
  const distinct = new Set((await db.select().from(eventDistinct)).map((d) => `${d.aId}:${d.bId}`));
  const known = (a: number, b: number) => {
    const k = pairKey(a, b);
    return distinct.has(`${k.aId}:${k.bId}`);
  };
  for (const e of rows) {
    // 먼저 등록된 확정 행사하고만 비교한다 (쌍을 한 번씩만 본다). 부모·자식(행사와 그 안의 부스)은 빼고
    const candidates = (await findMatchCandidates(db, asExtraction(e))).filter(
      (c) => c.id < e.id && c.needsReview === 0 && c.id !== e.parentEventId && c.parentEventId !== e.id && !known(c.id, e.id),
    );
    if (candidates.length === 0) continue;
    if (result.checked >= cap) {
      result.more = true;
      break;
    }
    const call = await extractor.match(asExtraction(e), candidates.map(toMatchCandidate));
    result.checked++;
    await db.insert(llmCalls).values({
      rawItemId: null,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: costUsd(call.model, call.inputTokens, call.outputTokens),
      createdAt: now.toISOString(),
    });
    const hit = candidates.find((c) => c.id === call.result.matchId);
    if (hit && call.result.relation === 'same' && call.result.confidence >= MATCH_SUSPECT) {
      await db.update(events).set({ dupOfId: hit.id }).where(eq(events.id, e.id));
      result.flagged++;
    } else {
      for (const c of candidates) {
        await markDistinct(db, c.id, e.id, now);
        distinct.add(`${pairKey(c.id, e.id).aId}:${pairKey(c.id, e.id).bId}`);
      }
    }
  }
  return result;
}
