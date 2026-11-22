import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Source } from '../db/schema.js';
import { addMinutes, minutesBetween, toIso } from '../lib/time.js';

export const BOOST_WINDOW_DAYS = 60;
export const X_JITTER_MIN = 10;

/** 등록하지 않는 소스: enabled=0 이거나 target이 TODO (CLAUDE.md 규칙 14) */
export function isSchedulable(s: Pick<Source, 'enabled' | 'target'>): boolean {
  return s.enabled === 1 && s.target !== 'TODO';
}

/**
 * x_crawl 소스의 ±10분 지터. (소스 id, 직전 실행 시각)으로 정해지므로
 * 같은 실행 주기 안에서는 매 틱 같은 값이 나온다.
 */
export function jitterMin(s: Pick<Source, 'id' | 'adapter' | 'lastRunAt'>): number {
  if (s.adapter !== 'x_crawl') return 0;
  const seed = `${s.id}:${s.lastRunAt ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % (X_JITTER_MIN * 2 + 1)) - X_JITTER_MIN;
}

/**
 * L2 소스에 연결된 행사(그 소스의 원문에서 나온 행사) 중 시작일이 오늘부터 60일 안에 있는 것이 있으면 boost.
 * (CLAUDE.md 규칙 12)
 */
export async function isBoostActive(db: Db, s: Pick<Source, 'id' | 'layer' | 'boostIntervalMin'>, now = new Date()): Promise<boolean> {
  if (s.layer !== 'L2' || !s.boostIntervalMin) return false;
  const today = toIso(now).slice(0, 10);
  const limit = toIso(addMinutes(now, BOOST_WINDOW_DAYS * 24 * 60)).slice(0, 10);
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n
    FROM events e
    JOIN event_sources es ON es.event_id = e.id
    JOIN raw_items r ON r.id = es.raw_item_id
    WHERE r.source_id = ${s.id}
      AND e.status <> 'cancelled'
      AND substr(e.start_date, 1, 10) BETWEEN ${today} AND ${limit}
  `);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** 이번 틱에 실행할 차례인지 */
export function isDue(s: Pick<Source, 'id' | 'adapter' | 'lastRunAt'>, intervalMin: number, now = new Date()): boolean {
  if (!s.lastRunAt) return true;
  const elapsed = minutesBetween(new Date(s.lastRunAt), now);
  return elapsed >= intervalMin + jitterMin(s);
}
