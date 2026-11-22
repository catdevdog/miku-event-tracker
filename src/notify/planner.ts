import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventSources, notifications, rawItems, sources, subscribers } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import type { EventStatus } from '../pipeline/state.js';
import type { OutgoingMessage } from './types.js';
import { formatKst } from './format.js';

export type NotifyReason = 'new' | 'status_change' | 'reminder';

const KIND_KO: Record<string, string> = {
  concert: '공연', booth: '부스', stage: '무대', popup: '팝업', cafe: '콜라보 카페',
  exhibition: '전시', live_viewing: '라이브뷰잉', goods: '굿즈', other: '기타',
};
const OFFICIALITY_KO: Record<string, string> = {
  crypton: '크립톤 공식', licensed: '공식 라이선스', permitted_doujin: '허가 동인', unverified: '미확인',
};
const STATUS_KO: Record<string, string> = {
  announced: '발표', ticket_scheduled: '예매 예정', on_sale: '판매 중', ongoing: '진행 중', ended: '종료', cancelled: '취소',
};
const REGION_KO: Record<string, string> = { KR: '한국', JP: '일본', OTHER: '해외' };

/** 사유별 머리말과 색 */
function headline(reason: NotifyReason, status: EventStatus, slot: string): { label: string; color: number } {
  if (reason === 'reminder') return { label: slot === 'T-1h' ? '티켓 오픈 1시간 전' : '티켓 오픈 24시간 전', color: 0xf5a623 };
  if (reason === 'new') return { label: '새 행사', color: 0x39c5bb };
  if (status === 'ticket_scheduled') return { label: '예매 일정', color: 0x4a90e2 };
  if (status === 'on_sale') return { label: '판매 시작', color: 0x7ed321 };
  if (status === 'cancelled') return { label: '취소', color: 0xd0021b };
  return { label: STATUS_KO[status] ?? status, color: 0x9b9b9b };
}

const period = (e: EventRow) =>
  e.startDate ? (e.endDate && e.endDate !== e.startDate ? `${e.startDate} ~ ${e.endDate}` : e.startDate) : '미정';

/** 디스코드 임베드 메시지. 시각은 한국 시각으로 표시한다 (규칙 8). */
export function renderEventMessage(e: EventRow, reason: NotifyReason, slot = '', sourceUrls: string[] = []): OutgoingMessage {
  const { label, color } = headline(reason, e.status, slot);
  const fields = [
    { name: '종류', value: `${KIND_KO[e.kind] ?? e.kind} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`, inline: true },
    { name: '상태', value: STATUS_KO[e.status] ?? e.status, inline: true },
    { name: '지역', value: [REGION_KO[e.region] ?? e.region, e.city].filter(Boolean).join(' '), inline: true },
    { name: '기간', value: period(e), inline: true },
    { name: '장소', value: e.venue ?? '미정', inline: true },
    { name: '티켓 오픈', value: e.ticketOpenAt ? formatKst(e.ticketOpenAt) : '미정', inline: true },
  ];
  if (e.ticketUrl) fields.push({ name: '예매', value: e.ticketUrl.slice(0, 1024), inline: false });
  const links = [...new Set(sourceUrls)].slice(0, 3);
  if (links.length) fields.push({ name: '출처', value: links.join('\n').slice(0, 1024), inline: false });
  return {
    embeds: [
      {
        title: `[${label}] ${e.title}`.slice(0, 256),
        url: e.ticketUrl ?? links[0],
        description: (e.summaryKo ?? '').slice(0, 2000) || undefined,
        color,
        fields,
      },
    ],
  };
}

/** 행사에 연결된 원문 URL (최근 것부터) */
export async function eventSourceUrls(db: Db, eventId: number): Promise<string[]> {
  const rows = await db
    .select({ url: rawItems.url, adapter: sources.adapter })
    .from(eventSources)
    .innerJoin(rawItems, eq(rawItems.id, eventSources.rawItemId))
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(eq(eventSources.eventId, eventId))
    .orderBy(sql`${eventSources.createdAt} DESC`);
  // 네이버 검색 결과 링크는 출처로 쓰지 않는다 (원문 링크만)
  return rows.filter((r) => r.url && r.adapter !== 'naver').map((r) => r.url!);
}

/** 구독자가 없으면 공지 채널(또는 웹후크)을 기본 구독자로 만든다. 알림 조건이 정해지기 전까지의 기본값. */
export async function ensureDefaultSubscriber(db: Db, opts: { noticeChannelId?: string; hasWebhook: boolean }): Promise<void> {
  const [any] = await db.select({ id: subscribers.id }).from(subscribers).limit(1);
  if (any) return;
  const target = opts.noticeChannelId ?? (opts.hasWebhook ? NOTICE_WEBHOOK_TARGET : undefined);
  if (!target) return;
  await db.insert(subscribers).values({ name: '공지 채널', channel: 'discord_channel', target });
}

/** 공지 채널 대신 웹후크로만 보낼 때의 구독자 target 값 */
export const NOTICE_WEBHOOK_TARGET = 'notice-webhook';

/** subscribers.filters (알림 조건 미정). 지금은 비어 있으면 전부, 키가 있으면 해당 값만. */
function matchesFilters(filtersJson: string, e: EventRow): boolean {
  let f: Record<string, unknown> = {};
  try {
    f = JSON.parse(filtersJson) as Record<string, unknown>;
  } catch {
    return true;
  }
  const allow = (key: string, value: string) => {
    const v = f[key];
    return !Array.isArray(v) || v.length === 0 || v.includes(value);
  };
  return allow('regions', e.region) && allow('kinds', e.kind) && allow('officiality', e.officiality);
}

/**
 * 알림을 큐(notifications, status=queued)에 넣는다. 같은 (행사, 구독자, 사유, 상태, 슬롯)은 유일 제약으로 한 번만.
 * 검수 대기(needs_review=1) 행사는 알리지 않는다.
 * @returns 새로 큐에 넣은 수
 */
export async function planNotifications(db: Db, e: EventRow, reason: NotifyReason, slot = ''): Promise<number> {
  if (e.needsReview === 1) return 0;
  const subs = (await db.select().from(subscribers).where(eq(subscribers.active, 1))).filter((s) => matchesFilters(s.filters, e));
  if (subs.length === 0) return 0;
  const message = JSON.stringify(renderEventMessage(e, reason, slot, await eventSourceUrls(db, e.id)));
  let queued = 0;
  for (const s of subs) {
    const rows = await db
      .insert(notifications)
      .values({ eventId: e.id, subscriberId: s.id, reason, eventStatus: e.status, slot, message })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    queued += rows.length;
  }
  return queued;
}

/** 규칙 7: 새 행사(종료된 것 제외)는 new, 상태가 ticket_scheduled·on_sale·cancelled로 바뀌면 status_change */
export async function planForChange(db: Db, e: EventRow, change: { created: boolean; statusChanged: boolean }): Promise<number> {
  if (change.created) return e.status === 'ended' ? 0 : planNotifications(db, e, 'new');
  if (change.statusChanged && ['ticket_scheduled', 'on_sale', 'cancelled'].includes(e.status)) return planNotifications(db, e, 'status_change');
  return 0;
}

export async function queuedNotifications(db: Db, maxAttempts: number) {
  return db
    .select({ n: notifications, s: subscribers })
    .from(notifications)
    .innerJoin(subscribers, eq(subscribers.id, notifications.subscriberId))
    .where(and(inArray(notifications.status, ['queued', 'failed']), sql`${notifications.attempts} < ${maxAttempts}`))
    .orderBy(notifications.id)
    .limit(50);
}
