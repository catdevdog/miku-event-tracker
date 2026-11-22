import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Db } from './client.js';

/** 레포 루트의 drizzle/ 폴더. src와 dist 어디서 실행해도 같은 곳을 가리킨다. */
export const MIGRATIONS_DIR = resolve(fileURLToPath(new URL('../../drizzle', import.meta.url)));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

// `npm run db:migrate`로 직접 실행할 때
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig, loadDotEnvIfPresent } = await import('../config.js');
  const { openDb } = await import('./client.js');
  loadDotEnvIfPresent();
  const config = loadConfig();
  const { client, db } = await openDb({ url: config.DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
  await runMigrations(db);
  client.close();
  console.log('마이그레이션 완료');
}
