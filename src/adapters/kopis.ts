import { XMLParser } from 'fast-xml-parser';
import type { AdapterContext, AdapterResult, RawItemInput, SourceAdapter } from './types.js';
import type { Source } from '../db/schema.js';
import { fetchText as defaultFetchText, kstYmd, sha256, sleep, type FetchText } from './http.js';
import { judgeKeywords, type KeywordSet } from '../pipeline/keywordFilter.js';

// 명세: docs/kopis.md

export interface KopisConfig {
  strategy?: 'scan' | 'titles';
  window_days?: number;
  lookback_days?: number;
  horizon_days?: number;
  rows?: number;
  request_delay_ms?: number;
  implicit_context?: boolean;
  max_calls_alert?: number;
  titles?: string[];
}

interface KopisState {
  last_afterdate?: string;
}

export interface KopisListRow {
  mt20id: string;
  prfnm: string;
  prfpdfrom?: string;
  prfpdto?: string;
  fcltynm?: string;
  genrenm?: string;
  prfstate?: string;
}

export interface KopisRelate {
  name: string;
  url: string;
}

export interface KopisDetail extends KopisListRow {
  prfcast?: string;
  prfcrew?: string;
  prfruntime?: string;
  prfage?: string;
  entrpsnmH?: string;
  entrpsnmS?: string;
  entrpsnmA?: string;
  entrpsnmP?: string;
  pcseguidance?: string;
  dtguidance?: string;
  area?: string;
  visit?: string;
  festival?: string;
  updatedate?: string;
  poster?: string;
  relates: KopisRelate[];
}

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['db', 'relate', 'relatenm', 'relateurl', 'styurl'].includes(name),
});

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function parseDbs(text: string): Record<string, unknown>[] {
  const doc = xml.parse(text) as { dbs?: unknown };
  if (!('dbs' in doc)) throw new Error(`KOPIS 응답 형식이 아닙니다: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  const dbs = doc.dbs;
  if (!dbs || typeof dbs !== 'object') return []; // <dbs/> = 결과 없음
  const db = (dbs as { db?: unknown }).db;
  return Array.isArray(db) ? (db as Record<string, unknown>[]) : [];
}

export function parseKopisList(text: string): KopisListRow[] {
  return parseDbs(text)
    .map((r) => ({
      mt20id: str(r.mt20id) ?? '',
      prfnm: str(r.prfnm) ?? '',
      prfpdfrom: str(r.prfpdfrom),
      prfpdto: str(r.prfpdto),
      fcltynm: str(r.fcltynm),
      genrenm: str(r.genrenm),
      prfstate: str(r.prfstate),
    }))
    .filter((r) => r.mt20id && r.prfnm);
}

/** relates 구조가 문서에서 불분명해 두 형태를 모두 받는다: relates>relate>{relatenm,relateurl}[] 또는 relates>{relatenm[],relateurl[]} */
function parseRelates(v: unknown): KopisRelate[] {
  if (!v || typeof v !== 'object') return [];
  const o = v as { relate?: unknown; relatenm?: unknown; relateurl?: unknown };
  if (Array.isArray(o.relate)) {
    return (o.relate as Record<string, unknown>[])
      .map((r) => ({ name: str(Array.isArray(r.relatenm) ? r.relatenm[0] : r.relatenm) ?? '', url: str(Array.isArray(r.relateurl) ? r.relateurl[0] : r.relateurl) ?? '' }))
      .filter((r) => r.url);
  }
  const names = Array.isArray(o.relatenm) ? o.relatenm : [];
  const urls = Array.isArray(o.relateurl) ? o.relateurl : [];
  return urls.map((u, i) => ({ name: str(names[i]) ?? '', url: str(u) ?? '' })).filter((r) => r.url);
}

export function parseKopisDetail(text: string): KopisDetail | null {
  const r = parseDbs(text)[0];
  if (!r) return null;
  return {
    mt20id: str(r.mt20id) ?? '',
    prfnm: str(r.prfnm) ?? '',
    prfpdfrom: str(r.prfpdfrom),
    prfpdto: str(r.prfpdto),
    fcltynm: str(r.fcltynm),
    genrenm: str(r.genrenm),
    prfstate: str(r.prfstate),
    prfcast: str(r.prfcast),
    prfcrew: str(r.prfcrew),
    prfruntime: str(r.prfruntime),
    prfage: str(r.prfage),
    entrpsnmH: str(r.entrpsnmH),
    entrpsnmS: str(r.entrpsnmS),
    entrpsnmA: str(r.entrpsnmA),
    entrpsnmP: str(r.entrpsnmP),
    pcseguidance: str(r.pcseguidance),
    dtguidance: str(r.dtguidance),
    area: str(r.area),
    visit: str(r.visit),
    festival: str(r.festival),
    updatedate: str(r.updatedate),
    poster: str(r.poster),
    relates: parseRelates(r.relates),
  };
}

/** LLM 입력용 본문. 필드 이름을 한국어로 붙여 한 줄씩. */
export function kopisDetailBody(d: KopisDetail): string {
  const lines: [string, string | undefined][] = [
    ['공연명', d.prfnm],
    ['공연 기간', d.prfpdfrom && d.prfpdto ? `${d.prfpdfrom} ~ ${d.prfpdto}` : d.prfpdfrom],
    ['공연장', d.fcltynm],
    ['지역', d.area],
    ['장르', d.genrenm],
    ['공연 상태', d.prfstate],
    ['공연 시간', d.dtguidance],
    ['출연진', d.prfcast],
    ['주최', d.entrpsnmH],
    ['주관', d.entrpsnmS],
    ['기획사', d.entrpsnmA],
    ['제작사', d.entrpsnmP],
    ['티켓 가격', d.pcseguidance],
    ['내한', d.visit],
    ['축제', d.festival],
    ['예매처', d.relates.map((r) => `${r.name} ${r.url}`.trim()).join(' / ') || undefined],
    ['KOPIS 최종수정', d.updatedate],
    ['출처', `KOPIS 공연 ID ${d.mt20id}`],
  ];
  return lines.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const ymdToDate = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);

/** 조회 기간 최대 31일 제한에 맞춰 [stdate, eddate] 창을 만든다. */
export function buildWindows(today: Date, cfg: Required<Pick<KopisConfig, 'window_days' | 'lookback_days' | 'horizon_days'>>): [string, string][] {
  const out: [string, string][] = [];
  const end = addDays(today, cfg.horizon_days);
  for (let s = addDays(today, -cfg.lookback_days); s <= end; s = addDays(s, cfg.window_days)) {
    const e = addDays(s, cfg.window_days - 1);
    out.push([ymd(s), ymd(e > end ? end : e)]);
  }
  return out;
}

export interface KopisDeps {
  serviceKey?: string;
  fetchText?: FetchText;
  loadKeywords: () => Promise<KeywordSet>;
}

export function createKopisAdapter(deps: KopisDeps): SourceAdapter {
  const rawFetch = deps.fetchText ?? defaultFetchText;

  return {
    async run(source: Source, ctx: AdapterContext): Promise<AdapterResult> {
      const key = deps.serviceKey;
      if (!key) throw new Error('KOPIS_SERVICE_KEY가 설정되지 않았습니다');
      const cfg = ctx.config as KopisConfig;
      const state = ctx.state as KopisState;
      const rows = cfg.rows ?? 100;
      const delay = cfg.request_delay_ms ?? 300;
      const base = source.target.replace(/\/$/, '');
      const keywords = await deps.loadKeywords();
      let calls = 0;

      // 서비스키가 오류 메시지·로그에 남지 않도록 가린다.
      const get = async (url: string) => {
        if (calls > 0) await sleep(delay);
        calls++;
        try {
          return (await rawFetch(url, { timeoutMs: 30_000 })).text;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(msg.split(key).join('***'));
        }
      };

      const today = ymdToDate(kstYmd(ctx.now));
      const windows = buildWindows(today, {
        window_days: cfg.window_days ?? 31,
        lookback_days: cfg.lookback_days ?? 30,
        horizon_days: cfg.horizon_days ?? 365,
      });
      const afterdate = state.last_afterdate ? ymd(addDays(ymdToDate(state.last_afterdate), -1)) : undefined;
      const searchTerms = cfg.strategy === 'titles' ? (cfg.titles ?? []) : [undefined];

      const hits = new Map<string, KopisListRow>();
      for (const [stdate, eddate] of windows) {
        for (const term of searchTerms) {
          for (let cpage = 1; cpage <= 50; cpage++) {
            const params = new URLSearchParams({ service: key, stdate, eddate, cpage: String(cpage), rows: String(rows) });
            if (afterdate) params.set('afterdate', afterdate);
            if (term) params.set('shprfnm', term);
            const list = parseKopisList(await get(`${base}?${params}`));
            for (const r of list) {
              if (judgeKeywords(r.prfnm, keywords, { implicitContext: cfg.implicit_context ?? true }).pass) hits.set(r.mt20id, r);
            }
            if (list.length < rows) break;
          }
        }
      }

      const items: RawItemInput[] = [];
      for (const id of hits.keys()) {
        const detail = parseKopisDetail(await get(`${base}/${encodeURIComponent(id)}?service=${encodeURIComponent(key)}`));
        if (!detail) continue;
        const body = kopisDetailBody(detail);
        const hash = sha256(body);
        items.push({
          // KOPIS에서 공연 정보가 바뀌면 새 원문으로 잡히도록 내용 해시를 ID에 넣는다.
          externalId: `${id}:${hash.slice(0, 12)}`,
          url: detail.relates[0]?.url,
          title: detail.prfnm,
          body,
          lang: 'ko',
          contentHash: hash,
        });
      }

      const notes: string[] = [];
      const maxCalls = cfg.max_calls_alert ?? 200;
      if (afterdate && calls > maxCalls) {
        notes.push(`KOPIS 호출 ${calls}회로 기준(${maxCalls}회)을 넘었습니다. 제목 검색(strategy: titles) 전환을 검토하세요.`);
      }
      return { items, state: { last_afterdate: kstYmd(ctx.now), calls }, notes };
    },
  };
}
