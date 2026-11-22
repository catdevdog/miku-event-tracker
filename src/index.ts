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
import { listUpcomingEvents } from './services/events.js';
import { isNotifyPaused } from './services/settings.js';
import { createDiscordJobs } from './notify/discordJobs.js';
import { createInteractionHandlers } from './notify/interactions.js';
import { deliverNotice } from './notify/noticeThreads.js';
import { createQaAnswerer } from './services/qa.js';
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

const qa = config.ANTHROPIC_API_KEY ? createQaAnswerer(db, config.ANTHROPIC_API_KEY) : undefined;

// 디스코드 주기 작업: 검수 카드·제보 결과(1분), 알림 역할·구독 패널·기본 구독·상태판·서버 이벤트(10분), 이번 주 요약(월 09:00 KST)
const discordJobs = createDiscordJobs({
  db,
  bot: () => bot,
  notifier,
  alerter,
  adminChannelId: config.DISCORD_ADMIN_CHANNEL_ID,
  noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID,
  notifyPausedEnv: config.NOTIFY_PAUSED,
});

if (config.DISCORD_BOT_TOKEN && config.DISCORD_APP_ID && config.DISCORD_GUILD_ID) {
  // 봇 토큰은 점(.)으로 나뉜 세 부분이다. Client Secret(점 없음)을 잘못 넣은 경우를 미리 알린다.
  if (config.DISCORD_BOT_TOKEN.split('.').length !== 3) {
    console.warn('DISCORD_BOT_TOKEN이 봇 토큰 형식(점으로 나뉜 세 부분)이 아닙니다. Client Secret을 넣은 것은 아닌지 확인하세요.');
  }
  const handlers = createInteractionHandlers({
    db,
    bot: () => bot,
    notifier,
    guildId: config.DISCORD_GUILD_ID,
    noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID,
    adminChannelId: config.DISCORD_ADMIN_CHANNEL_ID,
    notifyPausedEnv: config.NOTIFY_PAUSED,
    uptimeSec,
    setupNow: async () => {
      const r = await discordJobs.setup();
      await discordJobs.statusBoard().catch(() => null);
      return r;
    },
  });

  bot = startDiscordBot({
    token: config.DISCORD_BOT_TOKEN,
    appId: config.DISCORD_APP_ID,
    guildId: config.DISCORD_GUILD_ID,
    ...handlers,
    onMention: async (question) => {
      if (!qa) return '질문 답변은 Claude API 키(ANTHROPIC_API_KEY)가 있어야 쓸 수 있어요. `/행사`로 목록을 볼 수 있어요.';
      return qa.answer(question);
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
  // 환경 변수 NOTIFY_PAUSED 또는 /관리 알림 일시정지
  notifyPaused: () => isNotifyPaused(db, config.NOTIFY_PAUSED),
  // 공지 채널: 새 행사는 지역 역할 멘션 + 스레드, 상태 변경은 원래 카드 수정 + 스레드
  deliverNotice: (job) =>
    deliverNotice({ db, notifier, noticeChannelId: config.DISCORD_NOTICE_CHANNEL_ID, bot: bot?.isReady() ? bot : undefined, log: console }, job),
});
if (config.NOTIFY_PAUSED) console.warn('NOTIFY_PAUSED: 알림을 큐에만 쌓고 보내지 않습니다.');
pipeline.start();

if (bot) discordJobs.start();

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
  discordJobs.stop();
  await bot?.stop();
  server.close(() => {
    client.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
