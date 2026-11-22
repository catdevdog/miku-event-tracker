import { loadConfig, loadDotEnvIfPresent } from './config.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { createScheduler } from './scheduler/index.js';
import { closeInterruptedRuns } from './scheduler/runner.js';
import { adapters } from './adapters/registry.js';
import { consoleAlerter } from './alerts.js';
import { createApp } from './app.js';

// 부트스트랩: 마이그레이션 → 시드 → 스케줄러 → (2단계: 디스코드 봇) → Express
loadDotEnvIfPresent();
const config = loadConfig();
const startedAt = new Date();

const { client, db } = await openDb({ url: config.DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
await runMigrations(db);
const seeded = await seedDatabase(db);
const interrupted = await closeInterruptedRuns(db);
console.log(
  `DB 준비 완료: 소스 추가 ${seeded.sourcesInserted}, 갱신 ${seeded.sourcesUpdated}, 키워드 ${seeded.keywordsUpserted}` +
    (interrupted ? `, 중단된 실행 ${interrupted}건 정리` : ''),
);

const scheduler = createScheduler({ db, adapters, alerter: consoleAlerter });
scheduler.start();

const app = createApp({ db, adminBasicAuth: config.ADMIN_BASIC_AUTH, startedAt });
const server = app.listen(config.PORT, () => console.log(`listening on :${config.PORT}`));

// Railway는 재배포 때 SIGTERM을 보낸다.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} 수신, 종료합니다`);
  await scheduler.stop();
  server.close(() => {
    client.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
