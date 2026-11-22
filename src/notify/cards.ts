import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  escapeMarkdown,
  type APIMessageTopLevelComponent,
} from 'discord.js';
import type { EventRow } from '../pipeline/merge.js';
import type { EventScope } from '../services/events.js';
import type { SourceStatusRow } from '../services/sources.js';
import type { RecentRawItem } from '../services/rawItems.js';
import type { Diagnostics, SourceFunnelRow } from '../services/diagnostics.js';
import { discordTime, formatKstShort, formatPeriodKo } from './format.js';
import { CARD_COLOR, DOT, KIND_KO, OFFICIALITY_KO, REGION_IMAGES, STATUS_ICON, STATUS_KO, regionMeta } from './labels.js';

/**
 * 디스코드 Components V2 카드. 봇으로 보낼 때만 쓰고, 웹후크나 카드가 거부될 때는 같은 메시지의 embeds로 보낸다.
 * 메시지 한 통에 컴포넌트 40개, 글자 4000자까지라 목록은 페이지로 나눈다.
 */
export type Card = APIMessageTopLevelComponent[];

export const EVENTS_PAGE_SIZE = 8;
const SCOPE_TITLE: Record<EventScope, string> = { all: '전체', domestic: '🇰🇷 국내', japan: '🇯🇵 일본', overseas: '🌏 해외 (일본 제외)' };

/** 제목·이름의 마크다운 기호를 이스케이프 (링크 글자 안의 대괄호는 전각으로) */
export const esc = (s: string) => escapeMarkdown(s).replace(/\[/g, '［').replace(/\]/g, '］');

