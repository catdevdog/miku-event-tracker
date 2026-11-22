import { describe, expect, it } from 'vitest';
import { buildBoth, diffSchemas } from '../scripts/schema-diff.js';

describe('drizzle 마이그레이션 ↔ docs/schema.sql', () => {
  it('구조가 같다 (컬럼, 기본키, 외래 키, UNIQUE, 인덱스, CHECK)', async () => {
    const { expected, actual } = await buildBoth();
    expect(await diffSchemas(expected, actual)).toEqual([]);
  });
});
