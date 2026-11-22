import { SlashCommandBuilder } from 'discord.js';
import type { ServiceStatus } from '../services/status.js';
import type { SourceStatusRow } from '../services/sources.js';
import type { RecentRawItem } from '../services/rawItems.js';
import type { EventRow } from '../pipeline/merge.js';
import { formatKst, textTable } from './format.js';
import type { OutgoingMessage } from './types.js';

/** 길드 슬래시 명령 정의. 길드 단위로 등록하면 바로 반영된다. */
export const commandDefinitions = [
  new SlashCommandBuilder().setName('ping').setDescription('봇과 수집기 상태를 확인합니다').toJSON(),
  new SlashCommandBuilder().setName('소스').setDescription('소스별 마지막 수집 성공 시각과 실패 횟수').toJSON(),
  new SlashCommandBuilder().setName('최근수집').setDescription('최근 수집한 글과 키워드·추출 판정').toJSON(),
  new SlashCommandBuilder()
    .setName('행사')
    .setDescription('다가오는 미쿠 행사')
    .addStringOption((o) =>
      o.setName('범위').setDescription('국내·해외·전체 (기본: 전체)').addChoices({ name: '국내', value: 'domestic' }, { name: '해외', value: 'overseas' }, { name: '전체', value: 'all' }),
    )
    .toJSON(),
];

export interface PingInfo {
  status: ServiceStatus;
  wsPingMs: number;
  uptimeSec: number;
}

export function buildPingReply({ status, wsPingMs, uptimeSec }: PingInfo): string {
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const lines = [
    `pong · 게이트웨이 ${wsPingMs >= 0 ? `${wsPingMs}ms` : '측정 전'} · 가동 ${h}시간 ${m}분`,
    `소스 ${status.sourcesEnabled}/${status.sourcesTotal}개 활성 · 마지막 수집 ${formatKst(status.lastJobRunAt)}`,
  ];
  if (status.failingSources.length > 0) lines.push(`연속 실패: ${status.failingSources.join(', ')}`);
  return lines.join('\n');
}

/** "11-22 23:05" 형태의 짧은 한국 시각 */
function shortKst(iso: string | null): string {
  if (!iso) return '-----------';
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

const COLOR = { info: 0x39c5bb, warn: 0xf5a623 };

// 표의 앞쪽 열은 글자 수가 같은 한글(2글자)·숫자만 써서 디스코드 고정폭 표에서 줄이 맞게 한다.
const SOURCE_STATE = (r: SourceStatusRow) =>
  !r.enabled ? '꺼짐' : r.consecutiveFailures >= 3 ? '경보' : r.consecutiveFailures > 0 ? '실패' : r.lastSuccessAt ? '정상' : '대기';

export function buildSourcesReply(rows: SourceStatusRow[]): OutgoingMessage {
  const enabled = rows.filter((r) => r.enabled);
  const failing = enabled.filter((r) => r.consecutiveFailures >= 3).length;
  const table = textTable(
    ['상태', '마지막 성공', '실패', '소스'],
    rows.map((r) => [SOURCE_STATE(r), shortKst(r.lastSuccessAt), String(r.consecutiveFailures), r.name]),
    40,
  );
  return {
    embeds: [
      {
        title: '소스 상태',
        description: `${table}\n정상: 마지막 실행 성공 · 실패: 1~2회 연속 실패 · 경보: 3회 이상 · 대기: 아직 성공 없음 · 꺼짐: 비활성`,
        color: failing > 0 ? COLOR.warn : COLOR.info,
        footer: { text: `활성 ${enabled.length}/${rows.length}개 · 3회 이상 연속 실패 ${failing}개 · 시각은 한국 시간` },
      },
    ],
  };
}

const HIT_KO: Record<string, string> = { strong: '강', weak: '약', none: '무' };
const LLM_KO: Record<string, string> = { pending: '대기', done: '완료', skipped: '제외', error: '오류' };

export function buildRecentReply(rows: RecentRawItem[]): OutgoingMessage {
  if (rows.length === 0) return { embeds: [{ title: '최근 수집', description: '아직 수집한 글이 없습니다.', color: COLOR.info }] };
  const table = textTable(
    ['수집 시각', '키', '추출', '출처 · 제목'],
    rows.map((r) => [shortKst(r.fetchedAt), HIT_KO[r.keywordHit ?? ''] ?? '미', LLM_KO[r.llmStatus] ?? '기타', `${r.source} · ${r.title ?? '(제목 없음)'}`]),
    46,
  );
  return {
    embeds: [
      {
        title: `최근 수집 ${rows.length}건`,
        description: `${table}\n키(키워드): 강·약·무·미(판정 전) · 추출: 대기·완료·제외(키워드 미달)·오류`,
        color: COLOR.info,
      },
    ],
  };
}

export type EventScope = 'domestic' | 'overseas' | 'all';
export const SCOPE_KO: Record<EventScope, string> = { domestic: '국내', overseas: '해외', all: '전체' };
const STATUS2: Record<string, string> = { announced: '발표', ticket_scheduled: '예정', on_sale: '판매', ongoing: '진행' };
const REGION2: Record<string, string> = { KR: '국내', JP: '일본', OTHER: '해외' };

function shortDate(start: string | null, end: string | null): string {
  if (!start) return '일정 미정  ';
  const s = start.slice(2).replace(/-/g, '.');
  return end && end !== start ? `${s}~${end.slice(5).replace('-', '.')}` : s;
}

export function buildEventsReply(rows: EventRow[], scope: EventScope = 'all'): OutgoingMessage {
  const title = `다가오는 행사 · ${SCOPE_KO[scope]}`;
  if (rows.length === 0) {
    return { embeds: [{ title, description: '조건에 맞는 다가오는 행사가 없습니다. (종료·취소·검수 대기 행사는 빠집니다)', color: COLOR.info }] };
  }
  const table = textTable(
    ['날짜', '지역', '상태', '행사'],
    rows.map((e) => {
      const ticket = e.status === 'ticket_scheduled' && e.ticketOpenAt ? ` · 티켓 ${shortKst(e.ticketOpenAt)}` : '';
      return [shortDate(e.startDate, e.endDate), REGION2[e.region] ?? '해외', STATUS2[e.status] ?? '기타', `${e.title}${e.venue ? ` @${e.venue}` : ''}${ticket}`];
    }),
    72,
  );
  return {
    embeds: [
      {
        title,
        description: `${table}\n상태: 발표 · 예정(예매 일정 공지) · 판매(판매 중) · 진행(행사 기간)`,
        color: COLOR.info,
        footer: { text: `${rows.length}건 · 종료·취소·검수 대기 제외 · 시각은 한국 시간` },
      },
    ],
  };
}

