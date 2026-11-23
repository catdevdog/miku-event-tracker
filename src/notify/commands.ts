import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ServiceStatus } from '../services/status.js';
import type { SourceStatusRow } from '../services/sources.js';
import type { RecentRawItem } from '../services/rawItems.js';
import type { EventScope } from '../services/events.js';
import type { Diagnostics, SourceFunnelRow } from '../services/diagnostics.js';
import type { EventRow } from '../pipeline/merge.js';
import { formatKst, textTable } from './format.js';
import { EVENT_KINDS } from '../db/schema.js';
import { KIND_GROUPS, kindLabel, type KindGroup } from './labels.js';
import type { OutgoingMessage } from './types.js';
import { diagnosticsCard, eventsCard, EVENTS_PAGE_SIZE, recentCard, sourcesCard } from './cards.js';

/** 길드 슬래시 명령 정의. 길드 단위로 등록하면 바로 반영된다. */
export const commandDefinitions = [
  new SlashCommandBuilder().setName('ping').setDescription('봇과 수집기 상태를 확인합니다').toJSON(),
  new SlashCommandBuilder().setName('소스').setDescription('소스별 마지막 수집 성공 시각과 실패 횟수').toJSON(),
  new SlashCommandBuilder().setName('최근수집').setDescription('최근 수집한 글과 키워드·추출 판정').toJSON(),
  new SlashCommandBuilder()
    .setName('행사')
    .setDescription('다가오는 미쿠 행사')
    .addStringOption((o) =>
      o
        .setName('범위')
        .setDescription('국내·일본·해외·전체 (기본: 전체)')
        .addChoices(
          { name: '국내', value: 'domestic' },
          { name: '일본', value: 'japan' },
          { name: '해외 (일본 제외)', value: 'overseas' },
          { name: '전체', value: 'all' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('유형')
        .setDescription('행사 유형 (기본: 전체)')
        .addChoices(...Object.entries(KIND_GROUPS).map(([value, g]) => ({ name: g.label, value }))),
    )
    .addStringOption((o) => o.setName('검색').setDescription('행사 이름으로 찾기 (입력하면 후보가 떠요)').setAutocomplete(true))
    .toJSON(),
  new SlashCommandBuilder().setName('점검').setDescription('지역별 행사 수와 국내 수집처 단계별 건수').toJSON(),
  new SlashCommandBuilder().setName('가이드').setDescription('봇 이용법, 수집 주기, 알림 시점 안내').toJSON(),
  new SlashCommandBuilder()
    .setName('제보')
    .setDescription('봇이 놓친 미쿠 행사를 알려 주세요')
    .addStringOption((o) => o.setName('링크').setDescription('행사 공지·기사·예매 페이지 주소').setRequired(true))
    .addStringOption((o) => o.setName('메모').setDescription('어떤 행사인지 한 줄 (선택)').setMaxLength(500))
    .toJSON(),
  new ContextMenuCommandBuilder().setName('행사 제보').setType(ApplicationCommandType.Message).toJSON(),
  new SlashCommandBuilder()
    .setName('관리')
    .setDescription('관리자: 수집처·키워드·행사·알림 관리')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('소스')
        .setDescription('수집처 멈춤·재개·지금 수집')
        .addStringOption((o) => o.setName('이름').setDescription('수집처').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o.setName('동작').setDescription('할 일').setRequired(true).addChoices({ name: '멈춤', value: 'pause' }, { name: '재개', value: 'resume' }, { name: '지금 수집', value: 'run' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('키워드')
        .setDescription('키워드 추가·삭제·목록')
        .addStringOption((o) =>
          o.setName('동작').setDescription('할 일').setRequired(true).addChoices({ name: '추가', value: 'add' }, { name: '삭제', value: 'remove' }, { name: '목록', value: 'list' }),
        )
        .addStringOption((o) => o.setName('단어').setDescription('추가·삭제할 단어').setMaxLength(40))
        .addStringOption((o) =>
          o
            .setName('등급')
            .setDescription('추가할 때 (기본: 강)')
            .addChoices(
              { name: '강 (단독으로 통과)', value: 'strong' },
              { name: '약 (맥락 단어와 같이 있어야 통과)', value: 'weak' },
              { name: '맥락', value: 'context' },
              { name: '제외', value: 'exclude' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('행사')
        .setDescription('행사 수정·유형 변경·숨기기·다시 보이기')
        .addStringOption((o) => o.setName('행사').setDescription('행사 이름 또는 #번호').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('동작')
            .setDescription('할 일')
            .setRequired(true)
            .addChoices({ name: '수정', value: 'edit' }, { name: '유형 변경', value: 'kind' }, { name: '숨기기', value: 'hide' }, { name: '다시 보이기', value: 'unhide' }),
        )
        .addStringOption((o) =>
          o
            .setName('유형')
            .setDescription('유형 변경일 때: 바꿀 유형')
            .addChoices(...EVENT_KINDS.map((k) => ({ name: kindLabel(k), value: k }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('합치기')
        .setDescription('같은 행사가 두 개로 잡혔을 때 하나로')
        .addStringOption((o) => o.setName('남길행사').setDescription('남길 행사').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('합칠행사').setDescription('합쳐서 숨길 행사').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('알림')
        .setDescription('알림 발송 일시정지·재개')
        .addStringOption((o) =>
          o.setName('동작').setDescription('할 일').setRequired(true).addChoices({ name: '일시정지', value: 'pause' }, { name: '재개', value: 'resume' }, { name: '상태', value: 'status' }),
        ),
    )
    .addSubcommand((s) => s.setName('설정').setDescription('알림 역할·구독 패널·상태판을 지금 다시 맞추고 권한을 점검'))
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
  !r.enabled ? '꺼짐' : r.paused ? '멈춤' : !r.implemented ? '준비' : r.consecutiveFailures >= 3 ? '경보' : r.consecutiveFailures > 0 ? '실패' : r.lastSuccessAt ? '정상' : '대기';

export function buildSourcesReply(rows: SourceStatusRow[]): OutgoingMessage {
  const enabled = rows.filter((r) => r.enabled);
  const failing = enabled.filter((r) => r.consecutiveFailures >= 3).length;
  const table = textTable(
    ['상태', '마지막 성공', '실패', '소스'],
    rows.map((r) => [SOURCE_STATE(r), shortKst(r.lastSuccessAt), String(r.consecutiveFailures), r.name]),
    40,
  );
  return {
    card: sourcesCard(rows),
    embeds: [
      {
        title: '소스 상태',
        description: `${table}\n정상: 마지막 실행 성공 · 실패: 1~2회 연속 실패 · 경보: 3회 이상 · 대기: 아직 성공 없음 · 준비: 수집기 구현 전 · 꺼짐: 비활성`,
        color: failing > 0 ? COLOR.warn : COLOR.info,
        footer: { text: `활성 ${enabled.length}/${rows.length}개 · 3회 이상 연속 실패 ${failing}개 · 시각은 한국 시간` },
      },
    ],
  };
}

const HIT_KO: Record<string, string> = { strong: '강', weak: '약', none: '무' };
const LLM_KO: Record<string, string> = { pending: '대기', done: '완료', skipped: '제외', error: '오류' };

export function buildRecentReply(rows: RecentRawItem[]): OutgoingMessage {
  if (rows.length === 0) return { card: recentCard(rows), embeds: [{ title: '최근 수집', description: '아직 수집한 글이 없습니다.', color: COLOR.info }] };
  const table = textTable(
    ['수집 시각', '키', '추출', '출처 · 제목'],
    rows.map((r) => [shortKst(r.fetchedAt), HIT_KO[r.keywordHit ?? ''] ?? '미', LLM_KO[r.llmStatus] ?? '기타', `${r.source} · ${r.title ?? '(제목 없음)'}`]),
    46,
  );
  return {
    card: recentCard(rows),
    embeds: [
      {
        title: `최근 수집 ${rows.length}건`,
        description: `${table}\n키(키워드): 강·약·무·미(판정 전) · 추출: 대기·완료·제외(키워드 미달)·오류`,
        color: COLOR.info,
      },
    ],
  };
}

export type { EventScope };
export const SCOPE_KO: Record<EventScope, string> = { domestic: '국내', japan: '일본', overseas: '해외 (일본 제외)', all: '전체' };
const STATUS2: Record<string, string> = { announced: '발표', ticket_scheduled: '예정', on_sale: '판매', ongoing: '진행' };
const REGION2: Record<string, string> = { KR: '국내', JP: '일본', OTHER: '해외' };

function shortDate(start: string | null, end: string | null): string {
  if (!start) return '일정 미정  ';
  const s = start.slice(2).replace(/-/g, '.');
  return end && end !== start ? `${s}~${end.slice(5).replace('-', '.')}` : s;
}

/**
 * /행사 응답. 카드는 8건씩 페이지로 나누고(page), 임베드(대체용)는 해당 페이지를 표로 보여 준다.
 * links: 행사 id → 예매(없으면 원문) URL
 */
export function buildEventsReply(rows: EventRow[], scope: EventScope = 'all', page = 0, links: Map<number, string> = new Map(), kind?: KindGroup): OutgoingMessage {
  const title = `다가오는 행사 · ${SCOPE_KO[scope]}${kind ? ` · ${KIND_GROUPS[kind].label}` : ''}`;
  const card = eventsCard(rows, scope, page, links, kind);
  if (rows.length === 0) {
    return { card, embeds: [{ title, description: '조건에 맞는 다가오는 행사가 없습니다. (종료·취소·검수 대기 행사는 빠집니다)', color: COLOR.info }] };
  }
  const pages = Math.ceil(rows.length / EVENTS_PAGE_SIZE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const pageRows = rows.slice(p * EVENTS_PAGE_SIZE, (p + 1) * EVENTS_PAGE_SIZE);
  const table = textTable(
    ['날짜', '지역', '상태', '행사'],
    pageRows.map((e) => {
      const ticket = e.status === 'ticket_scheduled' && e.ticketOpenAt ? ` · 티켓 ${shortKst(e.ticketOpenAt)}` : '';
      return [shortDate(e.startDate, e.endDate), REGION2[e.region] ?? '해외', STATUS2[e.status] ?? '기타', `${e.title}${e.venue ? ` @${e.venue}` : ''}${ticket}`];
    }),
    72,
  );
  return {
    card,
    embeds: [
      {
        title,
        description: `${table}\n상태: 발표 · 예정(예매 일정 공지) · 판매(판매 중) · 진행(행사 기간)`,
        color: COLOR.info,
        footer: { text: `${rows.length}건${pages > 1 ? ` (${p + 1}/${pages}쪽)` : ''} · 종료·취소·검수 대기 제외 · 시각은 한국 시간` },
      },
    ],
  };
}


const STATUS_ALL: Record<string, string> = { ...STATUS2, ended: '종료', cancelled: '취소' };

// 상태 열은 다른 표와 같이 2글자: 준비(어댑터 구현 전), 꺼짐(주소·형식 미확인)
const FUNNEL_STATE = (r: SourceFunnelRow) =>
  !r.schedulable
    ? '꺼짐'
    : !r.implemented
      ? '준비'
      : r.consecutiveFailures >= 3
        ? '경보'
        : r.consecutiveFailures > 0
          ? '실패'
          : r.lastSuccessAt
            ? '정상'
            : '대기';

export function buildDiagnosticsReply(d: Diagnostics): OutgoingMessage {
  const regionTable = textTable(
    ['지역', '다가옴', '종료', '취소', '검수'],
    d.regions.map((r) => [REGION2[r.region] ?? r.region, String(r.upcoming), String(r.ended), String(r.cancelled), String(r.needsReview)]),
  );
  const recent = d.recentKr.length
    ? textTable(
        ['상태', '날짜', '행사'],
        d.recentKr.map((e) => [e.needsReview ? '검수' : (STATUS_ALL[e.status] ?? '기타'), shortDate(e.startDate, e.endDate), e.title]),
        48,
      )
    : '아직 국내 행사로 등록된 것이 없습니다.';

  const kr = d.krSources;
  const running = kr.filter((r) => r.schedulable && r.implemented);
  const sum = (k: 'collected' | 'passed' | 'extracted' | 'linked') => kr.reduce((a, r) => a + r[k], 0);
  const sourceTable = textTable(
    ['상태', '수집', '통과', '추출', '행사', '소스'],
    kr.map((r) => [FUNNEL_STATE(r), String(r.collected), String(r.passed), String(r.extracted), String(r.linked), r.name.replace(/\s*\([^)]*\)\s*$/, '')]),
    30,
  );

  return {
    card: diagnosticsCard(d),
    embeds: [
      {
        title: '🩺 점검 · 행사 현황',
        description: [
          regionTable,
          '다가옴: 발표 · 예정 · 판매 · 진행 (검수 대기 제외) · 검수: 확신이 낮아 알림을 보내지 않은 행사',
          '',
          '**최근 국내 행사** (종료 포함, 최근 갱신 순)',
          recent,
        ].join('\n'),
        color: COLOR.info,
      },
      {
        title: '🩺 점검 · 국내 수집처',
        description: [
          `실제로 수집 중인 국내 수집처 **${running.length}/${kr.length}곳**`,
          `가져온 글 ${sum('collected')} → 키워드 통과 ${sum('passed')} → Claude 판정 ${sum('extracted')} → 행사 연결 ${sum('linked')}`,
          sourceTable,
          '준비: 어댑터 구현 전 · 꺼짐: 주소나 요청 형식 미확인 · 경보: 3회 이상 연속 실패',
          '사이트 변경 감지는 처음 볼 때 기준만 잡으므로 수집 0건이 정상일 수 있어요.',
        ].join('\n'),
        color: running.length < kr.length ? COLOR.warn : COLOR.info,
        footer: { text: `전체 판정 대기 ${d.pendingItems}건 · 판정 오류 ${d.errorItems}건` },
      },
    ],
  };
}
