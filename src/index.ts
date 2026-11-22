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
import { buildPingReply } from './notify/commands.js';
import { getServiceStatus } from './services/status.js';

// 부트스트랩: 마이그레이션 → 시드 → 스케줄러 → 디스코드 봇 → Express
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
  bot = startDiscordBot({
    token: config.DISCORD_BOT_TOKEN,
    appId: config.DISCORD_APP_ID,
    guildId: config.DISCORD_GUILD_ID,
    onPing: async (wsPingMs) => buildPingReply({ status: await getServiceStatus(db), wsPingMs, uptimeSec: uptimeSec() }),
    onReady: async () => {
      const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
      await notifier.alerter.alert(`서비스 시작${commit ? ` (커밋 ${commit})` : ''}`);
    },
  });
} else {
  console.warn('DISCORD_BOT_TOKEN이 없어 디스코드 봇을 켜지 않습니다.');
}

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
  await bot?.stop();
  server.close(() => {
    client.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
