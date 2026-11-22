import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { addMinutes, toIso } from '../lib/time.js';

/**
 * job_locks로 같은 작업의 중복 실행을 막는다.
 * 비어 있거나 만료된 락만 가져가는 UPSERT 한 문장이라 동시에 불러도 한쪽만 성공한다.
 */
export async function acquireLock(
  db: Db,
  name: string,
  owner: string,
  ttlMin: number,
  now = new Date(),
): Promise<boolean> {
  const nowIso = toIso(now);
  const until = toIso(addMinutes(now, ttlMin));
  const rows = await db.all<{ name: string }>(sql`
    INSERT INTO job_locks (name, owner, locked_until) VALUES (${name}, ${owner}, ${until})
    ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, locked_until = excluded.locked_until
      WHERE job_locks.locked_until <= ${nowIso}
    RETURNING name
  `);
  return rows.length === 1;
}

/** 자기가 가진 락만 푼다. */
export async function releaseLock(db: Db, name: string, owner: string): Promise<void> {
  await db.run(sql`DELETE FROM job_locks WHERE name = ${name} AND owner = ${owner}`);
}
