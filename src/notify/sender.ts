import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import type { Notifier } from './notifier.js';
import type { OutgoingMessage } from './types.js';
import { NOTICE_WEBHOOK_TARGET, queuedNotifications } from './planner.js';

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
        await deps.notifier.sendNotice(message); // 봇 → 웹후크 순
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
      await deps.db
        .update(notifications)
        .set({ status: 'failed', attempts: sql`${notifications.attempts} + 1`, error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) })
        .where(eq(notifications.id, n.id));
      failed++;
    }
  }
  return { sent, failed };
}
