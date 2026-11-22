import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { planNotifications } from './planner.js';

/**
 * 티켓 오픈 리마인더 (규칙 7). ticket_open_at 기준
 * - 24시간 전 ~ 1시간 전 사이면 T-24h
 * - 1시간 전 ~ 오픈 시각 사이면 T-1h
 * 늦게 발견해 24시간 전 구간을 지났으면 T-24h는 건너뛴다. 중복은 유일 제약(slot)으로 막는다.
 */
export function reminderSlot(ticketOpenAt: string, now: Date): 'T-24h' | 'T-1h' | null {
  const diff = Date.parse(ticketOpenAt) - now.getTime();
  if (diff <= 0) return null;
  if (diff <= 3600_000) return 'T-1h';
  if (diff <= 24 * 3600_000) return 'T-24h';
  return null;
}

export async function planReminders(db: Db, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        isNotNull(events.ticketOpenAt),
        gt(events.ticketOpenAt, now.toISOString()),
        eq(events.needsReview, 0),
        sql`${events.status} NOT IN ('cancelled','ended')`,
      ),
    );
  let queued = 0;
  for (const e of rows) {
    const slot = reminderSlot(e.ticketOpenAt!, now);
    if (slot) queued += await planNotifications(db, e, 'reminder', slot);
  }
  return queued;
}
