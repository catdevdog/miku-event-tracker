import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import { esc } from './cards.js';
import { discordTime, formatDateKo, formatKstShort, formatPeriodKo } from './format.js';
import { CARD_COLOR, regionMeta } from './labels.js';
import type { OutgoingMessage } from './types.js';

/** 매주 월요일 09:00(KST) 공지 채널에 보내는 "이번 주 행사" 요약 */

const MAX_LINES = 10;

/** now가 속한 주(월~일, KST)의 날짜와 UTC 경계 */
export function weekRangeKst(now: Date) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const dow = (kst.getUTCDay() + 6) % 7; // 월=0
  const mon = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - dow));
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  return {
    mon: ymd(mon),
    sun: ymd(sun),
    fromIso: new Date(mon.getTime() - 9 * 3600_000).toISOString(),
    toIso: new Date(mon.getTime() + 7 * 86_400_000 - 9 * 3600_000).toISOString(),
  };
}

export interface WeeklyData {
  range: ReturnType<typeof weekRangeKst>;
  happening: EventRow[];
  ticketOpens: EventRow[];
  added: EventRow[];
}

export async function weeklyData(db: Db, now: Date): Promise<WeeklyData> {
  const range = weekRangeKst(now);
  const confirmed = and(eq(events.needsReview, 0), sql`${events.status} <> 'cancelled'`);
  const happening = await db
    .select()
    .from(events)
    .where(and(confirmed, sql`${events.startDate} <= ${range.sun}`, sql`coalesce(${events.endDate}, ${events.startDate}) >= ${range.mon}`))
    .orderBy(sql`${events.region} <> 'KR'`, asc(events.startDate));
  const ticketOpens = await db
    .select()
    .from(events)
    .where(and(confirmed, gte(events.ticketOpenAt, range.fromIso), lt(events.ticketOpenAt, range.toIso)))
    .orderBy(asc(events.ticketOpenAt));
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const added = await db
    .select()
    .from(events)
    .where(and(confirmed, sql`${events.status} <> 'ended'`, sql`replace(${events.createdAt}, ' ', 'T') >= ${weekAgo.slice(0, 19)}`))
    .orderBy(sql`${events.region} <> 'KR'`, asc(events.startDate));
  return { range, happening, ticketOpens, added };
}

function section(title: string, color: number, rows: EventRow[], line: (e: EventRow) => string) {
  const shown = rows.slice(0, MAX_LINES).map(line);
  if (rows.length > MAX_LINES) shown.push(`-# 외 ${rows.length - MAX_LINES}건은 \`/행사\`에서 볼 수 있어요`);
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents((t) => t.setContent([`### ${title} · ${rows.length}`, ...shown].join('\n').slice(0, 1900)))
    .toJSON();
}

/** 보낼 내용이 하나도 없으면 null (빈 요약은 보내지 않는다) */
export function weeklyMessage(d: WeeklyData): OutgoingMessage | null {
  if (!d.happening.length && !d.ticketOpens.length && !d.added.length) return null;
  const flagTitle = (e: EventRow) => `${regionMeta(e.region).flag} **${esc(e.title)}**`;
  const place = (e: EventRow) => [e.city, e.venue].filter(Boolean).join(' · ');
  const period = `${formatDateKo(d.range.mon).slice(5)} ~ ${formatDateKo(d.range.sun).slice(5)}`;
  const card = [
    new TextDisplayBuilder().setContent(`## 🗓️ 이번 주 미쿠 행사\n-# ${period} · 한국 시간`).toJSON(),
    ...(d.happening.length
      ? [section('🎪 이번 주에 열려요', CARD_COLOR.miku, d.happening, (e) => `${flagTitle(e)}\n　📅 ${formatPeriodKo(e.startDate, e.endDate)}${place(e) ? `　📍 ${esc(place(e))}` : ''}`)]
      : []),
    ...(d.ticketOpens.length
      ? [section('🎫 이번 주 티켓 오픈', 0xf5a623, d.ticketOpens, (e) => `${flagTitle(e)}\n　⏰ ${formatKstShort(e.ticketOpenAt!)} · ${discordTime(e.ticketOpenAt!, 'R')}`)]
      : []),
    ...(d.added.length ? [section('🆕 지난 7일 새로 올라왔어요', CARD_COLOR.info, d.added, (e) => `${flagTitle(e)} · ${formatPeriodKo(e.startDate, e.endDate)}`)] : []),
    new TextDisplayBuilder().setContent('-# `/행사`로 전체 목록을, `@봇`에게 질문으로 자세한 내용을 볼 수 있어요').toJSON(),
  ];
  const plain = (rows: EventRow[], f: (e: EventRow) => string) => rows.slice(0, MAX_LINES).map((e) => `- ${f(e)}`).join('\n') || '- 없음';
  return {
    card,
    embeds: [
      {
        title: `🗓️ 이번 주 미쿠 행사 (${period})`,
        color: CARD_COLOR.miku,
        fields: [
          { name: '🎪 이번 주에 열려요', value: plain(d.happening, (e) => `${e.title} · ${formatPeriodKo(e.startDate, e.endDate)}`).slice(0, 1024) },
          { name: '🎫 이번 주 티켓 오픈', value: plain(d.ticketOpens, (e) => `${e.title} · ${formatKstShort(e.ticketOpenAt!)} KST`).slice(0, 1024) },
          { name: '🆕 지난 7일 새로 올라왔어요', value: plain(d.added, (e) => e.title).slice(0, 1024) },
        ],
      },
    ],
  };
}

