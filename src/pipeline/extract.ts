import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { EVENT_KINDS, EVENT_REGIONS, OFFICIALITIES } from '../db/schema.js';

// CLAUDE.md 규칙 3·4·13. tool use로 출력 형식을 강제하고, 결과는 zod로 한 번 더 검증한다.

export const PRIMARY_MODEL = 'claude-haiku-5-5';
export const REVIEW_MODEL = 'claude-sonnet-5-5';
export const CONFIDENCE_THRESHOLD = 0.7;

/** USD / 100만 토큰. Haiku 5.5는 프롬프트 10만 토큰 이하 기준(이 파이프라인의 입력은 그보다 훨씬 짧다). */
export const PRICING: Record<string, { input: number; output: number }> = {
  [PRIMARY_MODEL]: { input: 0.1, output: 0.5 },
  [REVIEW_MODEL]: { input: 2, output: 10 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

const nullableString = { type: ['string', 'null'] } as const;

export const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_event',
  description: '원문에서 하츠네 미쿠 관련 행사 정보를 뽑아 기록한다.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      is_relevant: { type: 'boolean', description: '하츠네 미쿠·피아프로 캐릭터즈·프로젝트 세카이 관련 행사(공연, 부스, 무대, 팝업, 콜라보 카페, 전시, 상영·라이브뷰잉, 굿즈 판매, 브랜드·교통 콜라보) 정보면 true' },
      title: { type: 'string', description: '행사의 공식 명칭. 원문 표기 그대로' },
      kind: { type: 'string', enum: [...EVENT_KINDS] },
      officiality: { type: 'string', enum: [...OFFICIALITIES] },
      region: { type: 'string', enum: [...EVENT_REGIONS] },
      city: { ...nullableString, description: '도시명 (서울, 부산, 도쿄 등)' },
      venue: { ...nullableString, description: '장소명' },
      start_date: { ...nullableString, description: 'YYYY-MM-DD. 모르면 null' },
      end_date: { ...nullableString, description: 'YYYY-MM-DD. 하루 행사면 start_date와 같게. 모르면 null' },
      ticket_open_at: { ...nullableString, description: '티켓 일반 예매 오픈 일시. 시간대 포함 ISO 8601 (예: 2026-12-01T20:00:00+09:00). 모르면 null' },
      ticket_url: {
        ...nullableString,
        description:
          '실제로 예매·사전예약·구매를 하는 페이지의 URL (예매처, 공식 예약 페이지, 공식 판매 페이지). 원문에 그런 링크가 없으면 null. 소개 글·기사·블로그·SNS 주소나 이 원문 자체의 주소는 넣지 않는다',
      },
      presales: {
        type: 'array',
        description: '일반 예매 전에 있는 선예매·추첨 접수 일정 (팬클럽 선예매, 추첨 접수, 2차 선예매 등). 없으면 빈 배열',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', description: '이름 (예: 팬클럽 선예매, 1차 추첨 접수)' },
            open_at: { ...nullableString, description: '시작 일시. 시간대 포함 ISO 8601. 모르면 null' },
            close_at: { ...nullableString, description: '마감 일시. 시간대 포함 ISO 8601. 모르면 null' },
          },
          required: ['label', 'open_at', 'close_at'],
        },
      },
      is_cancelled: { type: 'boolean', description: '행사가 취소·중지됐다는 공지면 true' },
      sale_started: { type: ['boolean', 'null'], description: '원문에 판매 중·판매 시작이 명시돼 있으면 true, 판매 전이면 false, 알 수 없으면 null' },
      parent_event_hint: { ...nullableString, description: '이 행사가 포함된 상위 행사명 (예: AGF 2026 안의 부스면 "AGF 2026")' },
      summary_ko: { type: 'string', description: '한국어 2~3문장 요약. 일정·장소·예매 정보 중심' },
      confidence: { type: 'number', description: '추출 정확도에 대한 확신 0~1' },
    },
    required: [
      'is_relevant', 'title', 'kind', 'officiality', 'region', 'city', 'venue', 'start_date', 'end_date',
      'ticket_open_at', 'ticket_url', 'presales', 'is_cancelled', 'sale_started', 'parent_event_hint', 'summary_ko', 'confidence',
    ],
  },
};

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoOrNull = z
  .string()
  .nullable()
  .transform((v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null));
