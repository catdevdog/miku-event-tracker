import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.js';
import { ADAPTERS, KEYWORD_TIERS, LAYERS, SOURCE_REGIONS, keywords, sources } from './schema.js';

const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

const sourceSeed = z.object({
  name: z.string().min(1),
  layer: z.enum(LAYERS),
  adapter: z.enum(ADAPTERS),
  target: z.string().min(1),
  region: z.enum(SOURCE_REGIONS),
  interval_min: z.number().int().positive(),
  boost_interval_min: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const keywordSeed = z.object(
  Object.fromEntries(KEYWORD_TIERS.map((t) => [t, z.array(z.string().min(1))])) as Record<
    (typeof KEYWORD_TIERS)[number],
    z.ZodArray<z.ZodString>
  >,
);

export type SourceSeed = z.infer<typeof sourceSeed>;
export type KeywordSeed = z.infer<typeof keywordSeed>;

export function readSeedFiles(dir = SEED_DIR): { sources: SourceSeed[]; keywords: KeywordSeed } {
  const rawSources: unknown = JSON.parse(readFileSync(`${dir}sources.json`, 'utf8'));
  const rawKeywords: unknown = JSON.parse(readFileSync(`${dir}keywords.json`, 'utf8'));
  const parsedSources = z.array(sourceSeed).parse(rawSources);
  const names = parsedSources.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`seed/sources.json에 같은 name이 두 번 있습니다: ${dup}`);
  return { sources: parsedSources, keywords: keywordSeed.parse(rawKeywords) };
}

/** 표기 문자로 언어를 추정한다. 한글 → ko, 가나·한자 → ja, 그 외 → en */
export function detectLang(term: string): 'ko' | 'ja' | 'en' {
  if (/[가-힣]/.test(term)) return 'ko';
  if (/[぀-ヿ一-鿿]/.test(term)) return 'ja';
  return 'en';
}

export interface SeedResult {
  sourcesInserted: number;
  sourcesUpdated: number;
  keywordsUpserted: number;
}

/**
 * seed/*.json을 DB에 반영한다. 여러 번 실행해도 결과가 같다.
 * - sources: name 기준. 정의 필드(layer~config, enabled)만 덮어쓰고 state·실행 기록은 건드리지 않는다.
 * - keywords: term 기준. tier·lang을 덮어쓴다. 시드에 없는 키워드는 지우지 않는다(관리 화면에서 추가한 것 보존).
 */
export async function seedDatabase(db: Db, data = readSeedFiles()): Promise<SeedResult> {
  const result: SeedResult = { sourcesInserted: 0, sourcesUpdated: 0, keywordsUpserted: 0 };

  for (const s of data.sources) {
    const values = {
      name: s.name,
      layer: s.layer,
      adapter: s.adapter,
      target: s.target,
      region: s.region,
      intervalMin: s.interval_min,
      boostIntervalMin: s.boost_interval_min ?? null,
      config: JSON.stringify(s.config ?? {}),
      enabled: s.enabled === false ? 0 : 1,
    };
    const existed = (await db.select({ id: sources.id }).from(sources).where(eq(sources.name, s.name))).length > 0;
    await db.insert(sources).values(values).onConflictDoUpdate({ target: sources.name, set: values });
    if (existed) result.sourcesUpdated++;
    else result.sourcesInserted++;
  }

  for (const tier of KEYWORD_TIERS) {
    for (const term of data.keywords[tier]) {
      const lang = detectLang(term);
      await db
        .insert(keywords)
        .values({ term, tier, lang })
        .onConflictDoUpdate({ target: keywords.term, set: { tier, lang } });
      result.keywordsUpserted++;
    }
  }

  return result;
}

// `npm run db:seed`로 직접 실행할 때
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig, loadDotEnvIfPresent } = await import('../config.js');
  const { openDb } = await import('./client.js');
  const { runMigrations } = await import('./migrate.js');
  loadDotEnvIfPresent();
  const config = loadConfig();
  const { client, db } = await openDb({ url: config.DATABASE_URL, authToken: config.TURSO_AUTH_TOKEN });
  await runMigrations(db);
  console.log(await seedDatabase(db));
  client.close();
}
