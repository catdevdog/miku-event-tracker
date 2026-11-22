import { createHash } from 'node:crypto';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, detail = '') {
    super(`HTTP ${status} ${url}${detail ? ` ${detail}` : ''}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResult {
  status: number;
  url: string;
  text: string;
}

export type FetchText = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

/** 2xx가 아니면 HttpError. 응답 본문은 텍스트로. 시크릿이 든 URL은 호출 쪽에서 마스킹해 넘긴다. */
/** Node fetch의 "fetch failed"는 원인이 cause에 들어 있어 메시지에 붙인다. */
function describeFetchError(err: unknown, url: string): Error {
  if (!(err instanceof Error)) return new Error(`${String(err)} ${url}`);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message ?? '';
  return new Error(`${err.name === 'TimeoutError' ? '시간 초과' : err.message}${detail ? ` (${detail})` : ''} ${url}`);
}

export const fetchText: FetchText = async (url, opts = {}) => {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'ko,ja;q=0.9,en;q=0.8', ...opts.headers },
    body: opts.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  }).catch((err: unknown) => {
    throw describeFetchError(err, url);
  });
  const text = opts.method === 'HEAD' ? '' : await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 200).replace(/\s+/g, ' '));
  return { status: res.status, url: res.url || url, text };
};

/** 상태 코드만 확인 (연도별 페이지 생성 감지). 4xx/5xx도 예외 없이 돌려준다. */
export async function fetchStatus(url: string, timeoutMs = 15_000): Promise<number> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: unknown) => {
    throw describeFetchError(err, url);
  });
  await res.body?.cancel();
  return res.status;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 공백 정리 */
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 아주 단순한 태그 제거 (RSS 설명문 등) */
export function stripTags(html: string): string {
  return squash(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#8230;/g, '…')
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))),
  );
}

/** 상태에 남기는 "본 항목" 목록은 최근 n개만 유지한다. */
export function rememberSeen(previous: string[], fresh: string[], cap = 1000): string[] {
  const set = new Set(previous);
  const out = [...previous];
  for (const f of fresh) if (!set.has(f)) out.push(f);
  return out.slice(-cap);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 한국 시간 기준 날짜 YYYYMMDD */
export function kstYmd(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}