const presaleSchema = z.object({ label: z.string().min(1).max(60), open_at: isoOrNull, close_at: isoOrNull });
/** 선예매·추첨 접수 일정 */
export type Presale = z.infer<typeof presaleSchema>;
export const extractionSchema = z.object({
  is_relevant: z.boolean(),
  title: z.string().min(1),
  kind: z.enum(EVENT_KINDS),
  officiality: z.enum(OFFICIALITIES),
  region: z.enum(EVENT_REGIONS),
  city: z.string().nullable(),
  venue: z.string().nullable(),
  start_date: ymd.nullable().catch(null),
  end_date: ymd.nullable().catch(null),
  ticket_open_at: z
    .string()
    .nullable()
    .transform((v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)),
  ticket_url: z.string().url().nullable().catch(null),
  // 일정이 하나도 없는 항목은 버린다. 형식이 틀리면 빈 배열
  presales: z
    .array(presaleSchema)
    .transform((a) => a.filter((p) => p.open_at || p.close_at).slice(0, 5))
    .optional()
    .catch([]),
  is_cancelled: z.boolean(),
  sale_started: z.boolean().nullable(),
  parent_event_hint: z.string().nullable(),
  summary_ko: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof extractionSchema>;

export interface ExtractInput {
  sourceName: string;
  sourceLayer: string;
  url?: string | null;
  publishedAt?: string | null;
  title?: string | null;
  body: string;
  /** 지금 시각 (프롬프트의 오늘 날짜) */
  now: Date;
}

export interface ExtractCall {
  model: string;
  result: Extraction;
  inputTokens: number;
  outputTokens: number;
}

/** 같은 행사인지 확인할 기존 행사 */
export interface MatchCandidate {
  id: number;
  title: string;
  aliases: string[];
  kind: string;
  region: string;
  city: string | null;
  venue: string | null;
  startDate: string | null;
  endDate: string | null;
}

export const MATCH_RELATIONS = ['same', 'part_of', 'different'] as const;
export interface MatchResult {
  /** 같은 행사(또는 포함 관계)인 후보의 번호. 없으면 null */
  matchId: number | null;
  relation: (typeof MATCH_RELATIONS)[number];
  confidence: number;
}

export interface MatchCall {
  model: string;
  result: MatchResult;
  inputTokens: number;
  outputTokens: number;
}

export const MATCH_TOOL: Anthropic.Tool = {
  name: 'judge_same_event',
  description: '새 행사가 기존 행사 후보 중 하나와 같은 행사인지 기록한다.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      match_id: { type: ['integer', 'null'], description: '같은 행사이거나 포함 관계인 후보의 번호. 없으면 null' },
      relation: { type: 'string', enum: [...MATCH_RELATIONS] },
      confidence: { type: 'number', description: '판단에 대한 확신 0~1' },
    },
    required: ['match_id', 'relation', 'confidence'],
  },
};

const matchSchema = z.object({
  match_id: z.number().int().nullable(),
  relation: z.enum(MATCH_RELATIONS),
  confidence: z.number().min(0).max(1).catch(0),
});

export const MATCH_SYSTEM = [
  '너는 하츠네 미쿠 행사 목록에서 중복을 찾는 도우미다. [새 행사]가 [기존 행사 후보] 중 하나와 같은 행사인지 판단해 judge_same_event 도구로 답한다.',
  '- same: 같은 행사다. 언어·표기·약칭만 다르고 같은 회차·같은 장소·같은 기간(또는 같은 상품·같은 콜라보)을 가리킨다.',
  '  같은 회차의 일정이 연기·변경된 경우도 same이다 (새 행사 요약에 연기·일정 변경이 언급되거나, 제목·장소가 같고 날짜만 조금 다른 경우).',
  '- part_of: 한쪽이 다른 쪽의 일부다 (큰 행사 안의 부스·무대, 투어 전체 발표와 그중 한 도시 공연).',
  '- different: 다른 행사다. 같은 투어의 다른 도시 공연, 같은 이름의 다른 연도·시즌, 같은 장소의 다른 행사, 같은 기간의 다른 상품은 different.',
  '확실하지 않으면 confidence를 낮게 준다. 같은 후보가 없으면 match_id는 null, relation은 different.',
].join('\n');

const eventLine = (e: Omit<MatchCandidate, 'id' | 'aliases'> & { aliases?: string[] }) =>
  [
    `제목: ${e.title}`,
    e.aliases?.length ? `다른 표기: ${e.aliases.join(' / ')}` : '',
    `유형: ${e.kind}`,
    `지역: ${e.region}${e.city ? ` ${e.city}` : ''}`,
    `장소: ${e.venue ?? '미정'}`,
    `기간: ${e.startDate ? `${e.startDate}~${e.endDate ?? e.startDate}` : '미정'}`,
  ]
    .filter(Boolean)
    .join(' | ');

