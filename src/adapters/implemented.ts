/**
 * 구현된 어댑터 이름. registry.ts가 이 목록과 똑같은 키로 어댑터를 만든다(타입으로 강제).
 * 여기에 없는 어댑터(instagram, playwright)의 소스는 실행 때 job_runs에 'skipped'로만 남는다.
 * 무거운 의존성(playwright 등) 없이 /가이드·/점검이 쓸 수 있게 따로 둔다.
 */
export const IMPLEMENTED_ADAPTERS = ['rss', 'html_diff', 'ticket', 'kopis', 'x_crawl', 'naver'] as const;
export type ImplementedAdapter = (typeof IMPLEMENTED_ADAPTERS)[number];

export function isImplementedAdapter(adapter: string): adapter is ImplementedAdapter {
  return (IMPLEMENTED_ADAPTERS as readonly string[]).includes(adapter);
}
