import { readFileSync } from 'node:fs';
import type { Source } from '../src/db/schema.js';
import type { FetchText } from '../src/adapters/http.js';

export const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');

export function fakeSource(over: Partial<Source> = {}): Source {
  return {
    id: 1,
    name: '테스트 소스',
    layer: 'L1',
    adapter: 'rss',
    target: 'https://example.com/',
    region: 'JP',
    intervalMin: 60,
    boostIntervalMin: null,
    config: '{}',
    state: '{}',
    enabled: 1,
    lastRunAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
    ...over,
  };
}

/** URL 패턴별로 응답을 돌려주는 가짜 fetch. 호출 기록을 남긴다. */
export function fakeFetch(routes: [RegExp, string | ((url: string) => string)][]): FetchText & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes.find(([re]) => re.test(url));
    if (!r) throw new Error(`라우트 없음: ${url}`);
    return { status: 200, url, text: typeof r[1] === 'function' ? r[1](url) : r[1] };
  }) as FetchText & { calls: string[] };
  fn.calls = calls;
  return fn;
}
