import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventSources, eventWatchers, notifications, rawItems, sources, subscribers } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import type { EventStatus } from '../pipeline/state.js';
import type { OutgoingMessage } from './types.js';
import { discordTime, formatKstShort, formatPeriodKo } from './format.js';
import { KIND_KO, OFFICIALITY_KO, REGION_IMAGES, STATUS_KO, kindLabel } from './labels.js';
import { actionButtonLabel, detailLines, noticeCard } from './cards.js';
import { isWatchFilter } from './watchers.js';

export type NotifyReason = 'new' | 'status_change' | 'reminder';

/** 사유별 머리말·아이콘·색 */
export function headline(reason: NotifyReason, status: EventStatus, slot: string): { label: string; icon: string; color: number } {
  if (reason === 'reminder') return slot === 'T-1h' ? { label: '티켓 오픈 1시간 전', icon: '⏰', color: 0xff6b35 } : { label: '티켓 오픈 24시간 전', icon: '⏰', color: 0xf5a623 };
  if (reason === 'new') return { label: '새 행사', icon: '🆕', color: 0x39c5bb };
  if (status === 'ticket_scheduled') return { label: '예매 일정 공개', icon: '🗓️', color: 0x4a90e2 };
  if (status === 'on_sale') return { label: '판매 시작', icon: '🎫', color: 0x7ed321 };
  if (status === 'cancelled') return { label: '행사 취소', icon: '⛔', color: 0xd0021b };
  return { label: STATUS_KO[status] ?? status, icon: '📢', color: 0x9b9b9b };
}

export { REGION_IMAGES } from './labels.js';

const REGION_FLAG: Record<string, string> = { KR: '🇰🇷 국내', JP: '🇯🇵 일본', OTHER: '🌏 해외' };

/** 출처 URL을 "[호스트](URL)" 링크로 */
function sourceLink(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return `[${host}](${url})`;
  } catch {
    return url;
  }
}

/** 디스코드 임베드 메시지. 시각은 한국 시각과 디스코드 타임스탬프(보는 사람 기준·상대 시간)를 함께 쓴다. */
export function renderEventMessage(e: EventRow, reason: NotifyReason, slot = '', sourceUrls: string[] = []): OutgoingMessage {
  const { label, icon, color } = headline(reason, e.status, slot);
  const links = [...new Set(sourceUrls)].slice(0, 3);
  const lines = [...detailLines(e), `🏷️ **구분**　${REGION_FLAG[e.region] ?? e.region} · ${kindLabel(e.kind)} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`];
  const summary = (e.summaryKo ?? '').trim();
  const description = [summary, summary ? '' : null, ...lines].filter((l) => l !== null).join('\n').slice(0, 4000);

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (e.ticketUrl) fields.push({ name: '바로가기', value: `[${actionButtonLabel(e, e.ticketUrl)}](${e.ticketUrl})`.slice(0, 1024), inline: true });
  if (links.length) fields.push({ name: '출처', value: links.map(sourceLink).join('\n').slice(0, 1024), inline: true });

  const image = REGION_IMAGES[e.region];
  return {
    card: noticeCard(e, { label, icon, color }, links),
    embeds: [
      {
        author: { name: `${icon} ${label}` },
        title: e.title.slice(0, 256),
        url: e.ticketUrl ?? links[0],
        description,
        color,
        fields,
        ...(image ? { image: { url: image } } : {}),
        footer: { text: `상태: ${STATUS_KO[e.status] ?? e.status} · 미쿠 행사 알림` },
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
 * 검수 대기(needs_review=1)·검수에서 무시(2)한 행사는 알리지 않는다.
 * @returns 새로 큐에 넣은 수
 */
export async function planNotifications(db: Db, e: EventRow, reason: NotifyReason, slot = ''): Promise<number> {
  if (e.needsReview !== 0) return 0; // 1 검수 대기, 2 검수에서 무시
  // 개인 리마인더(🔔) 구독자는 지켜보는 행사의 리마인더·상태 변경만 받는다
  const watchers = new Set(
    reason === 'new' ? [] : (await db.select({ userId: eventWatchers.userId }).from(eventWatchers).where(eq(eventWatchers.eventId, e.id))).map((w) => w.userId),
  );
  const subs = (await db.select().from(subscribers).where(eq(subscribers.active, 1))).filter((s) =>
    isWatchFilter(s.filters) ? s.channel === 'discord_dm' && watchers.has(s.target) : matchesFilters(s.filters, e),
  );
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

/**
 * 규칙 7: 새 행사(종료된 것 제외)는 new, 상태가 ticket_scheduled·on_sale·cancelled로 바뀌면 status_change.
 * 검수 대기가 풀린 행사(확신 높은 출처로 확인되거나 디스코드에서 승인)는 그때 처음 알리므로 new로 본다.
 */
export async function planForChange(db: Db, e: EventRow, change: { created: boolean; statusChanged: boolean; reviewCleared?: boolean }): Promise<number> {
  if (change.created || change.reviewCleared) return e.status === 'ended' ? 0 : planNotifications(db, e, 'new');
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
