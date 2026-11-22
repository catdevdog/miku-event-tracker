import Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, llmCalls } from '../db/schema.js';
import { PRIMARY_MODEL, costUsd } from '../pipeline/extract.js';
import { kstDate } from '../pipeline/state.js';
import { formatKstShort } from '../notify/format.js';
import { KIND_KO, OFFICIALITY_KO, STATUS_KO, regionMeta } from '../notify/labels.js';

/**
 * 봇 멘션 질문 답변 (CLAUDE.md 추후 기능 2).
 * 답변 근거는 events 테이블뿐이다. 네이버 검색 결과(raw_items)는 약관상 AI 답변 생성에 쓸 수 없으므로 넣지 않는다.
 * 슬래시 명령·공개 API와 같은 조회 기준(확정 행사)을 쓴다.
 */

/** 답변에 넣는 행사: 다가오는·진행 중 전부 + 최근 60일 안에 끝난 행사. 최대 150건 */
export async function qaEvents(db: Db, now: Date) {
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  return db
    .select()
    .from(events)
    .where(and(eq(events.needsReview, 0), sql`(${events.status} <> 'ended' OR coalesce(${events.endDate}, ${events.startDate}) >= ${since})`))
    .orderBy(sql`${events.startDate} IS NULL`, asc(events.startDate))
    .limit(150);
}

type EventRow = Awaited<ReturnType<typeof qaEvents>>[number];

/** 행사 목록을 한 줄씩 (모델 입력용) */
export function qaContext(rows: EventRow[]): string {
  if (rows.length === 0) return '(등록된 행사 없음)';
  return rows
    .map((e) =>
      [
        `- ${e.title}`,
        `지역 ${regionMeta(e.region).label}${e.city ? `(${e.city})` : ''}`,
        e.venue ? `장소 ${e.venue}` : '장소 미정',
        e.startDate ? `기간 ${e.startDate}${e.endDate && e.endDate !== e.startDate ? `~${e.endDate}` : ''}` : '기간 미정',
        `상태 ${STATUS_KO[e.status] ?? e.status}`,
        `종류 ${KIND_KO[e.kind] ?? e.kind}`,
        `구분 ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`,
        e.ticketOpenAt ? `티켓 오픈 ${formatKstShort(e.ticketOpenAt)} KST` : '',
        e.ticketUrl ? `예매 ${e.ticketUrl}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n');
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * "이번 주", "다음 주" 같은 표현의 날짜 범위 (한국 날짜, 주는 월~일).
 * 모델이 날짜 계산을 하지 않아도 되게 미리 계산해 넘긴다.
 */
export function qaDateRanges(now: Date) {
  const today = kstDate(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=일
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return {
    today,
    weekday: WEEKDAY_KO[dow]!,
    thisWeek: [monday, addDays(monday, 6)] as const,
    thisWeekend: [addDays(monday, 5), addDays(monday, 6)] as const,
    nextWeek: [addDays(monday, 7), addDays(monday, 13)] as const,
    thisMonth: [`${today.slice(0, 7)}-01`, monthEnd(y, m)] as const,
    nextMonth: [`${ny}-${String(nm).padStart(2, '0')}-01`, monthEnd(ny, nm)] as const,
  };
}

export function qaSystemPrompt(now: Date): string {
  const r = qaDateRanges(now);
  const range = (a: readonly [string, string]) => `${a[0]} ~ ${a[1]}`;
  return [
    '너는 디스코드 서버의 하츠네 미쿠 행사 알림 봇이다. 사용자의 질문에 아래 [행사 목록]만 근거로 한국어로 답한다.',
    `오늘은 ${r.today} (${r.weekday}요일, 한국 시각)이다. 기간 표현은 아래 범위로 해석한다 (주는 월요일~일요일).`,
    `- 이번 주: ${range(r.thisWeek)} / 이번 주말: ${range(r.thisWeekend)}`,
    `- 다음 주: ${range(r.nextWeek)}`,
    `- 이번 달: ${range(r.thisMonth)} / 다음 달: ${range(r.nextMonth)}`,
    '- 행사 기간이 물어본 범위와 하루라도 겹치면 그 범위의 행사다. 티켓 오픈을 물으면 티켓 오픈 시각으로 판단한다.',
    '',
    '규칙:',
    '- 목록에 없는 행사·날짜·가격·장소는 지어내지 않는다. 모르면 "등록된 정보가 없어요"라고 말하고 /행사 명령이나 공식 공지를 확인하라고 안내한다.',
    '- 국내는 지역이 국내인 행사다. 해외는 일본을 포함한 한국 밖이다.',
    '- 디스코드 메시지로 짧게 답한다. 행사는 "- **행사명** · 기간 · 장소" 형식의 목록으로, 최대 8개까지. 표는 쓰지 않는다.',
    '- 예매 링크가 있으면 행사 줄 끝에 붙인다.',
    '- 미쿠 행사와 관계없는 질문에는 이 봇이 답할 수 있는 범위(미쿠 행사 정보)를 한 문장으로 안내한다.',
    '- 1500자를 넘기지 않는다.',
  ].join('\n');
}

export interface QaAnswerer {
  answer(question: string): Promise<string>;
}

/** Claude로 답한다. 호출마다 llm_calls에 비용을 남긴다(raw_item_id 없음). */
export function createQaAnswerer(db: Db, apiKey: string, client = new Anthropic({ apiKey, maxRetries: 2 }), now: () => Date = () => new Date()): QaAnswerer {
  return {
    async answer(question) {
      const t = now();
      const context = qaContext(await qaEvents(db, t));
      // Haiku 5.5는 기본으로 생각(adaptive thinking)을 하고 그 토큰이 max_tokens에 포함된다.
      // 행사 목록이 길면 생각만 하다 한도에 걸려 답(text)이 비는 경우가 있어 생각을 끈다(기본 effort medium에서 허용).
      // 날짜 범위는 시스템 프롬프트에서 미리 계산해 준다.
      const res = await client.messages.create({
        model: PRIMARY_MODEL,
        max_tokens: 1500,
        thinking: { type: 'disabled' },
        system: qaSystemPrompt(t),
        messages: [{ role: 'user', content: `[행사 목록]\n${context}\n\n[질문]\n${question.slice(0, 500)}` }],
      });
      await db.insert(llmCalls).values({
        rawItemId: null,
        model: PRIMARY_MODEL,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        costUsd: costUsd(PRIMARY_MODEL, res.usage.input_tokens, res.usage.output_tokens),
        createdAt: t.toISOString(),
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) {
        console.warn(`[멘션 질문] 답이 비었습니다 (stop_reason: ${res.stop_reason}, 출력 ${res.usage.output_tokens}토큰)`);
        return '답을 만들지 못했어요. `/행사`로 목록을 확인해 주세요.';
      }
      return text;
    },
  };
}
