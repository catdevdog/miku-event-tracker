import { and, desc, eq, isNull } from 'drizzle-orm';
import { ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorSpacingSize } from 'discord.js';
import type { Db } from '../db/client.js';
import { eventDiscord, eventSources, events, rawItems, sources } from '../db/schema.js';
import { followMerged, type EventRow } from '../pipeline/merge.js';
import { mergeEvents } from '../services/admin.js';
import { planForChange } from './planner.js';
import { esc, linkable } from './cards.js';
import { formatKstShort, formatPeriodKo } from './format.js';
import { CARD_COLOR, OFFICIALITY_KO, STATUS_KO, kindLabel, regionMeta } from './labels.js';
import type { OutgoingMessage } from './types.js';

/**
 * 검수 대기 행사(needs_review=1)를 관리자 채널에 카드로 올리고 [승인]·[무시] 버튼으로 처리한다.
 * - 승인: needs_review=0, 새 행사 알림을 큐에 넣는다(종료된 행사는 제외).
 * - 무시: needs_review=2. 이후 확신 높은 출처가 와도 다시 풀지 않는다(merge는 1일 때만 푼다).
 * 올린 카드는 event_discord.review_message_id로 기억해 다시 올리지 않는다.
 */

/** 한 틱에 올리는 검수 카드 수 (처음 켤 때 몰려 올라오지 않게) */
export const REVIEW_BATCH = 5;

/** ok 승인(별개 행사로 알리기), no 무시, mg 중복 의심 행사를 기존 행사에 합치기 */
export type ReviewDecision = 'ok' | 'no' | 'mg';

export const reviewButtonId = (decision: ReviewDecision, eventId: number) => `rv:${decision}:${eventId}`;

export function parseReviewId(id: string): { decision: ReviewDecision; eventId: number } | null {
  const m = /^rv:(ok|no|mg):(\d+)$/.exec(id);
  return m ? { decision: m[1] as ReviewDecision, eventId: Number(m[2]) } : null;
}

/** 중복 의심 행사가 가리키는 기존 행사 (이미 다른 행사에 합쳐졌으면 그 행사) */
async function dupTarget(db: Db, e: EventRow): Promise<EventRow | undefined> {
  if (!e.dupOfId) return undefined;
  const [t] = await db.select().from(events).where(eq(events.id, e.dupOfId));
  return followMerged(db, t);
}

export interface ReviewSource {
  name: string;
  url: string | null;
  confidence: number | null;
}

async function reviewSources(db: Db, eventId: number): Promise<ReviewSource[]> {
  return db
    .select({ name: sources.name, url: rawItems.url, confidence: eventSources.confidence })
    .from(eventSources)
    .innerJoin(rawItems, eq(rawItems.id, eventSources.rawItemId))
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(eq(eventSources.eventId, eventId))
    .orderBy(desc(eventSources.createdAt))
    .limit(3);
}

