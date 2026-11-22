import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { sources, type Source } from '../db/schema.js';
import type { AdapterRegistry } from '../adapters/types.js';
import type { Alerter } from '../alerts.js';
import { isBoostActive, isDue, isSchedulable } from './due.js';
import { runSource, type RunOutcome } from './runner.js';

export interface SchedulerOptions {
  db: Db;
  adapters: AdapterRegistry;
  alerter: Alerter;
  /** 동시에 실행할 소스 수 */
  concurrency?: number;
  now?: () => Date;
}

export interface TickResult {
  checked: number;
  due: number;
  outcomes: Record<RunOutcome, number>;
}

/**
 * 1분마다 틱을 돌며 차례가 된 소스를 실행한다.
 * 소스마다 cron을 따로 두지 않는 이유: boost 주기와 X 지터가 실행 시점마다 바뀌기 때문.
 */
export function createScheduler(opts: SchedulerOptions) {
  const owner = `proc-${randomUUID()}`;
  const now = opts.now ?? (() => new Date());
  const concurrency = opts.concurrency ?? 3;
  const running = new Set<number>();
  let task: ScheduledTask | undefined;
  let ticking = false;

  async function dueSources(): Promise<{ all: Source[]; due: Source[] }> {
    const all = (await opts.db.select().from(sources)).filter(isSchedulable);
    const due: Source[] = [];
    for (const s of all) {
      if (running.has(s.id)) continue;
      const boost = await isBoostActive(opts.db, s, now());
      const interval = boost && s.boostIntervalMin ? s.boostIntervalMin : s.intervalMin;
      if (isDue(s, interval, now())) due.push(s);
    }
    return { all, due };
  }

  async function tick(): Promise<TickResult> {
    const { all, due } = await dueSources();
    const outcomes: Record<RunOutcome, number> = { ok: 0, error: 0, skipped: 0, locked: 0 };
    const queue = [...due];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        running.add(s.id);
        try {
          const outcome = await runSource({ db: opts.db, adapters: opts.adapters, alerter: opts.alerter, owner, now }, s);
          outcomes[outcome]++;
        } catch (err) {
          // runSource 안에서 기록하지 못한 오류(DB 장애 등)
          outcomes.error++;
          await opts.alerter.alert(`스케줄러 오류 (${s.name}): ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          running.delete(s.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { checked: all.length, due: due.length, outcomes };
  }

  return {
    owner,
    tick,
    start() {
      task = cron.schedule('* * * * *', async () => {
        if (ticking) return; // 이전 틱이 아직 돌고 있으면 건너뛴다
        ticking = true;
        try {
          await tick();
        } catch (err) {
          await opts.alerter.alert(`스케줄러 틱 실패: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          ticking = false;
        }
      });
    },
    async stop() {
      await task?.stop();
    },
  };
}
