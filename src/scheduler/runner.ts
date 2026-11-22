import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobRuns, rawItems, sources, type Source } from '../db/schema.js';
import { AlertNowError, type AdapterRegistry } from '../adapters/types.js';
import type { Alerter } from '../alerts.js';
import { toIso } from '../lib/time.js';
import { acquireLock, releaseLock } from './lock.js';

export const FAILURE_ALERT_THRESHOLD = 3;
/** 한 소스 실행이 이보다 오래 걸리면 락이 풀려 다음 틱이 다시 잡을 수 있다. */
export const SOURCE_LOCK_TTL_MIN = 30;

export type RunOutcome = 'ok' | 'error' | 'skipped' | 'locked';

export interface RunDeps {
  db: Db;
  adapters: AdapterRegistry;
  alerter: Alerter;
  owner: string;
  now?: () => Date;
}

const parseJson = (s: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(s);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

/**
 * 소스 하나를 실행한다.
 * 락 → job_runs(running) → 어댑터 → raw_items 저장 → job_runs 마감 → 실패 횟수·경보 → 락 해제
 */
export async function runSource(deps: RunDeps, source: Source): Promise<RunOutcome> {
  const { db, adapters, alerter, owner } = deps;
  const now = deps.now ?? (() => new Date());
  const lockName = `source:${source.id}`;

  if (!(await acquireLock(db, lockName, owner, SOURCE_LOCK_TTL_MIN, now()))) return 'locked';

  const startedAt = toIso(now());
  try {
    const [run] = await db
      .insert(jobRuns)
      .values({ sourceId: source.id, startedAt, status: 'running' })
      .returning({ id: jobRuns.id });
    if (!run) throw new Error('job_runs 행을 만들지 못했습니다');
    await db.update(sources).set({ lastRunAt: startedAt }).where(eq(sources.id, source.id));

    const adapter = adapters[source.adapter];
    if (!adapter) {
      await db
        .update(jobRuns)
        .set({ status: 'skipped', finishedAt: toIso(now()), error: `어댑터 미구현: ${source.adapter}` })
        .where(eq(jobRuns.id, run.id));
      return 'skipped';
    }

    try {
      const result = await adapter.run(source, {
        now: now(),
        state: parseJson(source.state),
        config: parseJson(source.config),
      });

      let itemsNew = 0;
      for (const item of result.items) {
        const inserted = await db
          .insert(rawItems)
          .values({
            sourceId: source.id,
            externalId: item.externalId,
            url: item.url,
            title: item.title,
            body: item.body,
            lang: item.lang,
            publishedAt: item.publishedAt,
            contentHash: item.contentHash,
            purgeAfter: item.purgeAfter,
          })
          .onConflictDoNothing({ target: [rawItems.sourceId, rawItems.externalId] })
          .returning({ id: rawItems.id });
        itemsNew += inserted.length;
      }

      const finishedAt = toIso(now());
      await db.update(jobRuns).set({ status: 'ok', finishedAt, itemsNew }).where(eq(jobRuns.id, run.id));
      await db
        .update(sources)
        .set({
          lastSuccessAt: finishedAt,
          consecutiveFailures: 0,
          ...(result.state ? { state: JSON.stringify(result.state) } : {}),
        })
        .where(eq(sources.id, source.id));

      for (const note of result.notes ?? []) await alerter.alert(`${source.name}: ${note}`);
      if (source.consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
        await alerter.alert(`회복: ${source.name} (연속 실패 ${source.consecutiveFailures}회 후 성공)`);
      }
      return 'ok';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(jobRuns)
        .set({ status: 'error', finishedAt: toIso(now()), error: message.slice(0, 2000) })
        .where(eq(jobRuns.id, run.id));
      const [updated] = await db
        .update(sources)
        .set({ consecutiveFailures: sql`${sources.consecutiveFailures} + 1` })
        .where(eq(sources.id, source.id))
        .returning({ failures: sources.consecutiveFailures });
      // 키·요청 형식 오류처럼 재시도해도 안 되는 오류는 바로 알린다.
      if (err instanceof AlertNowError) {
        await alerter.alert(`수집 오류: ${source.name}\n${message.slice(0, 500)}`);
      } else if (updated?.failures === FAILURE_ALERT_THRESHOLD) {
        // 임계값에 처음 닿을 때 한 번만 알린다.
        await alerter.alert(`수집 실패 ${FAILURE_ALERT_THRESHOLD}회 연속: ${source.name}\n${message.slice(0, 500)}`);
      }
      return 'error';
    }
  } finally {
    await releaseLock(db, lockName, owner);
  }
}

/** 재시작으로 끊긴 실행(running으로 남은 job_runs)을 error로 마감한다. */
export async function closeInterruptedRuns(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(jobRuns)
    .set({ status: 'error', finishedAt: toIso(now), error: '프로세스 재시작으로 중단됨' })
    .where(eq(jobRuns.status, 'running'))
    .returning({ id: jobRuns.id });
  return rows.length;
}

/**
 * 마지막 실행이 'skipped'(어댑터 미구현)였던 소스는 다음 틱에 바로 돌도록 last_run_at을 비운다.
 * 새 어댑터를 배포했을 때 주기(최대 하루)만큼 기다리지 않게 하기 위해서다.
 */
export async function resetSkippedSources(db: Db): Promise<number> {
  const rows = await db.all<{ id: number }>(sql`
    UPDATE sources SET last_run_at = NULL
    WHERE last_run_at IS NOT NULL AND id IN (
      SELECT jr.source_id FROM job_runs jr
      WHERE jr.status = 'skipped'
        AND jr.id = (SELECT max(id) FROM job_runs WHERE source_id = jr.source_id)
    )
    RETURNING id
  `);
  return rows.length;
}

