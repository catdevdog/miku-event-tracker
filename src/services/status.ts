import { desc, gte, sql, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobRuns, sources } from '../db/schema.js';
import { FAILURE_ALERT_THRESHOLD } from '../scheduler/runner.js';

export interface ServiceStatus {
  sourcesTotal: number;
  sourcesEnabled: number;
  /** 연속 실패가 경보 기준 이상인 소스 이름 */
  failingSources: string[];
  lastJobRunAt: string | null;
}

/** /health, /ping, 관리 화면이 같이 쓰는 상태 조회 */
export async function getServiceStatus(db: Db): Promise<ServiceStatus> {
  const [counts] = await db
    .select({ total: sql<number>`count(*)`, enabled: sql<number>`sum(${sources.enabled} = 1 AND ${sources.paused} = 0)` })
    .from(sources)
    .where(ne(sources.adapter, 'manual'));
  const failing = await db
    .select({ name: sources.name })
    .from(sources)
    .where(gte(sources.consecutiveFailures, FAILURE_ALERT_THRESHOLD));
  const [last] = await db.select({ startedAt: jobRuns.startedAt }).from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(1);
  return {
    sourcesTotal: Number(counts?.total ?? 0),
    sourcesEnabled: Number(counts?.enabled ?? 0),
    failingSources: failing.map((f) => f.name),
    lastJobRunAt: last?.startedAt ?? null,
  };
}
