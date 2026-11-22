import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Alerter } from '../alerts.js';
import { acquireLock } from '../scheduler/lock.js';
import type { DiscordBot } from './discord.js';
import type { Notifier } from './notifier.js';
import { postPendingReviews } from './review.js';
import { syncGuildEvents } from './guildEvents.js';
import { weeklyData, weeklyMessage } from './weekly.js';

/**
 * 봇이 있어야 하는 주기 작업:
 * - 1분마다: 검수 대기 행사 카드를 관리자 채널에 올린다
 * - 10분마다: 국내 행사를 서버 예약 이벤트로 맞춘다
 * - 매주 월요일 09:00 KST: 이번 주 행사 요약을 공지 채널로 (job lock으로 주 1회)
 */
export interface DiscordJobsDeps {
  db: Db;
  bot: () => DiscordBot | undefined;
  notifier: Notifier;
  alerter: Alerter;
  adminChannelId?: string;
  now?: () => Date;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createDiscordJobs(deps: DiscordJobsDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const owner = `discord-jobs-${randomUUID()}`;
  const tasks: ScheduledTask[] = [];
  let lastPermissionAlert = '';
  let running = false;

  async function reviews() {
    const bot = deps.bot();
    if (!bot?.isReady() || !deps.adminChannelId) return 0;
    return postPendingReviews(deps.db, bot, deps.adminChannelId, now());
  }

  async function guildEvents() {
    const bot = deps.bot();
    if (!bot?.isReady()) return null;
    const r = await syncGuildEvents(deps.db, bot, now());
    if (r.noPermission) {
      // 권한 안내는 하루 한 번
      const day = now().toISOString().slice(0, 10);
      if (lastPermissionAlert !== day) {
        lastPermissionAlert = day;
        await deps.alerter.alert('서버 이벤트에 국내 행사를 등록하려면 봇 역할에 "이벤트 만들기"(또는 "이벤트 관리") 권한이 필요합니다. 서버 설정 → 역할에서 켜 주세요.');
      }
    }
    for (const e of r.errors) await deps.alerter.alert(`서버 이벤트 동기화 실패: ${e}`.slice(0, 1500));
    return r;
  }

  async function weekly() {
    // 재시작해도 같은 주에 두 번 보내지 않게 6일짜리 락을 잡고 풀지 않는다
    if (!(await acquireLock(deps.db, 'weekly_digest', owner, 6 * 24 * 60, now()))) return false;
    const msg = weeklyMessage(await weeklyData(deps.db, now()));
    if (!msg) {
      log.log('이번 주 요약: 보낼 행사가 없어 건너뜀');
      return false;
    }
    await deps.notifier.sendNotice(msg);
    return true;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await reviews().catch((err: unknown) => deps.alerter.alert(`검수 카드 게시 실패: ${err instanceof Error ? err.message : String(err)}`));
      if (now().getUTCMinutes() % 10 === 0) {
        await guildEvents().catch((err: unknown) => deps.alerter.alert(`서버 이벤트 동기화 실패: ${err instanceof Error ? err.message : String(err)}`));
      }
    } finally {
      running = false;
    }
  }

  return {
    reviews,
    guildEvents,
    weekly,
    start() {
      tasks.push(cron.schedule('* * * * *', () => void tick()));
      tasks.push(
        cron.schedule(
          '0 9 * * 1',
          () => void weekly().catch((err: unknown) => deps.alerter.alert(`이번 주 요약 발송 실패: ${err instanceof Error ? err.message : String(err)}`)),
          { timezone: 'Asia/Seoul' },
        ),
      );
    },
    stop() {
      for (const t of tasks) void t.stop();
    },
  };
}
