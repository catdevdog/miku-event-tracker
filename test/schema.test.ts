import { describe, expect, it } from 'vitest';
import { buildBoth, diffSchemas } from '../scripts/schema-diff.js';

describe('drizzle 마이그레이션 ↔ docs/schema.sql', () => {
  it('알려진 차이 하나 외에는 같다', async () => {
    const { expected, actual } = await buildBoth();
    const diffs = await diffSchemas(expected, actual);
    // 알려진 차이: docs의 job_locks.name은 TEXT PRIMARY KEY라 SQLite 규칙상 NULL이 허용되고,
    // drizzle은 기본키에 NOT NULL을 붙인다. docs/schema.sql에 NOT NULL을 추가하면 이 예외를 지운다.
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatch(/^job_locks\.columns/);
    expect(diffs[0]).toContain('name:text:notnull=0');
    expect(diffs[0]).toContain('name:text:notnull=1');
  });
});
