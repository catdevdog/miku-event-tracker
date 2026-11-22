import type { Source } from '../db/schema.js';

/** 어댑터가 돌려주는 수집 원문 한 건. raw_items에 (source_id, external_id) 기준으로 넣는다. */
export interface RawItemInput {
  externalId: string;
  url?: string;
  title?: string;
  body?: string;
  lang?: string;
  publishedAt?: string;
  contentHash: string;
  /** 네이버 검색처럼 보관 기한이 있는 원문 */
  purgeAfter?: string;
}

export interface AdapterResult {
  /** 새 글만 */
  items: RawItemInput[];
  /** since_id, etag, 페이지 해시 등. 주면 sources.state를 이 값으로 바꾼다. */
  state?: Record<string, unknown>;
}

export interface AdapterContext {
  now: Date;
  /** 이전 실행이 남긴 sources.state */
  state: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface SourceAdapter {
  run(source: Source, ctx: AdapterContext): Promise<AdapterResult>;
}

export type AdapterRegistry = Partial<Record<Source['adapter'], SourceAdapter>>;
