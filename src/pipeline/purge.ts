import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { toIso } from '../lib/time.js';

/**
 * 보관 기한(purge_after)이 지난 원문을 지운다. 네이버 검색 결과는 약관상 21일까지만 보관한다(규칙 9, purge_after = 수집 + 20일).
 * 원문을 가리키는 행은 먼저 정리한다:
 * - event_sources(행사 ↔ 원문 연결): 삭제. 행사 자체는 남는다.
 * - event_state_log, llm_calls: raw_item_id만 비운다(변경 이력·비용 기록은 남긴다).
 * @returns 삭제한 원문 수
 */
export async function purgeExpiredItems(db: Db, now = new Date()): Promise<number> {
  const nowIso = toIso(now);
  const expired = sql`SELECT id FROM raw_items WHERE purge_after IS NOT NULL AND purge_after <= ${nowIso}`;
  await db.run(sql`DELETE FROM event_sources WHERE raw_item_id IN (${expired})`);
  await db.run(sql`UPDATE event_state_log SET raw_item_id = NULL WHERE raw_item_id IN (${expired})`);
  await db.run(sql`UPDATE llm_calls SET raw_item_id = NULL WHERE raw_item_id IN (${expired})`);
  const rows = await db.all<{ id: number }>(sql`DELETE FROM raw_items WHERE purge_after IS NOT NULL AND purge_after <= ${nowIso} RETURNING id`);
  return rows.length;
}