export function matchPrompt(ext: Extraction, candidates: MatchCandidate[]): string {
  return [
    '[새 행사]',
    eventLine({ title: ext.title, kind: ext.kind, region: ext.region, city: ext.city, venue: ext.venue, startDate: ext.start_date, endDate: ext.end_date }),
    ext.summary_ko ? `요약: ${ext.summary_ko.slice(0, 300)}` : '',
    '',
    '[기존 행사 후보]',
    ...candidates.map((c) => `#${c.id} ${eventLine(c)}`),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface Extractor {
  extract(input: ExtractInput, model: string): Promise<ExtractCall>;
  /** 새 행사가 후보 중 하나와 같은 행사인지 (새 행사를 만들기 직전에만 부른다) */
  match?(ext: Extraction, candidates: MatchCandidate[]): Promise<MatchCall>;
}

/** API 쪽 일시 장애(한도 초과, 과부하, 5xx)는 원문을 pending으로 남기고 다음 틱에 다시 시도한다. */
export class TransientLlmError extends Error {}

/** 키·권한·요청 형식 문제(400/401/403/404)는 원문마다 실패시키지 않고 파이프라인을 멈춘 뒤 한 번 알린다. */
export class LlmConfigError extends Error {}

const kstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function systemPrompt(now: Date): string {
  return [
    '너는 하츠네 미쿠 관련 행사 정보를 정리하는 도우미다. 주어진 원문 하나를 읽고 record_event 도구로 결과를 기록한다.',
    `오늘은 ${kstDate(now)} (한국 시각)이다. 연도가 없는 날짜는 게시 시각(없으면 오늘) 이후로 가장 가까운 날짜로 해석한다. 지난 행사를 소개하는 글이면 지난 날짜를 그대로 쓴다.`,
    '',
    '판단 기준:',
    '- is_relevant: 하츠네 미쿠, 피아프로 캐릭터즈(카가미네 린·렌, 메구리네 루카, MEIKO, KAITO), 프로젝트 세카이가 등장하는 "참여·방문·구매할 수 있는 행사"면 true.',
    '  음원·MV 공개, 소프트웨어 판매, 악곡 콘테스트 모집, 일반 기업 소식은 false. 동명이인(예: 나카노 미쿠)도 false.',
    '- kind: concert(단독 공연·투어), booth(행사 안 부스), stage(행사 안 무대), popup(팝업 스토어), cafe(콜라보 카페), exhibition(전시), live_viewing(영화관 생중계·극장 상영), goods(굿즈·복권 발매·판매), collab(브랜드·매장·교통 콜라보: 랩핑 열차, 편의점·브랜드 콜라보 캠페인처럼 상품 하나가 아닌 것), other.',
    '- officiality: crypton(크립톤 주최·공식 프로젝트: 매지컬 미라이, MIKU EXPO, SNOW MIKU, 미쿠 심포니 등), licensed(공식 라이선스 콜라보·굿즈), permitted_doujin(크립톤 허가를 받은 동인 행사, 예: 매지컬플레이), unverified(확인 불가).',
    '- region: 한국에서 열리면 KR, 일본이면 JP, 그 외 OTHER.',
    '- 날짜·시각은 원문에 있는 것만 쓴다. 추측하지 않는다. ticket_open_at은 일반 예매 오픈 시각이며 선예매·추첨 접수 시작과 구분한다.',
    '- title은 행사 공식 명칭을 원문 표기 그대로 쓴다. 같은 행사를 여러 원문에서 받으므로 명칭을 일관되게 쓴다.',
    '- ticket_url은 실제로 예매·사전예약·구매를 하는 페이지만 쓴다. 소개 글·기사·블로그·SNS 주소, 이 원문 자체의 주소는 쓰지 않는다. 없으면 null.',
    '- presales에는 일반 예매 전에 있는 선예매·추첨 접수를 넣는다 (팬클럽 선예매, 추첨 접수 기간 등). 일반 예매는 넣지 않는다.',
    '- 굿즈·콜라보처럼 좌석 예매가 없는 것은 ticket_open_at을 null로 두고, 발매·판매 시작일은 start_date에 쓴다.',
    '- confidence: 행사 여부와 핵심 필드(일정·장소)에 확신이 낮으면 0.7 미만으로 준다.',
    '',
    '관련 없는 원문이어도 반드시 record_event 도구를 한 번 호출해 답한다 (is_relevant=false). 도구 호출 외의 텍스트는 쓰지 않는다.',
  ].join('\n');
}

export function userPrompt(input: ExtractInput): string {
  return [
    `출처: ${input.sourceName} (${input.sourceLayer})`,
    input.url ? `URL: ${input.url}` : '',
    input.publishedAt ? `게시 시각: ${input.publishedAt}` : '',
    input.title ? `제목: ${input.title}` : '',
    '',
    '본문:',
    input.body.slice(0, 8000),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function createAnthropicExtractor(apiKey: string, client = new Anthropic({ apiKey, maxRetries: 2 })): Extractor {
  // strict(스키마 강제)를 모델이 거부하면 한 번만 strict 없이 다시 보내고 이후로는 끈다. 결과는 어차피 zod로 검증한다.
  let useStrict = true;
  // 도구 강제 호출(tool_choice: tool)을 거부하는 모델(Sonnet 5.5 등)은 auto + strict로 보낸다. 모델별로 기억한다.
  const autoChoiceModels = new Set<string>([REVIEW_MODEL]);
  const send = (input: ExtractInput, model: string) =>
    client.messages.create({
      model,
      // 도구를 강제하면(Haiku) 생각 없이 바로 도구를 부른다. auto(Sonnet 5.5)는 기본으로 생각을 먼저 하고
      // 그 토큰이 max_tokens에 들어가므로, 생각만 하다 도구 호출 전에 한도에 걸리지 않게 넉넉히 둔다(쓴 만큼만 과금).
      max_tokens: autoChoiceModels.has(model) ? 16000 : 4096,
      system: systemPrompt(input.now),
      messages: [{ role: 'user', content: userPrompt(input) }],
      tools: [useStrict ? EXTRACT_TOOL : { ...EXTRACT_TOOL, strict: false }],
      tool_choice: autoChoiceModels.has(model)
        ? { type: 'auto', disable_parallel_tool_use: true }
        : { type: 'tool', name: EXTRACT_TOOL.name, disable_parallel_tool_use: true },
    });
  /** API 오류를 일시 오류·설정 오류로 나눈다 */
  const classify = (err: unknown): never => {
    const e = err as { status?: number; message?: string };
    if (e.status === 429 || e.status === 529 || (e.status !== undefined && e.status >= 500)) {
      throw new TransientLlmError(`Claude API 일시 오류 (${e.status})`);
    }
    if (e.status !== undefined && [400, 401, 403, 404].includes(e.status)) {
      throw new LlmConfigError(`Claude API 요청 오류 (${e.status}): ${(e.message ?? '').slice(0, 300)}`);
    }
    throw err;
  };
  return {
    async match(ext, candidates) {
      // 도구를 강제하면 Haiku는 생각 없이 바로 도구를 부른다
      const res = await client.messages
        .create({
          model: PRIMARY_MODEL,
          max_tokens: 1024,
          system: MATCH_SYSTEM,
          messages: [{ role: 'user', content: matchPrompt(ext, candidates) }],
          tools: [MATCH_TOOL],
          tool_choice: { type: 'tool', name: MATCH_TOOL.name, disable_parallel_tool_use: true },
        })
        .catch(classify);
      const block = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      if (!block) throw new Error(`도구 호출이 없는 응답 (stop_reason: ${res.stop_reason})`);
      const r = matchSchema.parse(block.input);
      return {
        model: PRIMARY_MODEL,
        result: { matchId: r.match_id, relation: r.relation, confidence: r.confidence },
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    },
    async extract(input, model) {
      let res: Anthropic.Message;
      try {
        try {
          res = await send(input, model);
        } catch (err) {
          const e = err as { status?: number; message?: string };
          if (e.status === 400 && /tool_choice/i.test(e.message ?? '') && !autoChoiceModels.has(model)) {
            autoChoiceModels.add(model);
            res = await send(input, model);
          } else if (useStrict && e.status === 400 && /strict/i.test(e.message ?? '')) {
            useStrict = false;
            res = await send(input, model);
          } else throw err;
        }
      } catch (err) {
        const e = err as { status?: number; message?: string };
        if (e.status === 429 || e.status === 529 || (e.status !== undefined && e.status >= 500)) {
          throw new TransientLlmError(`Claude API 일시 오류 (${e.status})`);
        }
        if (e.status !== undefined && [400, 401, 403, 404].includes(e.status)) {
          throw new LlmConfigError(`Claude API 요청 오류 (${e.status}): ${(e.message ?? '').slice(0, 300)}`);
        }
        throw err;
      }
      const block = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      if (!block) throw new Error(`도구 호출이 없는 응답 (stop_reason: ${res.stop_reason})`);
      return {
        model,
        result: extractionSchema.parse(block.input),
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    },
  };
}
