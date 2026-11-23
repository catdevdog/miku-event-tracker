import { eq } from 'drizzle-orm';
import { ComponentType } from 'discord.js';
import type { Db } from '../db/client.js';
import { eventDiscord, events } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import { discordErrorCode, type DiscordBot } from './discord.js';
import type { Notifier } from './notifier.js';
import { eventSourceUrls, goingCount, renderEventMessage, type NotifyReason } from './planner.js';
import { mentionRoleFor } from './subscriptions.js';
import { KIND_ICON, QUIET_KINDS } from './labels.js';
import type { OutgoingMessage } from './types.js';

/**
 * 공지 채널 발송 (행사별 스레드).
 * - 새 행사: 공지 채널에 지역 역할을 멘션해 카드를 올리고, 그 카드에 스레드를 연다.
 * - 상태 변경(예매 일정·판매 시작·취소): 원래 카드를 지금 상태로 고치고, 소식은 스레드에 쓴다(멘션 없음).
 *   스레드 안의 역할 멘션은 스레드에 들어온 사람에게만 확실히 가므로 채널을 붐비게 하지 않는 쪽을 택했다.
 *   개인 리마인더(🔔)를 켠 사람은 DM으로 따로 받는다.
 * - 티켓 리마인더: 시간이 중요해 공지 채널에 역할 멘션과 함께 원래 카드에 답장으로 보낸다.
 * - 봇이 준비되지 않았으면 웹후크로 임베드를 보낸다(스레드·멘션 없음).
 */
export interface NoticeDeliveryDeps {
  db: Db;
  notifier: Notifier;
  noticeChannelId?: string;
  bot?: Pick<DiscordBot, 'isReady' | 'post' | 'editMessage' | 'startThread'> & Partial<Pick<DiscordBot, 'deleteMessage'>>;
  log?: Pick<Console, 'warn'>;
  /** 봇이 공지 채널에 못 써서 웹후크로 돌렸을 때 (관리자 경보용) */
  onBotFailure?: (err: unknown) => void | Promise<void>;
}

export interface NoticeJob {
  eventId: number;
  reason: NotifyReason;
  slot: string;
  message: OutgoingMessage;
}

export type NoticeOutcome = 'new' | 'thread' | 'channel' | 'reminder' | 'webhook';

/** 스레드용: 지역 이미지(미디어 갤러리)를 뺀 카드 */
export function withoutImages(msg: OutgoingMessage): OutgoingMessage {
  if (!msg.card) return msg;
  const strip = (c: Record<string, unknown>): Record<string, unknown> =>
    Array.isArray(c.components)
      ? { ...c, components: (c.components as Record<string, unknown>[]).filter((x) => x.type !== ComponentType.MediaGallery).map(strip) }
      : c;
  return { ...msg, card: msg.card.map((c) => strip(c as unknown as Record<string, unknown>)) as unknown as OutgoingMessage['card'] };
}

/** 원래 공지 카드를 지금 상태로 다시 그린다 (머리말: 발표면 새 행사, 아니면 지금 상태) */
export async function currentNoticeMessage(db: Db, e: EventRow): Promise<OutgoingMessage> {
  return renderEventMessage(e, e.status === 'announced' ? 'new' : 'status_change', '', await eventSourceUrls(db, e.id), { going: await goingCount(db, e.id) });
}

async function noticeIds(db: Db, eventId: number) {
  const [row] = await db
    .select({ messageId: eventDiscord.noticeMessageId, threadId: eventDiscord.noticeThreadId })
    .from(eventDiscord)
    .where(eq(eventDiscord.eventId, eventId));
  return row ?? { messageId: null, threadId: null };
}

async function saveNoticeIds(db: Db, eventId: number, ids: { noticeMessageId?: string | null; noticeThreadId?: string | null }) {
  const updatedAt = new Date().toISOString();
  await db
    .insert(eventDiscord)
    .values({ eventId, ...ids, updatedAt })
    .onConflictDoUpdate({ target: eventDiscord.eventId, set: { ...ids, updatedAt } });
}

/** 스레드 이름: "12.04 AGF 2026 미쿠 부스" (100자) */
export function threadName(e: Pick<EventRow, 'title' | 'startDate'> & { kind?: string }): string {
  const date = e.startDate ? `${e.startDate.slice(5).replace('-', '.')} ` : '';
  const icon = e.kind && KIND_ICON[e.kind] ? `${KIND_ICON[e.kind]} ` : '';
  return `${icon}${date}${e.title}`.slice(0, 100);
}