// ── 놓친 행사 주간 리포트 (관리자 채널) ──────────────────────

export interface MissReport {
  /** 제보로 처음 알게 된 행사 (봇이 먼저 못 잡은 것) */
  missed: { title: string; source: string | null }[];
  /** 제보가 왔지만 이미 수집돼 있던 행사 수 */
  caught: number;
  /** 제보 중 관련 없다고 판정한 수 */
  irrelevant: number;
  /** 놓친 행사 출처의 사이트별 건수 (많은 순) */
  hosts: { host: string; n: number }[];
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/** 지난 7일의 제보·누락 기록 */
export async function missReport(db: Db, now: Date): Promise<MissReport> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await db.all<{ title: string | null; source: string | null; caught: number }>(sql`
    SELECT e.title AS title, m.first_seen_source AS source, m.caught_by_system AS caught
    FROM misses m LEFT JOIN events e ON e.id = m.event_id
    WHERE m.noticed_at >= ${since} ORDER BY m.id
  `);
  const [irr] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM reports WHERE created_at >= ${since} AND result LIKE '⚪%'`);
  const missed = rows.filter((r) => !r.caught).map((r) => ({ title: r.title ?? '(지워진 행사)', source: r.source }));
  const counts = new Map<string, number>();
  for (const m of missed) {
    const h = hostOf(m.source);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return {
    missed,
    caught: rows.length - missed.length,
    irrelevant: Number(irr?.n ?? 0),
    hosts: [...counts].map(([host, n]) => ({ host, n })).sort((a, b) => b.n - a.n),
  };
}

/** 관리자 채널용 리포트. 제보가 하나도 없었으면 null */
export function missReportMessage(r: MissReport): OutgoingMessage | null {
  if (r.missed.length + r.caught + r.irrelevant === 0) return null;
  const lines = [
    '### 📮 지난 7일 제보 리포트',
    `놓친 행사 **${r.missed.length}** · 이미 잡은 행사 ${r.caught} · 관련 없음 ${r.irrelevant}`,
    ...r.missed.slice(0, 10).map((m) => `- ${esc(m.title)}${hostOf(m.source) ? ` · ${hostOf(m.source)}` : ''}`),
    ...(r.hosts.length ? ['', `**놓친 출처**　${r.hosts.slice(0, 6).map((h) => `${h.host} ${h.n}건`).join(' · ')}`, '-# 자주 나오는 사이트는 수집처로 추가하거나 `/관리 키워드`로 키워드를 보강해 보세요.'] : []),
  ];
  const text = lines.join('\n').slice(0, 1900);
  return {
    card: [new ContainerBuilder().setAccentColor(r.missed.length ? CARD_COLOR.fail : CARD_COLOR.ok).addTextDisplayComponents((t) => t.setContent(text)).toJSON()],
    content: text,
  };
}
