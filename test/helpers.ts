import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

/** 테스트마다 임시 파일 DB를 만든다. (:memory:는 연결마다 다른 DB라 쓰지 않는다) */
export async function makeTestDb(): Promise<DbHandle & { cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'miku-test-'));
  const handle = await openDb({ url: `file:${join(dir, 'test.db')}` });
  await runMigrations(handle.db);
  return {
    ...handle,
    cleanup: () => {
      handle.client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
