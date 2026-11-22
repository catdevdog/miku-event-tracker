import { SlashCommandBuilder } from 'discord.js';
import type { ServiceStatus } from '../services/status.js';
import type { SourceStatusRow } from '../services/sources.js';
import type { RecentRawItem } from '../services/rawItems.js';
import type { EventRow } from '../pipeline/merge.js';
import { formatKst, truncate } from './format.js';

/** 길드 슬래시 명령 정의. 길드 단위로 등록하면 바로 반영된다. */
export const commandDefinitions = [
  new SlashCommandBuilder().setName('ping').setDescription('봇과 수집기 상태를 확인합니다').toJSON(),
  new SlashCommandBuilder().setName('소스').setDescription('소스별 마지막 수집 성공 시각과 실패 횟수').toJSON(),
  new SlashCommandBuilder().setName('최근수집').setDescription('최근 수집한 글과 키워드·추출 판정').toJSON(),
  new SlashCommandBuilder()
    .setName('행사')
    .setDescription('다가오는 미쿠 행사')
    .addStringOption((o) =>
      o.setName('지역').setDescription('지역 (기본: 전체)').addChoices({ name: '한국', value: 'KR' }, { name: '일본', value: 'JP' }, { name: '해외', value: 'OTHER' }),
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
  if (!iso) return '-';
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

export function buildSourcesReply(rows: SourceStatusRow[]): string {
  const icon = (r: SourceStatusRow) => (!r.enabled ? '⏸' : r.consecutiveFailures >= 3 ? '⚠️' : r.consecutiveFailures > 0 ? '❗' : r.lastSuccessAt ? '✅' : '·');
  const lines = rows.map(
    (r) => `${icon(r)} ${r.name} · 성공 ${shortKst(r.lastSuccessAt)}${r.consecutiveFailures ? ` · 실패 ${r.consecutiveFailures}` : ''}`,
  );
  const failing = rows.filter((r) => r.enabled && r.consecutiveFailures >= 3).length;
  return truncate([`소스 ${rows.filter((r) => r.enabled).length}/${rows.length}개 활성 · 연속 실패 ${failing}개`, '✅ 정상  ❗ 실패 중  ⚠️ 3회 이상 실패  · 아직 성공 없음  ⏸ 꺼짐', ...lines].join('\n'));
}

const HIT_KO: Record<string, string> = { strong: '강', weak: '약', none: '무관' };
const LLM_KO: Record<string, string> = { pending: '대기', done: '완료', skipped: '제외', error: '오류' };

export function buildRecentReply(rows: RecentRawItem[]): string {
  if (rows.length === 0) return '아직 수집한 글이 없습니다.';
  const lines = rows.map(
    (r) => `${shortKst(r.fetchedAt)} [${HIT_KO[r.keywordHit ?? ''] ?? '-'}·${LLM_KO[r.llmStatus] ?? r.llmStatus}] ${r.source} · ${(r.title ?? '(제목 없음)').slice(0, 60)}`,
  );
  return truncate(['최근 수집 (시각 [키워드·추출] 출처 · 제목)', ...lines].join('\n'));
}

const STATUS_KO: Record<string, string> = { announced: '발표', ticket_scheduled: '예매 예정', on_sale: '판매 중', ongoing: '진행 중' };

export function buildEventsReply(rows: EventRow[]): string {
  if (rows.length === 0) return '조건에 맞는 다가오는 행사가 없습니다.';
  const lines = rows.map((e) => {
    const date = e.startDate ? e.startDate.slice(5) + (e.endDate && e.endDate !== e.startDate ? `~${e.endDate.slice(5)}` : '') : '일정 미정';
    const open = e.status === 'ticket_scheduled' && e.ticketOpenAt ? ` · 티켓 ${shortKst(e.ticketOpenAt)}` : '';
    return `${date} ${e.title}${e.venue ? ` · ${e.venue}` : ''} · ${STATUS_KO[e.status] ?? e.status}${open}`;
  });
  return truncate(lines.join('\n'));
}