/** 링크 버튼에 쓸 수 있는 URL인지 (http(s), 512자 이하) */
export function linkable(url: string | null | undefined): url is string {
  if (!url || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 마크다운 링크 안에서 괄호가 링크를 끊지 않게 */
const mdUrl = (url: string) => url.replace(/\(/g, '%28').replace(/\)/g, '%29');

const shortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '');

/** "11-22 23:05" 형태의 짧은 한국 시각 */
function shortKst(iso: string | null): string {
  if (!iso) return '기록 없음';
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

const header = (title: string, sub: string) => new TextDisplayBuilder().setContent(`## ${title}\n-# ${sub}`).toJSON();

function linkButton(label: string, url: string) {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}

// ── 공지 카드 ──────────────────────────────────────────────

/**
 * 구글 캘린더 일정 추가 링크. 예매 예정이면 티켓 오픈 30분, 아니면 행사 기간(종일).
 * 버튼 URL 한도(512자)를 넘으면 설명 → 제목 순으로 줄인다.
 */
export function calendarLink(e: EventRow, detailUrl?: string): { label: string; url: string } | null {
  const ticket = e.status === 'ticket_scheduled' && e.ticketOpenAt;
  let dates: string;
  let text: string;
  if (ticket) {
    const start = new Date(e.ticketOpenAt!);
    const end = new Date(start.getTime() + 30 * 60_000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    dates = `${fmt(start)}/${fmt(end)}`;
    text = `🎫 티켓 오픈: ${e.title}`;
  } else if (e.startDate) {
    const endExclusive = new Date(`${e.endDate ?? e.startDate}T00:00:00Z`);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    dates = `${e.startDate.replace(/-/g, '')}/${endExclusive.toISOString().slice(0, 10).replace(/-/g, '')}`;
    text = e.title;
  } else {
    return null;
  }
  const location = [e.venue, e.city].filter(Boolean).join(', ');
  const build = (t: string, details?: string) => {
    const p = new URLSearchParams({ action: 'TEMPLATE', text: t, dates });
    if (location) p.set('location', location);
    if (details) p.set('details', details);
    return `https://calendar.google.com/calendar/render?${p.toString()}`;
  };
  let url = build(text, detailUrl);
  if (url.length > 512) url = build(text);
  for (let n = text.length; url.length > 512 && n > 10; n -= 10) url = build(`${text.slice(0, n - 10)}…`);
  if (url.length > 512) return null;
  return { label: ticket ? '📅 티켓 오픈 캘린더에 추가' : '📅 캘린더에 추가', url };
}

/** 공지 카드: 머리말 → 제목·요약 → 일정·장소·티켓 → 지역 이미지 → 버튼(예매·원문·캘린더) */
export function noticeCard(
  e: EventRow,
  head: { label: string; icon: string; color: number },
  sourceUrls: string[],
): Card {
  const region = regionMeta(e.region);
  const ticketUrl = linkable(e.ticketUrl) ? e.ticketUrl : undefined;
  const sourceUrl = sourceUrls.find(linkable);
  const titleUrl = ticketUrl ?? sourceUrl;
  const place = [e.city, e.venue].filter(Boolean).join(' · ') || '미정';
  const summary = (e.summaryKo ?? '').trim();

  const details = [
    `📅 **일정**　${formatPeriodKo(e.startDate, e.endDate)}`,
    `📍 **장소**　${esc(place)}`,
    e.ticketOpenAt
      ? `🎫 **티켓 오픈**　${formatKstShort(e.ticketOpenAt)} KST · ${discordTime(e.ticketOpenAt, 'R')}`
      : '🎫 **티켓 오픈**　미정',
  ];

  const c = new ContainerBuilder()
    .setAccentColor(head.color)
    .addTextDisplayComponents((t) =>
      t.setContent(
        `-# ${head.icon} ${head.label}　·　${region.flag} ${region.label} · ${KIND_KO[e.kind] ?? e.kind} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`,
      ),
    )
    .addTextDisplayComponents((t) =>
      t.setContent(
        [`## ${titleUrl ? `[${esc(e.title)}](${mdUrl(titleUrl)})` : esc(e.title)}`, ...(summary ? [`> ${esc(summary).replace(/\n/g, '\n> ')}`] : [])]
          .join('\n')
          .slice(0, 1800),
      ),
    )
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(details.join('\n')));

  const image = REGION_IMAGES[e.region];
  if (image) c.addMediaGalleryComponents((g) => g.addItems((i) => i.setURL(image).setDescription(`${region.label} 행사`)));

  const buttons: ButtonBuilder[] = [];
  if (ticketUrl) buttons.push(linkButton('🎫 예매하기', ticketUrl));
  if (sourceUrl) buttons.push(linkButton('📰 원문 보기', sourceUrl));
  const cal = calendarLink(e, titleUrl);
  if (cal) buttons.push(linkButton(cal.label, cal.url));
  if (buttons.length) c.addActionRowComponents((r) => r.setComponents(buttons));

  c.addTextDisplayComponents((t) => t.setContent(`-# ${STATUS_ICON[e.status] ?? '📢'} ${STATUS_KO[e.status] ?? e.status} · 미쿠 행사 알림`));
  return [c.toJSON()];
}

// ── /행사 ──────────────────────────────────────────────────

function eventBlock(e: EventRow, link: string | undefined): ContainerBuilder {
  const region = regionMeta(e.region);
  const place = [e.city, e.venue].filter(Boolean).join(' · ');
  const ticket =
    e.status === 'ticket_scheduled' && e.ticketOpenAt
      ? ` · 티켓 오픈 ${formatKstShort(e.ticketOpenAt)} (${discordTime(e.ticketOpenAt, 'R')})`
      : '';
  const text = [
    `### ${region.flag} ${esc(e.title)}`,
    `📅 ${formatPeriodKo(e.startDate, e.endDate)}`,
    ...(place ? [`📍 ${esc(place)}`] : []),
    `${STATUS_ICON[e.status] ?? '📢'} **${STATUS_KO[e.status] ?? e.status}**${ticket}`,
    `-# ${KIND_KO[e.kind] ?? e.kind} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`,
  ].join('\n');
  const c = new ContainerBuilder().setAccentColor(region.color);
  if (link) {
    c.addSectionComponents((s) =>
      s.addTextDisplayComponents((t) => t.setContent(text)).setButtonAccessory(linkButton(e.ticketUrl === link ? '🎫 예매' : '🔗 원문', link)),
    );
  } else {
    c.addTextDisplayComponents((t) => t.setContent(text));
  }
  return c;
}

/** /행사 페이지 버튼 custom_id: "ev:<범위>:<페이지>" */
export const eventsPageId = (scope: EventScope, page: number) => `ev:${scope}:${page}`;

export function parseEventsPageId(id: string): { scope: string; page: number } | null {
  const m = /^ev:([a-z]+):(\d+)$/.exec(id);
  return m ? { scope: m[1]!, page: Number(m[2]) } : null;
}

/** /행사 카드. 행사마다 지역 색 카드 + 예매(없으면 원문) 버튼, 8건 넘으면 이전·다음 버튼 */
export function eventsCard(rows: EventRow[], scope: EventScope, page: number, links: Map<number, string>): Card {
  const pages = Math.max(1, Math.ceil(rows.length / EVENTS_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(p * EVENTS_PAGE_SIZE, (p + 1) * EVENTS_PAGE_SIZE);
  const out: Card = [header(`🎤 다가오는 행사 · ${SCOPE_TITLE[scope]}`, `${rows.length}건 · 종료·취소·검수 대기 제외 · 한국 시간`)];
  if (slice.length === 0) {
    out.push(
      new ContainerBuilder()
        .setAccentColor(CARD_COLOR.wait)
        .addTextDisplayComponents((t) =>
          t.setContent('조건에 맞는 다가오는 행사가 없어요.\n-# `/점검`으로 수집 상태를, `/가이드`로 수집 범위를 볼 수 있어요.'),
        )
        .toJSON(),
    );
    return out;
  }
  for (const e of slice) {
    const link = links.get(e.id);
    out.push(eventBlock(e, linkable(link) ? link : undefined).toJSON());
  }
  if (pages > 1) {
    out.push(
      new ActionRowBuilder<ButtonBuilder>()
        .setComponents(
          new ButtonBuilder().setCustomId(eventsPageId(scope, p - 1)).setLabel('◀ 이전').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
          new ButtonBuilder().setCustomId('ev:pos').setLabel(`${p + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(eventsPageId(scope, p + 1)).setLabel('다음 ▶').setStyle(ButtonStyle.Primary).setDisabled(p === pages - 1),
        )
        .toJSON(),
    );
  }
  return out;
}

// ── /소스 ──────────────────────────────────────────────────

type Group<T> = { key: string; title: string; color: number; rows: T[]; line: (r: T) => string };

function groupedCard<T>(head: ReturnType<typeof header>, groups: Group<T>[]): Card {
  const out: Card = [head];
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    out.push(
      new ContainerBuilder()
        .setAccentColor(g.color)
        .addTextDisplayComponents((t) => t.setContent([`### ${g.title} · ${g.rows.length}`, ...g.rows.map(g.line)].join('\n').slice(0, 1900)))
        .toJSON(),
    );
  }
  return out;
}

export function sourceState(r: Pick<SourceStatusRow, 'enabled' | 'implemented' | 'consecutiveFailures' | 'lastSuccessAt'>) {
  if (!r.enabled) return 'off' as const;
  if (!r.implemented) return 'todo' as const;
  if (r.consecutiveFailures >= 3) return 'alert' as const;
  if (r.consecutiveFailures > 0) return 'fail' as const;
  return r.lastSuccessAt ? ('ok' as const) : ('wait' as const);
}

export function sourcesCard(rows: SourceStatusRow[]): Card {
  const by = (s: ReturnType<typeof sourceState>) => rows.filter((r) => sourceState(r) === s);
  const active = rows.filter((r) => r.enabled && r.implemented).length;
  const alerts = by('alert').length;
  const name = (r: SourceStatusRow) => `**${esc(shortName(r.name))}**`;
  return groupedCard(header('📡 수집처 상태', `실제 수집 ${active}/${rows.length}곳 · 경보 ${alerts}곳 · 한국 시간`), [
    { key: 'alert', title: `${DOT.alert} 경보 (3회 이상 연속 실패)`, color: CARD_COLOR.alert, rows: by('alert'), line: (r) => `${DOT.alert} ${name(r)} · 연속 ${r.consecutiveFailures}회 실패 · 마지막 성공 ${shortKst(r.lastSuccessAt)}` },
    { key: 'fail', title: `${DOT.fail} 실패`, color: CARD_COLOR.fail, rows: by('fail'), line: (r) => `${DOT.fail} ${name(r)} · 연속 ${r.consecutiveFailures}회 · 마지막 성공 ${shortKst(r.lastSuccessAt)}` },
    { key: 'ok', title: `${DOT.ok} 정상`, color: CARD_COLOR.ok, rows: by('ok'), line: (r) => `${DOT.ok} ${name(r)} · ${shortKst(r.lastSuccessAt)}` },
    { key: 'wait', title: `${DOT.wait} 대기 (아직 성공 기록 없음)`, color: CARD_COLOR.wait, rows: by('wait'), line: (r) => `${DOT.wait} ${name(r)}` },
    { key: 'todo', title: `${DOT.todo} 준비 중 (수집기 구현 전)`, color: CARD_COLOR.off, rows: by('todo'), line: (r) => `${DOT.todo} ${name(r)}` },
    { key: 'off', title: `${DOT.off} 꺼짐 (주소·요청 형식 미확인)`, color: CARD_COLOR.off, rows: by('off'), line: (r) => `${DOT.off} ${name(r)}` },
  ]);
}

// ── /최근수집 ───────────────────────────────────────────────

export function recentCard(rows: RecentRawItem[]): Card {
  const line = (r: RecentRawItem) => {
    const title = esc(r.title?.trim() || '(제목 없음)').slice(0, 80);
    return `\`${shortKst(r.fetchedAt)}\` **${esc(shortName(r.source))}** · ${linkable(r.url) ? `[${title}](${mdUrl(r.url)})` : title}`;
  };
  const by = (s: string) => rows.filter((r) => r.llmStatus === s);
  if (rows.length === 0) {
    return [header('📥 최근 수집', '아직 수집한 글이 없어요')];
  }
  return groupedCard(header('📥 최근 수집', `최근 ${rows.length}건 · 한국 시간`), [
    { key: 'done', title: '✅ Claude 판정 완료', color: CARD_COLOR.ok, rows: by('done'), line },
    { key: 'pending', title: '⏳ 판정 대기', color: CARD_COLOR.fail, rows: by('pending'), line },
    { key: 'error', title: '❌ 판정 오류', color: CARD_COLOR.alert, rows: by('error'), line },
    { key: 'skipped', title: '🚫 키워드 미달 (판정 안 함)', color: CARD_COLOR.wait, rows: by('skipped'), line },
  ]);
}

// ── /점검 ──────────────────────────────────────────────────

const funnelState = (r: SourceFunnelRow) =>
  sourceState({ enabled: r.schedulable, implemented: r.implemented, consecutiveFailures: r.consecutiveFailures, lastSuccessAt: r.lastSuccessAt });

export function diagnosticsCard(d: Diagnostics): Card {
  const regionLines = d.regions.map((r) => {
    const m = regionMeta(r.region);
    return `${m.flag} **${m.label}**　다가옴 **${r.upcoming}** · 종료 ${r.ended} · 취소 ${r.cancelled} · 검수 ${r.needsReview}`;
  });
  const recent = d.recentKr.length
    ? d.recentKr.map((e) => {
        const status = e.needsReview ? '🔍 검수' : `${STATUS_ICON[e.status] ?? '📢'} ${STATUS_KO[e.status] ?? e.status}`;
        return `${status} · ${formatPeriodKo(e.startDate, e.endDate)} · ${esc(e.title)}`;
      })
    : ['아직 국내 행사로 등록된 것이 없어요.'];

  const kr = d.krSources;
  const running = kr.filter((r) => r.schedulable && r.implemented);
  const sum = (k: 'collected' | 'passed' | 'extracted' | 'linked') => kr.reduce((a, r) => a + r[k], 0);
  const sourceLine = (r: SourceFunnelRow) => {
    const s = funnelState(r);
    const n = `**${esc(shortName(r.name))}**`;
    if (s === 'todo') return `${DOT.todo} ${n} · 수집기 구현 전`;
    if (s === 'off') return `${DOT.off} ${n} · 꺼짐`;
    return `${DOT[s]} ${n} · 수집 ${r.collected} · 통과 ${r.passed} · 판정 ${r.extracted} · 행사 ${r.linked}`;
  };

  const events = new ContainerBuilder()
    .setAccentColor(CARD_COLOR.miku)
    .addTextDisplayComponents((t) => t.setContent(['### 📊 행사 현황', ...regionLines].join('\n')))
    .addTextDisplayComponents((t) => t.setContent('-# 다가옴: 발표·예정·판매·진행 (검수 대기 제외) · 검수: 확신이 낮아 알림을 보내지 않은 행사'))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(['**최근 국내 행사** (종료 포함, 최근 갱신 순)', ...recent].join('\n').slice(0, 1500)));

  const sources = new ContainerBuilder()
    .setAccentColor(running.length < kr.length ? CARD_COLOR.fail : CARD_COLOR.ok)
    .addTextDisplayComponents((t) =>
      t.setContent(
        [
          `### 🛰️ 국내 수집처 ${running.length}/${kr.length}곳 수집 중`,
          `가져온 글 **${sum('collected')}** → 키워드 통과 **${sum('passed')}** → Claude 판정 **${sum('extracted')}** → 행사 연결 **${sum('linked')}**`,
        ].join('\n'),
      ),
    )
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(kr.map(sourceLine).join('\n').slice(0, 1900)))
    .addTextDisplayComponents((t) => t.setContent('-# 사이트 변경 감지는 처음 볼 때 기준만 잡아서 수집 0건이 정상일 수 있어요.'));

  return [
    header('🩺 점검', `전체 판정 대기 ${d.pendingItems}건 · 판정 오류 ${d.errorItems}건`),
    events.toJSON(),
    sources.toJSON(),
  ];
}
