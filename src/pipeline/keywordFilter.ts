import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { keywords } from '../db/schema.js';

export interface KeywordSet {
  strong: string[];
  weak: string[];
  context: string[];
  exclude: string[];
}

export interface KeywordVerdict {
  /** raw_items.keyword_hit 값 */
  hit: 'strong' | 'weak' | 'none';
  /** LLM으로 넘길지 */
  pass: boolean;
  matched: KeywordSet;
}

/**
 * 비교용 정규화: NFKC(전각·반각 통일) → 소문자 → 공백 제거.
 * '하츠네미쿠'와 '하츠네 미쿠', 'ＭＩＫＵ'와 'miku'를 같게 본다.
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * CLAUDE.md 규칙 2.
 * - strong 1개 이상 → 통과
 * - weak는 context와 같이 있을 때만 통과 (implicitContext면 context 없이 통과: KOPIS·예매처처럼 출처 자체가 공연인 경우)
 * - exclude가 걸리고 strong이 없으면 버림
 */
export function judgeKeywords(text: string, set: KeywordSet, opts: { implicitContext?: boolean } = {}): KeywordVerdict {
  const t = normalizeForMatch(text);
  const find = (terms: string[]) => terms.filter((term) => t.includes(normalizeForMatch(term)));
  const matched: KeywordSet = {
    strong: find(set.strong),
    weak: find(set.weak),
    context: find(set.context),
    exclude: find(set.exclude),
  };
  if (matched.strong.length > 0) return { hit: 'strong', pass: true, matched };
  if (matched.exclude.length > 0) return { hit: 'none', pass: false, matched };
  if (matched.weak.length > 0) {
    const pass = matched.context.length > 0 || opts.implicitContext === true;
    return { hit: pass ? 'weak' : 'none', pass, matched };
  }
  return { hit: 'none', pass: false, matched };
}

export async function loadKeywordSet(db: Db): Promise<KeywordSet> {
  // /관리에서 삭제한 키워드(disabled=1)는 뺀다
  const rows = await db.select({ term: keywords.term, tier: keywords.tier }).from(keywords).where(eq(keywords.disabled, 0));
  const set: KeywordSet = { strong: [], weak: [], context: [], exclude: [] };
  for (const r of rows) set[r.tier].push(r.term);
  return set;
}
