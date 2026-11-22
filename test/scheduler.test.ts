import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase } from '../src/db/seed.js';
import { jobRuns, rawItems, sources } from '../src/db/schema.js';
import { createScheduler } from '../src/scheduler/index.js';
import { isSchedulable, jitterMin } from '../src/scheduler/due.js';
import { runSource, closeInterruptedRuns, resetSkippedSources } from '../src/scheduler/runner.js';
import type { AdapterRegistry, SourceAdapter } from '../src/adapters/types.js';
import type { Alerter } from '../src/alerts.js';
import { addMinutes } from '../src/lib/time.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
});
afterEach(() => t.cleanup());

const noop: SourceAdapter = { run: async () => ({ items: [] }) };
const allNoop: AdapterRegistry = Object.fromEntries(
  (['rss', 'html_diff', 'playwright', 'x_crawl', 'instagram', 'kopis', 'naver', 'ticket'] as const).map((a) => [a, noop]),
);
const alerter = (): Alerter & { messages: string[] } => {
  const messages: string[] = [];
  return { messages, alert: async (m) => void messages.push(m) };
};

describe('스케줄러', () => {
  it('enabled=0 이거나 target=TODO인 소스는 대상에서 뺀다', async () => {
    const all = await t.db.select().from(sources);
    expect(all.filter(isSchedulable)).toHaveLength(32);
  });

  it('no-op 어댑터로 한 틱을 돌리면 32개 모두 ok로 기록되고, 바로 다음 틱에는 차례가 없다', async () => {
    const now = new Date('2026-11-22T00:00:00Z');
    const s = createScheduler({ db: t.db, adapters: allNoop, alerter: alerter(), now: () => now });
    const r1 = await s.tick();
    expect(r1).toMatchObject({ checked: 32, due: 32, outcomes: { ok: 32, error: 0, skipped: 0, locked: 0 } });
    const runs = await t.db.select().from(jobRuns);
    expect(runs).toHaveLength(32);
    expect(runs.every((r) => r.status === 'ok' && r.finishedAt)).toBe(true);

    const r2 = await s.tick();
    expect(r2.due).toBe(0);
  });

  it('주기가 지나면 다시 차례가 온다 (x_crawl은 ±10분 지터)', async () => {
    let now = new Date('2026-11-22T00:00:00Z');
    const s = createScheduler({ db: t.db, adapters: allNoop, alerter: alerter(), now: () => now });
    await s.tick();
    now = addMinutes(now, 71); // 60분 주기 + 최대 지터 10분 초과
    const r = await s.tick();
    const hourly = (await t.db.select().from(sources)).filter((x) => isSchedulable(x) && x.intervalMin === 60);
    expect(r.due).toBe(hourly.length);
  });

  it('어댑터가 없으면 skipped로만 남고 성공 시각은 바뀌지 않는다', async () => {
    const s = createScheduler({ db: t.db, adapters: {}, alerter: alerter() });
    const r = await s.tick();
    expect(r.outcomes.skipped).toBe(32);
    const src = await t.db.select().from(sources);
    expect(src.every((x) => x.lastSuccessAt === null)).toBe(true);
  });

  it('지터는 -10~+10분이고 같은 실행 주기 안에서는 같은 값', async () => {
    const x = (await t.db.select().from(sources)).filter((s) => s.adapter === 'x_crawl');
    for (const s of x) {
      const j = jitterMin(s);
      expect(j).toBeGreaterThanOrEqual(-10);
      expect(j).toBeLessThanOrEqual(10);
      expect(jitterMin(s)).toBe(j);
    }
    const rss = (await t.db.select().from(sources)).find((s) => s.adapter === 'rss')!;
    expect(jitterMin(rss)).toBe(0);
  });
});

describe('runSource', () => {
  const pick = async () => (await t.db.select().from(sources).where(eq(sources.adapter, 'kopis')))[0]!;

  it('새 글만 raw_items에 넣고 state를 저장한다', async () => {
    const adapter: SourceAdapter = {
      run: async () => ({
        items: [
          { externalId: 'a', contentHash: 'h1', title: '하츠네 미쿠' },
          { externalId: 'b', contentHash: 'h2' },
        ],
        state: { last_afterdate: '20261122' },
      }),
    };
    const deps = { db: t.db, adapters: { kopis: adapter }, alerter: alerter(), owner: 'test' };
    expect(await runSource(deps, await pick())).toBe('ok');
    expect(await runSource(deps, await pick())).toBe('ok');
    expect(await t.db.select().from(rawItems)).toHaveLength(2);
    const runs = await t.db.select().from(jobRuns).orderBy(jobRuns.id);
    expect(runs.map((r) => r.itemsNew)).toEqual([2, 0]);
    expect((await pick()).state).toBe('{"last_afterdate":"20261122"}');
  });

  it('3회 연속 실패에서 한 번만 경보하고, 회복하면 회복 경보', async () => {
    const fail: SourceAdapter = { run: vi.fn(async () => Promise.reject(new Error('timeout'))) };
    const a = alerter();
    const deps = { db: t.db, adapters: { kopis: fail }, alerter: a, owner: 'test' };
    for (let i = 0; i < 4; i++) expect(await runSource(deps, await pick())).toBe('error');
    expect((await pick()).consecutiveFailures).toBe(4);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toContain('3회 연속');

    const okDeps = { ...deps, adapters: { kopis: noop } };
    expect(await runSource(okDeps, await pick())).toBe('ok');
    expect((await pick()).consecutiveFailures).toBe(0);
    expect(a.messages[1]).toContain('회복');
  });

  it('재시작으로 running에 남은 실행을 error로 정리한다', async () => {
    const s = await pick();
    await t.db.insert(jobRuns).values({ sourceId: s.id, startedAt: '2026-11-22T00:00:00.000Z', status: 'running' });
    expect(await closeInterruptedRuns(t.db)).toBe(1);
    const [run] = await t.db.select().from(jobRuns);
    expect(run!.status).toBe('error');
  });

  it('마지막 실행이 skipped였던 소스는 last_run_at을 비워 바로 돌게 한다', async () => {
    const s = createScheduler({ db: t.db, adapters: {}, alerter: alerter() });
    await s.tick();
    expect(await resetSkippedSources(t.db)).toBe(32);
    const src = await t.db.select().from(sources);
    expect(src.every((x) => x.lastRunAt === null)).toBe(true);
    const s2 = createScheduler({ db: t.db, adapters: allNoop, alerter: alerter() });
    await s2.tick();
    expect(await resetSkippedSources(t.db)).toBe(0);
  });
});
