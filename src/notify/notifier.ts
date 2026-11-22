import type { Alerter } from '../alerts.js';
import { truncate } from './format.js';
import type { ChannelSender, NoticeSender, OutgoingMessage } from './types.js';

export interface NotifierDeps {
  bot?: ChannelSender;
  noticeChannelId?: string;
  adminChannelId?: string;
  /** 공지 채널 웹후크. 봇이 준비되지 않았거나 발송에 실패하면 쓴다. */
  webhook?: NoticeSender;
  log?: Pick<Console, 'warn' | 'error'>;
}

export interface Notifier {
  /** 공지 채널 발송. 봇 → 웹후크 순으로 시도하고, 둘 다 안 되면 오류를 던진다. */
  sendNotice(message: OutgoingMessage): Promise<'bot' | 'webhook'>;
  /** 관리자 경보. 관리자 채널로만 보낸다(웹후크는 공지 채널이므로 쓰지 않음). 실패하면 콘솔에 남긴다. */
  alerter: Alerter;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  // bot은 나중에 준비되므로 호출할 때마다 deps에서 읽는다(구조 분해하면 처음 값에 고정됨).
  const { noticeChannelId, adminChannelId, webhook, log = console } = deps;
  return {
    async sendNotice(message) {
      const bot = deps.bot;
      let botError: unknown;
      if (bot && noticeChannelId && bot.isReady()) {
        try {
          await bot.send(noticeChannelId, message);
          return 'bot';
        } catch (err) {
          botError = err;
          log.warn(`[공지] 봇 발송 실패, 웹후크로 전환: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (webhook) {
        await webhook.send(message);
        return 'webhook';
      }
      throw botError instanceof Error ? botError : new Error('공지를 보낼 수단이 없습니다 (봇 미준비, 웹후크 미설정)');
    },
    alerter: {
      async alert(text) {
        const bot = deps.bot;
        const content = truncate(`⚠️ ${text}`);
        if (bot && adminChannelId && bot.isReady()) {
          try {
            await bot.send(adminChannelId, { content });
            return;
          } catch (err) {
            log.error(`[관리자 경보] 디스코드 발송 실패: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        log.warn(`[관리자 경보] ${text}`);
      },
    },
  };
}

/** 같은 경보를 window 안에 다시 보내지 않는다. DB 장애처럼 매 틱 같은 오류가 나는 경우의 도배를 막는다. */
export function dedupAlerter(inner: Alerter, windowMin = 30, now: () => Date = () => new Date()): Alerter {
  const lastSent = new Map<string, number>();
  return {
    async alert(message) {
      const t = now().getTime();
      const prev = lastSent.get(message);
      if (prev !== undefined && t - prev < windowMin * 60_000) return;
      lastSent.set(message, t);
      // 오래된 항목 정리
      for (const [k, v] of lastSent) if (t - v >= windowMin * 60_000) lastSent.delete(k);
      await inner.alert(message);
    },
  };
}
