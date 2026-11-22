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
import { ensureSubscriptionSetup, syncDefaultMembers } from './subscriptions.js';
import { syncStatusBoard } from './statusBoard.js';
import { resolveReports } from './reports.js';

/**
 * 봇이 있어야 하는 주기 작업:
 * - 1분마다: 검수 대기 행사 카드를 관리자 채널에 올린다
 * - 10분마다: 국내 행사를 서버 예약 이벤트로 맞춘다
 * - 매주 월요일 09:00 KST: 이번 주 행사 요약을 공지 채널로 (job lock으로 주 1회)
 * - 1분마다: 판정이 끝난 제보의 결과를 관리자 채널 제보 카드에 적는다
 * - 10분마다(봇 준비 직후 한 번 포함): 알림 역할·구독 패널, 기본 구독(국내 역할 일괄), 관리자 상태판, 권한 점검
 */
export interface DiscordJobsDeps {
  db: Db;
  bot: () => DiscordBot | undefined;
  notifier: Notifier;
  alerter: Alerter;
  adminChannelId?: string;
  noticeChannelId?: string;
  /** 환경 변수 NOTIFY_PAUSED (상태판 표시용) */
  notifyPausedEnv?: boolean;
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
  let setupDone = false;
  // 권한·설정 안내는 같은 내용을 하루 한 번만
  const dailySent = new Map<string, string>();
  async function dailyAlert(key: string, text: string) {
    const day = now().toISOString().slice(0, 10);
    if (dailySent.get(key) === day) return;
    dailySent.set(key, day);
    await deps.alerter.alert(text);
  }

  /** 알림 역할·구독 패널 → 기본 구독(국내 역할 일괄) → 권한 점검 */
  async function setup() {
    const bot = deps.bot();
    if (!bot?.isReady() || !deps.noticeChannelId) return null;
    const r = await ensureSubscriptionSetup(deps.db, bot, deps.noticeChannelId, now());
    for (const e of r.errors) await dailyAlert(e.split(':')[0]!, e);
    let members: { added: number; initialized: number } | null = null;
    if (r.roles.KR) {
      try {
        members = await syncDefaultMembers(deps.db, bot, now());
        if (members.added > 0) log.log(`기본 구독: 국내 알림 역할 ${members.added}명에게 부여`);
      } catch (err) {
        await dailyAlert(
          'members',
          `멤버에게 국내 알림 역할을 주지 못했습니다: ${err instanceof Error ? err.message : String(err)}\n` +
            'Developer Portal → 앱 → Bot → Privileged Gateway Intents에서 **Server Members Intent**를 켜야 멤버 목록을 읽을 수 있고, 봇 역할이 알림 역할들보다 위에 있어야 합니다.',
        );
      }
    }
    const missing = await bot.missingPermissions(deps.noticeChannelId).catch(() => [] as string[]);
    if (missing.length) await dailyAlert('perm', `봇 역할에 권한이 부족합니다: ${missing.join(', ')}. 서버 설정 → 역할 → 봇 역할에서 켜 주세요.`);
    return { ...r, members, missing };
  }

  async function statusBoard() {
    const bot = deps.bot();
    if (!bot?.isReady() || !deps.adminChannelId) return null;
    return syncStatusBoard(deps.db, bot, deps.adminChannelId, now(), deps.notifyPausedEnv);
  }

  async function reports() {
    const bot = deps.bot();
    return resolveReports(deps.db, bot?.isReady() ? bot : undefined, deps.adminChannelId, now());
  }

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
      const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
      await reviews().catch((err: unknown) => deps.alerter.alert(`검수 카드 게시 실패: ${msg(err)}`));
      await reports().catch((err: unknown) => deps.alerter.alert(`제보 결과 기록 실패: ${msg(err)}`));
      const first = !setupDone && !!deps.bot()?.isReady();
      if (first || now().getUTCMinutes() % 10 === 0) {
        if (first) setupDone = true;
        await setup().catch((err: unknown) => dailyAlert('setup', `알림 역할·구독 패널 준비 실패: ${msg(err)}`));
        await statusBoard().catch((err: unknown) => dailyAlert('board', `상태판 갱신 실패: ${msg(err)}`));
        await guildEvents().catch((err: unknown) => deps.alerter.alert(`서버 이벤트 동기화 실패: ${msg(err)}`));
      }
    } finally {
      running = false;
    }
  }

  return {
    reviews,
    guildEvents,
    weekly,
    setup,
    statusBoard,
    reports,
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
