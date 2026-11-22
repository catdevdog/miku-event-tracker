import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedDatabase, readSeedFiles } from '../src/db/seed.js';
import { events, eventSources, jobRuns, rawItems, sources } from '../src/db/schema.js';
import { listCollectionPlan } from '../src/services/sources.js';
import { getDiagnostics } from '../src/services/diagnostics.js';
import { buildGuideReply, intervalKo, scheduleLines } from '../src/notify/guide.js';
import { buildDiagnosticsReply } from '../src/notify/commands.js';
import { judgeKeywords } from '../src/pipeline/keywordFilter.js';
import { IMPLEMENTED_ADAPTERS } from '../src/adapters/implemented.js';
import type { OutgoingMessage } from '../src/notify/types.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
});
afterEach(() => t.cleanup());

type Embed = { title?: string; description?: string; footer?: { text: string }; author?: { name: string }; fields?: { name: string; value: string }[] };
const embeds = (m: OutgoingMessage) => m.embeds as Embed[];
/** 디스코드 제한: 메시지당 임베드 10개, 임베드 글자 합 6000자, 설명 4096자, 필드 값 1024자 */
function expectWithinDiscordLimits(m: OutgoingMessage) {
  const es = embeds(m);
  expect(es.length).toBeLessThanOrEqual(10);
  let total = 0;
  for (const e of es) {
    expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
    for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    total += (e.title ?? '').length + (e.description ?? '').length + (e.footer?.text ?? '').length + (e.author?.name ?? '').length;
    total += (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);
  }
  expect(total).toBeLessThanOrEqual(6000);
}

describe('/가이드', () => {
  it('주기 표기', () => {
    expect(intervalKo(60)).toBe('1시간마다');
    expect(intervalKo(180)).toBe('3시간마다');
    expect(intervalKo(1440)).toBe('하루 1번');
    expect(intervalKo(30)).toBe('30분마다');
  });

  it('수집 주기와 미수집 소스를 소스 설정에서 계산한다', async () => {
    const plan = await listCollectionPlan(t.db);
    const { active, boost, idle } = scheduleLines(plan);
    expect(active[0]).toMatch(/^\*\*1시간마다\*\*　/);
    expect(active[0]).toContain('X 계정 7곳 (±10분)');
    expect(active.some((l) => l.startsWith('**하루 1번**') && l.includes('KOPIS 공연목록 1곳'))).toBe(true);
    expect(boost.join('\n')).toContain('일러스타 페스');
    for (const name of ['네이버 검색', 'NOL 티켓', '인스타그램 @animatecafe_korea', 'AGF 공식 사이트']) expect(idle).toContain(name);
    expect(idle).not.toContain('멜론티켓');
  });

  it('임베드가 디스코드 제한 안에 들어간다', async () => {
    const m = buildGuideReply(await listCollectionPlan(t.db));
    expectWithinDiscordLimits(m);
    const text = JSON.stringify(m);
    for (const cmd of ['/행사', '/소스', '/최근수집', '/점검', '/ping', '/가이드']) expect(text).toContain(cmd);
    expect(text).toContain('인스타그램 · 네이버로 공지되는데');
  });

  it('인스타그램·네이버가 모두 수집되면 연결 전 안내를 빼고, 시드의 어댑터는 모두 이름이 있다', async () => {
    const plan = (await listCollectionPlan(t.db)).map((p) => ({ ...p, implemented: true, schedulable: true }));
    expect(JSON.stringify(buildGuideReply(plan))).not.toContain('연결 전');
    const adapters = new Set(readSeedFiles().sources.map((s) => s.adapter));
    for (const a of adapters) expect(JSON.stringify(scheduleLines(plan).active)).not.toContain(`**　${a} `);
    expect(IMPLEMENTED_ADAPTERS).toEqual(['rss', 'html_diff', 'ticket', 'kopis', 'x_crawl']);
  });
});

