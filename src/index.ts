import { loadConfig, loadDotEnvIfPresent } from './config.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { createScheduler } from './scheduler/index.js';
import { closeInterruptedRuns, resetSkippedSources } from './scheduler/runner.js';
import { createAdapters } from './adapters/registry.js';
import { createApp } from './app.js';
import { startDiscordBot, type DiscordBot } from './notify/discord.js';
import { createWebhookSender } from './notify/webhook.js';
import { createNotifier, dedupAlerter } from './notify/notifier.js';
import { buildDiagnosticsReply, buildEventsReply, buildPingReply, buildRecentReply, buildSourcesReply } from './notify/commands.js';
import { buildGuideReply } from './notify/guide.js';
import { getDiagnostics } from './services/diagnostics.js';
import { getServiceStatus } from './services/status.js';
import { listCollectionPlan, listSourceStatuses } from './services/sources.js';
import { listRecentRawItems } from './services/rawItems.js';
import { eventLinks, listUpcomingEvents, parseEventScope, type EventScope } from './services/events.js';
import { EVENTS_PAGE_SIZE, parseEventsPageId } from './notify/cards.js';
import { createPipelineRunner } from './pipeline/index.js';
import { createAnthropicExtractor } from './pipeline/extract.js';
import { ensureDefaultSubscriber } from './notify/planner.js';

// 부트스트랩: 마이그레이션 → 시드 → 스케줄러 → 디스코드 봇 → 파이프라인 → Express
loadDotEnvIfPresent();
const config = loadConfig();
const startedAt = new Date();
const uptimeSec = () => Math.round((Date.now() - startedAt.getTime()) / 1000);

const { client, db } = await openDb({ url: config.DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
await runMigrations(db);
const seeded = await seedDatabase(db);
const interrupted = await closeInterruptedRuns(db);
const resetSkipped = await resetSkippedSources(db);
console.log(
  `DB 준비 완료: 소스 추가 ${seeded.sourcesInserted}, 갱신 ${seeded.sourcesUpdated}, 키워드 ${seeded.keywordsUpserted}` +
    (interrupted ? `, 중단된 실행 ${interrupted}건 정리` : '') +
    (resetSkipped ? `, 바로 실행할 소스 ${resetSkipped}개` : ''),
);

// 디스코드: 토큰이 있으면 봇을 켠다. 봇이 없거나 끊기면 공지는 웹후크(설정 시)로, 경보는 콘솔로 간다.
let bot: DiscordBot | undefined;
const notifier = createNotifier({
  get bot() {
    return bot;
  },
  noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID,
  adminChannelId: config.DISCORD_ADMIN_CHANNEL_ID,
  webhook: config.DISCORD_NOTICE_WEBHOOK_URL ? createWebhookSender(config.DISCORD_NOTICE_WEBHOOK_URL) : undefined,
});
const alerter = dedupAlerter(notifier.alerter);

const scheduler = createScheduler({ db, adapters: createAdapters(config, db), alerter });
scheduler.start();

if (config.DISCORD_BOT_TOKEN && config.DISCORD_APP_ID && config.DISCORD_GUILD_ID) {
  // 봇 토큰은 점(.)으로 나뉜 세 부분이다. Client Secret(점 없음)을 잘못 넣은 경우를 미리 알린다.
  if (config.DISCORD_BOT_TOKEN.split('.').length !== 3) {
    console.warn('DISCORD_BOT_TOKEN이 봇 토큰 형식(점으로 나뉜 세 부분)이 아닙니다. Client Secret을 넣은 것은 아닌지 확인하세요.');
  }
  /** /행사 한 페이지. 카드 버튼 링크(예매·원문)는 그 페이지 행사만 조회한다. */
  const eventsPage = async (scope: EventScope, page: number) => {
    const rows = await listUpcomingEvents(db, { scope, limit: 200 });
    const p = Math.min(Math.max(0, page), Math.max(0, Math.ceil(rows.length / EVENTS_PAGE_SIZE) - 1));
    const links = await eventLinks(db, rows.slice(p * EVENTS_PAGE_SIZE, (p + 1) * EVENTS_PAGE_SIZE));
    return buildEventsReply(rows, scope, p, links);
  };

  bot = startDiscordBot({
    token: config.DISCORD_BOT_TOKEN,
    appId: config.DISCORD_APP_ID,
    guildId: config.DISCORD_GUILD_ID,
    onCommand: async (name, ctx) => {
      switch (name) {
        case 'ping':
          return buildPingReply({ status: await getServiceStatus(db), wsPingMs: ctx.wsPingMs, uptimeSec: uptimeSec() });
        case '소스':
          return buildSourcesReply(await listSourceStatuses(db));
        case '최근수집':
          return buildRecentReply(await listRecentRawItems(db, 15));
        case '행사':
          return eventsPage(parseEventScope(ctx.getString('범위')), 0);
        case '점검':
          return buildDiagnosticsReply(await getDiagnostics(db));
        case '가이드':
          return buildGuideReply(await listCollectionPlan(db));
        default:
          return null;
      }
    },
    onButton: async (customId) => {
      const page = parseEventsPageId(customId);
      return page ? eventsPage(parseEventScope(page.scope), page.page) : null;
    },
    presence: async () => {
      const all = await listUpcomingEvents(db, { limit: 1000 });
      const kr = all.filter((e) => e.region === 'KR').length;
      return `🎤 다가오는 미쿠 행사 ${all.length}건 (국내 ${kr}) · /가이드`;
    },
    onReady: async () => {
      const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
      await notifier.alerter.alert(`서비스 시작${commit ? ` (커밋 ${commit})` : ''}`);
    },
  });
} else {
  console.warn('DISCORD_BOT_TOKEN이 없어 디스코드 봇을 켜지 않습니다.');
}

// 파이프라인: 키워드 → Claude 추출 → 병합·상태 → 알림 큐 → 발송 (1분마다)
await ensureDefaultSubscriber(db, { noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID, hasWebhook: !!config.DISCORD_NOTICE_WEBHOOK_URL });
if (!config.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY가 없어 키워드 판정까지만 하고 추출은 하지 않습니다.');
const pipeline = createPipelineRunner({
  db,
  extractor: config.ANTHROPIC_API_KEY ? createAnthropicExtractor(config.ANTHROPIC_API_KEY) : undefined,
  alerter,
  notifier,
  noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID,
  bot: () => bot,
  notifyPaused: config.NOTIFY_PAUSED,
});
if (config.NOTIFY_PAUSED) console.warn('NOTIFY_PAUSED: 알림을 큐에만 쌓고 보내지 않습니다.');
pipeline.start();

const app = createApp({
  db,
  adminBasicAuth: config.ADMIN_BASIC_AUTH,
  startedAt,
  discordState: () => bot?.state() ?? 'disabled',
});
const server = app.listen(config.PORT, () => console.log(`listening on :${config.PORT}`));

// Railway는 재배포 때 SIGTERM을 보낸다.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} 수신, 종료합니다`);
  setTimeout(() => process.exit(1), 10_000).unref();
  await scheduler.stop();
  await pipeline.stop();
  await bot?.stop();
  server.close(() => {
    client.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
