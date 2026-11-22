import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, releaseLock } from '../src/scheduler/lock.js';
import { addMinutes } from '../src/lib/time.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.cleanup());

describe('job_locks', () => {
  it('동시에 획득하면 하나만 성공', async () => {
    const now = new Date('2026-11-22T00:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => acquireLock(t.db, 'source:1', `owner-${i}`, 10, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('만료 전에는 다른 소유자가 못 가져가고, 만료 후에는 가져간다', async () => {
    const now = new Date('2026-11-22T00:00:00Z');
    expect(await acquireLock(t.db, 'job', 'a', 10, now)).toBe(true);
    expect(await acquireLock(t.db, 'job', 'b', 10, addMinutes(now, 9))).toBe(false);
    expect(await acquireLock(t.db, 'job', 'b', 10, addMinutes(now, 10))).toBe(true);
  });

  it('남의 락은 풀지 못하고, 자기 락은 푼다', async () => {
    const now = new Date('2026-11-22T00:00:00Z');
    await acquireLock(t.db, 'job', 'a', 10, now);
    await releaseLock(t.db, 'job', 'b');
    expect(await acquireLock(t.db, 'job', 'b', 10, now)).toBe(false);
    await releaseLock(t.db, 'job', 'a');
    expect(await acquireLock(t.db, 'job', 'b', 10, now)).toBe(true);
  });
});