/** 검수 카드. decided가 있으면 버튼 대신 처리 결과를 보여 준다 */
export function reviewMessage(
  e: EventRow,
  srcs: ReviewSource[],
  decided?: { decision: ReviewDecision | 'done'; by?: string },
  dup?: EventRow,
): OutgoingMessage {
  const region = regionMeta(e.region);
  const conf = srcs.map((s) => s.confidence).filter((c): c is number => c !== null);
  const place = [e.city, e.venue].filter(Boolean).join(' · ') || '미정';
  const lines = [
    `📅 **일정**　${formatPeriodKo(e.startDate, e.endDate)}`,
    `📍 **장소**　${esc(place)}`,
    `🎫 **티켓 오픈**　${e.ticketOpenAt ? `${formatKstShort(e.ticketOpenAt)} KST` : '미정'}`,
    `🏷️ ${region.flag} ${region.label} · ${kindLabel(e.kind)} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality} · ${STATUS_KO[e.status] ?? e.status}`,
    ...(dup
      ? [
          '',
          `🔁 **같아 보이는 기존 행사** #${dup.id}`,
          `> **${esc(dup.title)}**`,
          `> ${formatPeriodKo(dup.startDate, dup.endDate)} · ${esc([dup.city, dup.venue].filter(Boolean).join(' · ') || '장소 미정')}`,
        ]
      : []),
  ];
  const sourceLines = srcs.map((s) => {
    const c = s.confidence !== null ? ` · 확신도 ${s.confidence.toFixed(2)}` : '';
    return `- ${linkable(s.url) ? `[${esc(s.name)}](${s.url})` : esc(s.name)}${c}`;
  });
  const summary = (e.summaryKo ?? '').trim();
  const resultText =
    decided?.decision === 'ok'
      ? `✅ 승인됨${decided.by ? ` · <@${decided.by}>` : ''} · 공지 채널로 알림을 보냅니다`
      : decided?.decision === 'mg'
        ? `🔗 기존 행사${dup ? ` #${dup.id}` : ''}에 합침${decided.by ? ` · <@${decided.by}>` : ''} · 따로 알리지 않습니다`
        : decided?.decision === 'no'
          ? `🗑️ 무시함${decided.by ? ` · <@${decided.by}>` : ''} · 알리지 않습니다`
          : decided?.decision === 'done'
            ? '이미 처리된 행사입니다'
            : null;
  const color = decided?.decision === 'ok' ? CARD_COLOR.ok : decided ? CARD_COLOR.off : CARD_COLOR.fail;

  const c = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents((t) =>
      t.setContent(
        dup
          ? '-# 🔁 중복 의심 · 이미 등록된 행사와 같아 보여 공지하지 않은 행사'
          : `-# 🔍 검수 대기 · 확신도가 낮아 공지하지 않은 행사${conf.length ? ` (최고 ${Math.max(...conf).toFixed(2)})` : ''}`,
      ),
    )
    .addTextDisplayComponents((t) => t.setContent([`## ${esc(e.title)}`, ...(summary ? [`> ${esc(summary).replace(/\n/g, '\n> ')}`] : [])].join('\n').slice(0, 1500)))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(lines.join('\n')));
  if (sourceLines.length) c.addTextDisplayComponents((t) => t.setContent(['**출처**', ...sourceLines].join('\n').slice(0, 1500)));
  if (resultText) {
    c.addTextDisplayComponents((t) => t.setContent(`-# ${resultText}`));
  } else {
    c.addActionRowComponents((r) =>
      r.setComponents(
        ...(dup ? [new ButtonBuilder().setCustomId(reviewButtonId('mg', e.id)).setLabel('🔗 같은 행사로 합치기').setStyle(ButtonStyle.Primary)] : []),
        new ButtonBuilder().setCustomId(reviewButtonId('ok', e.id)).setLabel(dup ? '🆕 별개 행사로 알리기' : '✅ 승인하고 알리기').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(reviewButtonId('no', e.id)).setLabel('🗑️ 무시').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  // 대체(임베드)에는 버튼이 없으므로 처리 방법을 적는다
  const embed = {
    title: `${dup ? '🔁 중복 의심' : '🔍 검수 대기'}: ${e.title}`.slice(0, 256),
    description: [...lines, '', ...sourceLines, '', resultText ?? '카드 표시가 안 돼 버튼을 쓸 수 없습니다. `/관리 행사`(숨기기)나 `/관리 합치기`로 처리하세요.'].join('\n').slice(0, 4000),
    color,
  };
  return { card: [c.toJSON()], embeds: [embed] };
}

/** 아직 카드를 올리지 않은 검수 대기 행사 */
export async function pendingReviewEvents(db: Db, limit = REVIEW_BATCH): Promise<EventRow[]> {
  const rows = await db
    .select({ e: events })
    .from(events)
    .leftJoin(eventDiscord, eq(eventDiscord.eventId, events.id))
    .where(and(eq(events.needsReview, 1), isNull(eventDiscord.reviewMessageId)))
    .orderBy(events.id)
    .limit(limit);
  return rows.map((r) => r.e);
}

export interface ReviewPoster {
  post(channelId: string, message: OutgoingMessage): Promise<string>;
}

/** 검수 카드를 관리자 채널에 올린다. @returns 올린 수 */
export async function postPendingReviews(db: Db, poster: ReviewPoster, channelId: string, now = new Date()): Promise<number> {
  let posted = 0;
  for (const e of await pendingReviewEvents(db)) {
    const messageId = await poster.post(channelId, reviewMessage(e, await reviewSources(db, e.id), undefined, await dupTarget(db, e)));
    await db
      .insert(eventDiscord)
      .values({ eventId: e.id, reviewChannelId: channelId, reviewMessageId: messageId, updatedAt: now.toISOString() })
      .onConflictDoUpdate({ target: eventDiscord.eventId, set: { reviewChannelId: channelId, reviewMessageId: messageId, updatedAt: now.toISOString() } });
    posted++;
  }
  return posted;
}

/**
 * 버튼 처리. 이미 처리된 행사(다른 사람이 먼저 눌렀거나 출처가 더 와서 풀린 경우)는 바꾸지 않는다.
 * @returns 카드에 다시 그릴 메시지와 새로 큐에 넣은 알림 수
 */
export async function decideReview(
  db: Db,
  eventId: number,
  decision: ReviewDecision,
  userId: string,
  now = new Date(),
): Promise<{ message: OutgoingMessage; queued: number } | null> {
  const nowIso = now.toISOString();
  const [before] = await db.select().from(events).where(eq(events.id, eventId));
  if (!before) return null;
  const dup = await dupTarget(db, before);
  // 출처는 합치기 전에 읽어 둔다 (합치면 남긴 행사로 옮겨진다)
  const srcs = await reviewSources(db, eventId);
  // needs_review=1인 행만 바꾼다 (동시에 두 번 눌러도 한 번만 처리)
  const [updated] =
    decision === 'mg' && !dup
      ? []
      : await db
          .update(events)
          .set({ needsReview: decision === 'ok' ? 0 : 2, ...(decision === 'ok' ? { dupOfId: null } : {}), updatedAt: nowIso })
          .where(and(eq(events.id, eventId), eq(events.needsReview, 1)))
          .returning();
  if (!updated) return { message: reviewMessage(before, srcs, { decision: 'done' }, dup), queued: 0 };
  if (decision === 'mg' && dup) await mergeEvents(db, dup.id, eventId, userId, now);

  await db
    .insert(eventDiscord)
    .values({ eventId, reviewedBy: userId, reviewedAt: nowIso, updatedAt: nowIso })
    .onConflictDoUpdate({ target: eventDiscord.eventId, set: { reviewedBy: userId, reviewedAt: nowIso, updatedAt: nowIso } });
  const queued = decision === 'ok' ? await planForChange(db, updated, { created: false, statusChanged: false, reviewCleared: true }) : 0;
  return { message: reviewMessage(updated, srcs, { decision, by: userId }, dup), queued };
}