describe('/점검', () => {
  it('지역별 행사 수, 최근 국내 행사, 국내 소스 단계별 건수', async () => {
    const [melon] = await t.db.select().from(sources).where(eq(sources.name, '멜론티켓'));
    await t.db.update(sources).set({ lastSuccessAt: '2026-11-22T14:00:00.000Z' }).where(eq(sources.id, melon!.id));
    await t.db.insert(jobRuns).values({ sourceId: melon!.id, startedAt: '2026-11-22T14:00:00.000Z', status: 'ok', itemsNew: 3 });
    const [naver] = await t.db.select().from(sources).where(eq(sources.name, '네이버 검색 (뉴스·블로그·카페)'));
    await t.db.insert(jobRuns).values({ sourceId: naver!.id, startedAt: '2026-11-22T14:00:00.000Z', status: 'skipped' });

    const mk = (n: number, keywordHit: 'strong' | 'none', llmStatus: 'done' | 'skipped' | 'pending') =>
      t.db.insert(rawItems).values({ sourceId: melon!.id, externalId: `m${n}`, title: `t${n}`, contentHash: 'h', keywordHit, llmStatus }).returning();
    const [done] = await mk(1, 'strong', 'done');
    await mk(2, 'none', 'skipped');
    await mk(3, 'strong', 'pending');
    const [ev] = await t.db
      .insert(events)
      .values({ title: 'HATSUNE MIKU EXPO 2025 in Seoul', kind: 'concert', officiality: 'crypton', region: 'KR', startDate: '2025-11-29', endDate: '2025-11-30', status: 'ended', dedupKey: 'k1' })
      .returning();
    await t.db.insert(eventSources).values({ eventId: ev!.id, rawItemId: done!.id, extracted: '{}' });
    await t.db.insert(events).values({ title: 'マジカルミライ 2027', kind: 'concert', officiality: 'crypton', region: 'JP', startDate: '2027-08-20', status: 'announced', dedupKey: 'k2' });

    const d = await getDiagnostics(t.db);
    expect(d.regions).toEqual([
      { region: 'KR', upcoming: 0, ended: 1, cancelled: 0, needsReview: 0 },
      { region: 'JP', upcoming: 1, ended: 0, cancelled: 0, needsReview: 0 },
      { region: 'OTHER', upcoming: 0, ended: 0, cancelled: 0, needsReview: 0 },
    ]);
    const melonRow = d.krSources.find((r) => r.name === '멜론티켓')!;
    expect(melonRow).toMatchObject({ collected: 3, passed: 2, extracted: 1, linked: 1, implemented: true, schedulable: true, lastJobStatus: 'ok' });
    expect(d.krSources.find((r) => r.adapter === 'naver')).toMatchObject({ implemented: false, lastJobStatus: 'skipped' });
    expect(d.pendingItems).toBe(1);

    const m = buildDiagnosticsReply(d);
    expectWithinDiscordLimits(m);
    const [first, second] = embeds(m);
    expect(first!.description).toContain('국내  0       1     0     0');
    expect(first!.description).toContain('종료  25.11.29~11.30  HATSUNE MIKU EXPO 2025 in Seoul');
    expect(second!.description).toContain('가져온 글 3 → 키워드 통과 2 → Claude 판정 1 → 행사 연결 1');
    expect(second!.description).toContain('정상  3     2     1     1     멜론티켓');
    expect(second!.description).toContain('준비  0     0     0     0     네이버 검색');
    expect(second!.description).toContain('꺼짐  0     0     0     0     NOL 티켓');
  });

  it('국내 행사가 없으면 안내 문구', async () => {
    const m = buildDiagnosticsReply(await getDiagnostics(t.db));
    expect(embeds(m)[0]!.description).toContain('아직 국내 행사로 등록된 것이 없습니다.');
  });
});

describe('키워드 보강', () => {
  it("'미쿠 감사제'는 weak + context(감사제)로 통과", () => {
    const set = readSeedFiles().keywords;
    expect(judgeKeywords('미쿠 감사제 in 홍대', set).pass).toBe(true);
    expect(judgeKeywords('나카노 미쿠 굿즈', set).pass).toBe(false);
  });
});
