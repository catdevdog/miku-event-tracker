import { createHash } from 'node:crypto';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { parsePresales } from '../pipeline/merge.js';
import { kstDate } from '../pipeline/state.js';
import { ENDING_SOON_KINDS } from './labels.js';
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

/** 선예매 리마인더 슬롯: "pre:<이름·시각 해시>:T-1h" */
export const presaleSlot = (label: string, openAt: string, slot: string) =>
  `pre:${createHash('sha1').update(`${label}|${openAt}`).digest('hex').slice(0, 8)}:${slot}`;

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * 리마인더를 큐에 넣는다.
 * - 일반 예매 오픈 24시간·1시간 전 (공지 채널 + 🔔)
 * - 선예매·추첨 접수 시작 24시간·1시간 전 (공지 채널 + 🔔)
 * - 🔔를 켠 사람에게만 DM: 행사 시작 전날(한국 시간 9시 이후), 팝업·카페·전시·콜라보가 끝나기 3일 전
 */
export async function planReminders(db: Db, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const active = and(eq(events.needsReview, 0), sql`${events.status} NOT IN ('cancelled','ended')`);
  let queued = 0;

  const ticketRows = await db.select().from(events).where(and(isNotNull(events.ticketOpenAt), gt(events.ticketOpenAt, nowIso), active));
  for (const e of ticketRows) {
    const slot = reminderSlot(e.ticketOpenAt!, now);
    if (slot) queued += await planNotifications(db, e, 'reminder', slot);
  }

  const presaleRows = await db.select().from(events).where(and(sql`${events.presales} <> '[]'`, active));
  for (const e of presaleRows) {
    for (const p of parsePresales(e.presales)) {
      if (!p.open_at) continue;
      const slot = reminderSlot(p.open_at, now);
      if (!slot) continue;
      queued += await planNotifications(db, e, 'reminder', presaleSlot(p.label, p.open_at, slot), {
        head: { label: `${p.label} ${slot === 'T-1h' ? '1시간 전' : '24시간 전'}`, icon: '⏰', color: slot === 'T-1h' ? 0xff6b35 : 0xf5a623 },
      });
    }
  }

  // 전날·종료 임박 (한국 시간 09~22시에만 보낸다)
  const kstHour = (now.getUTCHours() + 9) % 24;
  if (kstHour >= 9 && kstHour < 22) {
    const today = kstDate(now);
    const watched = await db
      .select()
      .from(events)
      .where(and(active, sql`EXISTS (SELECT 1 FROM event_watchers w WHERE w.event_id = ${events.id})`, isNotNull(events.startDate)));
    for (const e of watched) {
      if (e.startDate === addDays(today, 1)) {
        queued += await planNotifications(db, e, 'reminder', 'D-1', { watchersOnly: true, head: { label: '내일 시작해요', icon: '🌙', color: 0x39c5bb } });
      }
      const end = e.endDate ?? e.startDate!;
      if (ENDING_SOON_KINDS.has(e.kind) && end === addDays(today, 3) && e.startDate! <= today) {
        queued += await planNotifications(db, e, 'reminder', 'END-3', { watchersOnly: true, head: { label: '3일 뒤에 끝나요', icon: '⏳', color: 0xf5a623 } });
      }
    }
  }
  return queued;
}
