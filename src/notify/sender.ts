import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notifications, subscribers } from '../db/schema.js';
import type { Notifier } from './notifier.js';
import type { OutgoingMessage } from './types.js';
import { NOTICE_WEBHOOK_TARGET, queuedNotifications, type NotifyReason } from './planner.js';
import { discordErrorCode } from './discord.js';
import type { NoticeJob } from './noticeThreads.js';

export const MAX_SEND_ATTEMPTS = 3;

export interface DmSender {
  isReady(): boolean;
  send(channelId: string, message: OutgoingMessage): Promise<void>;
  sendDm(userId: string, message: OutgoingMessage): Promise<void>;
}

export interface SendDeps {
  db: Db;
  notifier: Notifier;
  noticeChannelId?: string;
  bot?: DmSender;
  /** 공지 채널 발송 (행사별 스레드·역할 멘션). 없으면 notifier.sendNotice */
  deliverNotice?: (job: NoticeJob) => Promise<unknown>;
  now?: () => Date;
}

/** 큐에 있는 알림을 보낸다. 실패하면 attempts를 늘리고 3회까지 다시 시도한다. */
export async function sendQueued(deps: SendDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now ?? (() => new Date());
  let sent = 0;
  let failed = 0;
  for (const { n, s } of await queuedNotifications(deps.db, MAX_SEND_ATTEMPTS)) {
    const message = JSON.parse(n.message) as OutgoingMessage;
    try {
      if (s.channel === 'discord_dm') {
        if (!deps.bot?.isReady()) throw new Error('봇이 준비되지 않아 DM을 보낼 수 없습니다');
        await deps.bot.sendDm(s.target, message);
      } else if (s.target === deps.noticeChannelId || s.target === NOTICE_WEBHOOK_TARGET) {
        if (deps.deliverNotice) await deps.deliverNotice({ eventId: n.eventId, reason: n.reason as NotifyReason, slot: n.slot, message });
        else await deps.notifier.sendNotice(message); // 봇 → 웹후크 순
      } else {
        if (!deps.bot?.isReady()) throw new Error('봇이 준비되지 않아 채널에 보낼 수 없습니다');
        await deps.bot.send(s.target, message);
      }
      await deps.db
        .update(notifications)
        .set({ status: 'sent', sentAt: now().toISOString(), attempts: sql`${notifications.attempts} + 1`, error: null })
        .where(eq(notifications.id, n.id));
      sent++;
    } catch (err) {
      // DM을 막아 둔 사람(50007)은 다시 시도해도 같으므로 바로 끝내고, 그 사람의 DM 구독을 멈춘다(🔔을 다시 누르면 재개)
      const dmClosed = s.channel === 'discord_dm' && discordErrorCode(err) === 50007;
      await deps.db
        .update(notifications)
        .set({
          status: 'failed',
          attempts: dmClosed ? MAX_SEND_ATTEMPTS : sql`${notifications.attempts} + 1`,
          error: (dmClosed ? 'DM이 막혀 있어 보낼 수 없습니다 (50007)' : err instanceof Error ? err.message : String(err)).slice(0, 1000),
        })
        .where(eq(notifications.id, n.id));
      if (dmClosed) await deps.db.update(subscribers).set({ active: 0 }).where(eq(subscribers.id, s.id));
      failed++;
    }
  }
  return { sent, failed };
}
