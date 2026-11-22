import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { detectLang, readSeedFiles, seedDatabase } from '../src/db/seed.js';
import { keywords, sources } from '../src/db/schema.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.cleanup());

const count = async (table: typeof sources | typeof keywords) =>
  Number((await t.db.select({ n: sql<number>`count(*)` }).from(table))[0]?.n);

describe('seed', () => {
  it('시드 파일 내용이 CLAUDE.md 수치와 맞다', () => {
    const data = readSeedFiles();
    expect(data.sources).toHaveLength(35);
    expect(data.keywords.strong).toHaveLength(22);
    expect(data.keywords.weak).toHaveLength(12);
    expect(data.keywords.context).toHaveLength(19);
    expect(data.keywords.exclude).toHaveLength(2);
  });

  it('두 번 실행해도 행 수가 같다', async () => {
    const first = await seedDatabase(t.db);
    expect(first).toEqual({ sourcesInserted: 35, sourcesUpdated: 0, keywordsUpserted: 55 });
    const second = await seedDatabase(t.db);
    expect(second).toEqual({ sourcesInserted: 0, sourcesUpdated: 35, keywordsUpserted: 55 });
    expect(await count(sources)).toBe(35);
    expect(await count(keywords)).toBe(55);
  });

  it('다시 시드해도 state와 실행 기록은 보존한다', async () => {
    await seedDatabase(t.db);
    const [s] = await t.db.select().from(sources).limit(1);
    await t.db
      .update(sources)
      .set({ state: '{"since_id":"123"}', lastRunAt: '2026-11-22T00:00:00.000Z', consecutiveFailures: 2 })
      .where(eq(sources.id, s!.id));
    await seedDatabase(t.db);
    const [after] = await t.db.select().from(sources).where(eq(sources.id, s!.id));
    expect(after!.state).toBe('{"since_id":"123"}');
    expect(after!.lastRunAt).toBe('2026-11-22T00:00:00.000Z');
    expect(after!.consecutiveFailures).toBe(2);
  });

  it('enabled=false 소스는 0으로 들어간다', async () => {
    await seedDatabase(t.db);
    const disabled = await t.db.select({ name: sources.name }).from(sources).where(eq(sources.enabled, 0));
    expect(disabled).toHaveLength(5);
  });

  it('키워드 언어를 표기 문자로 추정한다', () => {
    expect(detectLang('하츠네 미쿠')).toBe('ko');
    expect(detectLang('初音ミク')).toBe('ja');
    expect(detectLang('プロセカ')).toBe('ja');
    expect(detectLang('Hatsune Miku')).toBe('en');
  });
});
