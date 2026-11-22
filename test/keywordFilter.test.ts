import { describe, expect, it } from 'vitest';
import { judgeKeywords } from '../src/pipeline/keywordFilter.js';
import { readSeedFiles } from '../src/db/seed.js';

const set = readSeedFiles().keywords;

describe('키워드 필터 (CLAUDE.md 규칙 2)', () => {
  it("'하츠네 미쿠'는 strong으로 통과", () => {
    expect(judgeKeywords('하츠네 미쿠 HATSUNE MIKU EXPO 2025 in Seoul', set)).toMatchObject({ hit: 'strong', pass: true });
  });
  it("'미쿠 팝업'은 weak + context로 통과", () => {
    expect(judgeKeywords('홍대 미쿠 팝업 스토어 오픈', set)).toMatchObject({ hit: 'weak', pass: true });
  });
  it("'미쿠'만 있고 맥락어가 없으면 버림, implicitContext면 통과", () => {
    expect(judgeKeywords('미쿠 생일 축하해', set).pass).toBe(false);
    expect(judgeKeywords('MIKU 라이브 투어', set, { implicitContext: true })).toMatchObject({ hit: 'weak', pass: true });
  });
  it("'나카노 미쿠'만 있는 글은 맥락어가 있어도 버림", () => {
    expect(judgeKeywords('나카노 미쿠 생일 기념 카페 콜라보', set)).toMatchObject({ hit: 'none', pass: false });
  });
  it('공백·전각·대소문자 차이를 무시한다', () => {
    expect(judgeKeywords('하츠네미쿠 콘서트', set).hit).toBe('strong');
    expect(judgeKeywords('ＨＡＴＳＵＮＥ　ＭＩＫＵ', set).hit).toBe('strong');
    expect(judgeKeywords('プロジェクトセカイ COLORFUL LIVE 6th', set).hit).toBe('strong');
  });
});
