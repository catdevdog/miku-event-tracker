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
