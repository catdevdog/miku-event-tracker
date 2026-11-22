// docs/schema.sql로 만든 DB와 drizzle 마이그레이션으로 만든 DB의 구조를 비교한다.
// 사용: npx tsx scripts/schema-diff.ts  (차이가 있으면 종료 코드 1)
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Row = Record<string, unknown>;

async function rows(c: Client, q: string): Promise<Row[]> {
  return (await c.execute(q)).rows as unknown as Row[];
}

const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[`"]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();

/** 기본값 표기 차이 제거: (datetime('now')) ↔ datetime('now') */
const normDefault = (v: unknown) => {
  if (v === null || v === undefined) return 'null';
  let s = norm(v);
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return s;
};

/** CREATE TABLE 문에서 CHECK(...) 식을 괄호 짝을 맞춰 뽑는다. */
function extractChecks(createSql: string): string[] {
  const out: string[] = [];
  const re = /check\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(createSql))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < createSql.length && depth > 0) {
      if (createSql[i] === '(') depth++;
      else if (createSql[i] === ')') depth--;
      i++;
    }
    out.push(norm(createSql.slice(start, i - 1)));
  }
  return out.sort();
}

interface TableShape {
  columns: string[];
  primaryKey: string;
  foreignKeys: string[];
  uniques: string[];
  indexes: string[];
  checks: string[];
}

async function describe(c: Client): Promise<Map<string, TableShape>> {
  const tables = await rows(
    c,
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
  );
  const result = new Map<string, TableShape>();
  for (const t of tables) {
    const name = String(t.name);
    const cols = await rows(c, `PRAGMA table_info('${name}')`);
    const pkCols = cols.filter((r) => Number(r.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
    const singleIntPk = pkCols.length === 1 && norm(pkCols[0]!.type) === 'integer';
    const columns = cols.map((r) => {
      // INTEGER PRIMARY KEY는 rowid 별칭이라 NOT NULL 표기 여부가 동작에 영향이 없다.
      const notnull = singleIntPk && Number(r.pk) === 1 ? 'pk' : String(r.notnull);
      return `${r.name}:${norm(r.type)}:notnull=${notnull}:default=${normDefault(r.dflt_value)}`;
    });
    const fks = (await rows(c, `PRAGMA foreign_key_list('${name}')`)).map(
      (r) => `${r.from}->${r.table}.${r.to}`,
    );
    const idx = await rows(c, `PRAGMA index_list('${name}')`);
    const uniques: string[] = [];
    const indexes: string[] = [];
    for (const i of idx) {
      if (i.origin === 'pk') continue;
      const icols = (await rows(c, `PRAGMA index_info('${String(i.name)}')`)).map((r) => String(r.name));
      // UNIQUE는 인라인 제약(sqlite_autoindex)과 CREATE UNIQUE INDEX가 같은 효과라 이름 없이 컬럼으로 비교한다.
      if (Number(i.unique) === 1) uniques.push(icols.join(','));
      else indexes.push(`${String(i.name)}(${icols.join(',')})`);
    }
    result.set(name, {
      columns: columns.sort(),
      primaryKey: pkCols.map((r) => String(r.name)).join(','),
      foreignKeys: fks.sort(),
      uniques: uniques.sort(),
      indexes: indexes.sort(),
      checks: extractChecks(String(t.sql)),
    });
  }
  return result;
}

export async function diffSchemas(expected: Client, actual: Client): Promise<string[]> {
  const a = await describe(expected);
  const b = await describe(actual);
  const diffs: string[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const ea = a.get(name);
    const eb = b.get(name);
    if (!ea) {
      diffs.push(`${name}: 마이그레이션에만 있음`);
      continue;
    }
    if (!eb) {
      diffs.push(`${name}: docs/schema.sql에만 있음`);
      continue;
    }
    for (const key of Object.keys(ea) as (keyof TableShape)[]) {
      const va = JSON.stringify(ea[key]);
      const vb = JSON.stringify(eb[key]);
      if (va !== vb) diffs.push(`${name}.${key}\n  docs:      ${va}\n  migration: ${vb}`);
    }
  }
  return diffs;
}

/** docs/schema.sql과 drizzle 마이그레이션으로 각각 메모리 DB를 만든다. */
export async function buildBoth(): Promise<{ expected: Client; actual: Client }> {
  const expected = createClient({ url: 'file::memory:' });
  await expected.executeMultiple(readFileSync(`${ROOT}docs/schema.sql`, 'utf8'));
  const actual = createClient({ url: 'file::memory:' });
  await migrate(drizzle(actual), { migrationsFolder: `${ROOT}drizzle` });
  return { expected, actual };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { expected, actual } = await buildBoth();
  const diffs = await diffSchemas(expected, actual);
  const tables = (await rows(actual, "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'"))[0]?.n;
  if (diffs.length === 0) {
    console.log(`차이 없음 (테이블 ${String(tables)}개: 컬럼, 기본키, 외래 키, UNIQUE, 인덱스, CHECK 비교)`);
  } else {
    console.log(diffs.join('\n'));
    process.exitCode = 1;
  }
}