export async function deliverNotice(deps: NoticeDeliveryDeps, job: NoticeJob): Promise<NoticeOutcome> {
  const { db, bot, noticeChannelId: channelId } = deps;
  if (!bot?.isReady() || !channelId) {
    await deps.notifier.sendNotice(job.message);
    return 'webhook';
  }
  const [e] = await db.select().from(events).where(eq(events.id, job.eventId));
  if (!e) throw new Error(`행사 #${job.eventId}이(가) 없습니다`);
  const ids = await noticeIds(db, e.id);
  // 굿즈·콜라보 소식은 멘션 없이 조용히 올린다
  const roleId = QUIET_KINDS.has(e.kind) ? undefined : await mentionRoleFor(db, e.region);

  // 첫 공지 (또는 이 기능 전에 보낸 행사라 원래 카드를 모를 때): 채널에 멘션 + 스레드
  const postFresh = async (): Promise<NoticeOutcome> => {
    let messageId: string;
    try {
      messageId = await bot.post(channelId, job.message, { mentionRoleId: roleId });
    } catch (err) {
      deps.log?.warn(`[공지] 봇 발송 실패, 웹후크로 전환: ${err instanceof Error ? err.message : String(err)}`);
      await Promise.resolve(deps.onBotFailure?.(err)).catch(() => undefined);
      await deps.notifier.sendNotice(job.message);
      return 'webhook';
    }
    let threadId: string | null = null;
    try {
      threadId = await bot.startThread(channelId, messageId, threadName(e));
    } catch (err) {
      deps.log?.warn(`[공지] 스레드를 열지 못했습니다 (공개 스레드 만들기 권한 확인): ${err instanceof Error ? err.message : String(err)}`);
    }
    await saveNoticeIds(db, e.id, { noticeMessageId: messageId, noticeThreadId: threadId });
    return 'new';
  };

  if (job.reason === 'new' || !ids.messageId) return postFresh();

  if (job.reason === 'reminder') {
    await bot.post(channelId, job.message, { mentionRoleId: roleId, replyTo: ids.messageId });
    return 'reminder';
  }

  // 상태 변경: 원래 카드 고치기 → 스레드(없으면 원래 카드에 답장)
  try {
    await bot.editMessage(channelId, ids.messageId, await currentNoticeMessage(db, e));
  } catch (err) {
    if (discordErrorCode(err) === 10008) {
      // 원래 카드가 지워졌으면 새로 올린다
      await saveNoticeIds(db, e.id, { noticeMessageId: null, noticeThreadId: null });
      return postFresh();
    }
    deps.log?.warn(`[공지] 원래 카드 고치기 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ids.threadId) {
    try {
      await bot.post(ids.threadId, withoutImages(job.message));
      return 'thread';
    } catch (err) {
      if (discordErrorCode(err) !== 10003) throw err;
      await saveNoticeIds(db, e.id, { noticeThreadId: null }); // 스레드가 지워짐
    }
  }
  await bot.post(channelId, withoutImages(job.message), { replyTo: ids.messageId });
  return 'channel';
}

/** /관리로 행사를 고쳤을 때 원래 공지 카드도 맞춘다 (공지가 없으면 아무것도 안 함) */
export async function refreshNoticeCard(deps: NoticeDeliveryDeps, e: EventRow): Promise<boolean> {
  if (!deps.bot?.isReady() || !deps.noticeChannelId) return false;
  const ids = await noticeIds(deps.db, e.id);
  if (!ids.messageId) return false;
  await deps.bot.editMessage(deps.noticeChannelId, ids.messageId, await currentNoticeMessage(deps.db, e));
  return true;
}

/** 스레드 링크 (상세 카드 버튼용) */
export async function noticeThreadUrl(db: Db, guildId: string | undefined, eventId: number): Promise<string | undefined> {
  if (!guildId) return undefined;
  const ids = await noticeIds(db, eventId);
  return ids.threadId ? `https://discord.com/channels/${guildId}/${ids.threadId}` : undefined;
}

/**
 * 합쳐서 숨긴 행사의 공지를 지운다. 스레드가 있으면 남긴 행사의 공지로 가는 안내를 한 줄 남긴다(스레드는 지우지 않음).
 * @returns 공지를 지웠으면 true
 */
export async function removeNotice(deps: NoticeDeliveryDeps, absorbedId: number, keptId: number, guildId?: string): Promise<boolean> {
  const { db, bot, noticeChannelId: channelId } = deps;
  if (!bot?.isReady() || !bot.deleteMessage || !channelId) return false;
  const ids = await noticeIds(db, absorbedId);
  if (!ids.messageId) return false;
  await bot.deleteMessage(channelId, ids.messageId);
  if (ids.threadId) {
    const kept = await noticeIds(db, keptId);
    const link = guildId && kept.messageId ? ` → https://discord.com/channels/${guildId}/${channelId}/${kept.messageId}` : '';
    await bot.post(ids.threadId, { content: `이 행사는 같은 행사의 다른 공지로 합쳐졌어요.${link}` }).catch(() => undefined);
  }
  await saveNoticeIds(db, absorbedId, { noticeMessageId: null, noticeThreadId: null });
  return true;
}
