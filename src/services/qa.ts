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

export function qaSystemPrompt(now: Date): string {
  return [
    '너는 디스코드 서버의 하츠네 미쿠 행사 알림 봇이다. 사용자의 질문에 아래 [행사 목록]만 근거로 한국어로 답한다.',
    `오늘은 ${kstDate(now)} (한국 시각)이다. "이번 달", "다음 주" 같은 표현은 이 날짜 기준으로 해석한다.`,
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
      const res = await client.messages.create({
        model: PRIMARY_MODEL,
        max_tokens: 1024,
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
      return text || '답을 만들지 못했어요. `/행사`로 목록을 확인해 주세요.';
    },
  };
}
