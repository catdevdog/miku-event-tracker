import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventAttendees, eventWatchers, events, subscribers } from '../db/schema.js';
import type { Reply } from './discord.js';
import { formatKstShort } from './format.js';

/**
 * 개인 리마인더: 공지 카드의 🔔 알림 받기.
 * 누른 사람마다 DM 구독자(subscribers, filters {"watch":true})를 하나 두고, 지켜보는 행사(event_watchers)의
 * 티켓 오픈 24시간·1시간 전 리마인더와 상태 변경(예매 일정·판매 시작·취소)만 DM으로 보낸다. 새 행사 알림은 보내지 않는다.
 */
export const WATCH_FILTER = '{"watch":true}';

export const watchButtonId = (eventId: number) => `wt:${eventId}`;
export function parseWatchId(id: string): number | null {
  const m = /^wt:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** filters가 개인 리마인더 구독자인지 */
export function isWatchFilter(filtersJson: string): boolean {
  try {
    return (JSON.parse(filtersJson) as { watch?: unknown }).watch === true;
  } catch {
    return false;
  }
}

export async function isWatching(db: Db, eventId: number, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: eventWatchers.eventId })
    .from(eventWatchers)
    .where(and(eq(eventWatchers.eventId, eventId), eq(eventWatchers.userId, userId)));
  return !!row;
}

/** 🔔 버튼: 켜져 있으면 끄고, 꺼져 있으면 켠다 */
export async function toggleWatch(db: Db, eventId: number, userId: string, now = new Date()): Promise<Reply> {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  if (!e) return '행사를 찾을 수 없어요.';
  if (await isWatching(db, eventId, userId)) {
    await db.delete(eventWatchers).where(and(eq(eventWatchers.eventId, eventId), eq(eventWatchers.userId, userId)));
    return `🔕 **${e.title}** 알림을 껐어요.`;
  }
  if (e.status === 'ended' || e.status === 'cancelled') return `**${e.title}**은(는) ${e.status === 'ended' ? '끝난' : '취소된'} 행사라 알림을 켤 수 없어요.`;

  await db.insert(eventWatchers).values({ eventId, userId, createdAt: now.toISOString() }).onConflictDoNothing();
  const [sub] = await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.channel, 'discord_dm'), eq(subscribers.target, userId)));
  if (!sub) await db.insert(subscribers).values({ name: `DM ${userId}`, channel: 'discord_dm', target: userId, filters: WATCH_FILTER });
  else if (sub.active !== 1) await db.update(subscribers).set({ active: 1 }).where(eq(subscribers.id, sub.id));

  const when =
    e.ticketOpenAt && Date.parse(e.ticketOpenAt) > now.getTime()
      ? `티켓 오픈(${formatKstShort(e.ticketOpenAt)} KST) 24시간 전·1시간 전`
      : '티켓 일정이 나오면 그 일정';
  return [
    `🔔 **${e.title}** 알림을 켰어요.`,
    `${when}, 판매 시작·취소 소식을 DM으로 보내 드려요. 버튼을 다시 누르면 꺼져요.`,
    '-# DM이 안 오면: 이 서버 이름 우클릭 → 개인정보 보호 설정 → 다이렉트 메시지 허용',
  ].join('\n');
}

// ── 참석 표시 (🙋 갈 거예요) ────────────────────────────────

export const goButtonId = (eventId: number) => `go:${eventId}`;
export function parseGoId(id: string): number | null {
  const m = /^go:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** 🙋 버튼: 참석 표시를 켜고 끈다. 공지 카드의 숫자는 호출한 쪽에서 고친다 */
export async function toggleGoing(db: Db, eventId: number, userId: string, now = new Date()): Promise<{ reply: Reply; changed: boolean }> {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  if (!e) return { reply: '행사를 찾을 수 없어요.', changed: false };
  const where = and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId));
  const [mine] = await db.select({ id: eventAttendees.eventId }).from(eventAttendees).where(where);
  if (mine) await db.delete(eventAttendees).where(where);
  else {
    if (e.status === 'ended' || e.status === 'cancelled') return { reply: `**${e.title}**은(는) ${e.status === 'ended' ? '끝난' : '취소된'} 행사예요.`, changed: false };
    await db.insert(eventAttendees).values({ eventId, userId, createdAt: now.toISOString() }).onConflictDoNothing();
  }
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(eventAttendees).where(eq(eventAttendees.eventId, eventId));
  const n = Number(c?.n ?? 0);
  return {
    reply: mine ? `**${e.title}** 참석 표시를 지웠어요. (지금 ${n}명)` : `🙋 **${e.title}**에 간다고 표시했어요. (지금 ${n}명)\n-# 버튼을 다시 누르면 지워져요. 전날 알림이 필요하면 🔔 알림 받기도 눌러 두세요.`,
    changed: true,
  };
}

/** /내알림: 내가 🔔를 켠 행사와 🙋 표시한 행사 (다가오는 것만) */
export async function myEvents(db: Db, userId: string): Promise<{ watching: (typeof events.$inferSelect)[]; going: (typeof events.$inferSelect)[] }> {
  const upcoming = sql`${events.status} NOT IN ('ended','cancelled') AND ${events.needsReview} = 0`;
  const order = [sql`${events.startDate} IS NULL`, events.startDate, events.id] as const;
  const watching = await db
    .select({ e: events })
    .from(eventWatchers)
    .innerJoin(events, eq(events.id, eventWatchers.eventId))
    .where(and(eq(eventWatchers.userId, userId), upcoming))
    .orderBy(...order)
    .limit(10);
  const going = await db
    .select({ e: events })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.eventId))
    .where(and(eq(eventAttendees.userId, userId), upcoming))
    .orderBy(...order)
    .limit(10);
  return { watching: watching.map((r) => r.e), going: going.map((r) => r.e) };
}
