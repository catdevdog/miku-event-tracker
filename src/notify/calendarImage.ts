import { createRequire } from 'node:module';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import { kstDate } from '../pipeline/state.js';
import { KIND_KO } from './labels.js';

/**
 * 월간 행사 달력 그림 (SVG → PNG). 매월 1일 공지 채널에 올린다.
 * - 칸마다 그날 열리는 행사를 3건까지 (지역 색 점 + 제목), 넘치면 "+N"
 * - 8일 이상 이어지는 행사(팝업·콜라보 등)는 칸을 다 채우지 않게 아래 "기간 행사" 목록으로 뺀다
 * 글꼴은 Noto Sans KR(@expo-google-fonts/noto-sans-kr)을 파일로 읽는다. 컨테이너에 한글 글꼴이 없어도 된다.
 */
const W = 1400;
const PAD = 40;
const HEAD = 150;
const DOW_H = 44;
const CELL_W = (W - PAD * 2) / 7;
const CELL_H = 150;
const LONG_DAYS = 8;
const REGION_COLOR: Record<string, string> = { KR: '#39c5bb', JP: '#e8384f', OTHER: '#3b82f6' };
const DOW = ['월', '화', '수', '목', '금', '토', '일'];

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 글자 폭 어림 (한글·한자·가나는 1, 그 외 0.56) × 글자 크기 */
const charW = (ch: string) => (/[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 1 : 0.56);
export function fitText(s: string, maxPx: number, fontSize: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    w += charW(ch) * fontSize;
    if (w > maxPx - fontSize * 0.7) return `${out.trimEnd()}…`;
    out += ch;
  }
  return out;
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface CalendarData {
  year: number;
  month: number;
  /** 날짜(YYYY-MM-DD) → 그날 열리는 행사 */
  days: Map<string, EventRow[]>;
  /** 8일 이상 이어지는 행사 */
  long: EventRow[];
  total: number;
}

/** 그 달에 걸친 확정 행사 (취소·숨김 제외) */
export async function calendarData(db: Db, year: number, month: number): Promise<CalendarData> {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.needsReview, 0),
        isNull(events.mergedInto),
        isNotNull(events.startDate),
        sql`${events.status} <> 'cancelled'`,
        sql`${events.startDate} <= ${last} AND coalesce(${events.endDate}, ${events.startDate}) >= ${first}`,
      ),
    )
    // 국내 먼저, 그다음 시작일
    .orderBy(sql`CASE ${events.region} WHEN 'KR' THEN 0 WHEN 'JP' THEN 1 ELSE 2 END`, events.startDate, events.id);
  const days = new Map<string, EventRow[]>();
  const long: EventRow[] = [];
  for (const e of rows) {
    const end = e.endDate && e.endDate >= e.startDate! ? e.endDate : e.startDate!;
    if (daysBetween(e.startDate!, end) + 1 >= LONG_DAYS) {
      long.push(e);
      continue;
    }
    for (let d = e.startDate! < first ? first : e.startDate!; d <= end && d <= last; d = addDays(d, 1)) {
      days.set(d, [...(days.get(d) ?? []), e]);
    }
  }
  return { year, month, days, long, total: rows.length };
}

export function calendarSvg(d: CalendarData, today?: string): { svg: string; height: number } {
  const first = `${d.year}-${String(d.month).padStart(2, '0')}-01`;
  const daysInMonth = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // 월요일 시작
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const gridTop = HEAD + DOW_H;
  const longShown = d.long.slice(0, 8);
  const longH = longShown.length ? 64 + Math.ceil(longShown.length / 2) * 34 : 0;
  const height = gridTop + weeks * CELL_H + longH + 70;
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="Noto Sans KR">`);
  p.push(`<rect width="${W}" height="${height}" fill="#14171c"/>`);
  p.push(`<rect x="0" y="0" width="${W}" height="8" fill="#39c5bb"/>`);
  p.push(`<text x="${PAD}" y="88" font-size="54" font-weight="700" fill="#ffffff">${d.year}년 ${d.month}월 미쿠 행사</text>`);
  p.push(`<text x="${PAD}" y="126" font-size="22" fill="#9aa4b2">행사 ${d.total}건 · 한국 시간 기준</text>`);
  // 범례
  const legend: [string, string][] = [['국내', REGION_COLOR.KR!], ['일본', REGION_COLOR.JP!], ['해외', REGION_COLOR.OTHER!]];
  legend.forEach(([name, color], i) => {
    const x = W - PAD - (legend.length - i) * 96;
    p.push(`<circle cx="${x}" cy="80" r="8" fill="${color}"/><text x="${x + 16}" y="88" font-size="22" fill="#cfd6df">${name}</text>`);
  });
  DOW.forEach((name, i) => {
    const color = i === 5 ? '#6ea8fe' : i === 6 ? '#ff7b8a' : '#9aa4b2';
    p.push(`<text x="${PAD + i * CELL_W + CELL_W / 2}" y="${HEAD + 30}" font-size="22" font-weight="700" fill="${color}" text-anchor="middle">${name}</text>`);
  });
  for (let day = 1; day <= daysInMonth; day++) {
    const idx = offset + day - 1;
    const col = idx % 7;
    const x = PAD + col * CELL_W;
    const y = gridTop + Math.floor(idx / 7) * CELL_H;
    const ymd = `${d.year}-${String(d.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const list = d.days.get(ymd) ?? [];
    const isToday = ymd === today;
    p.push(`<rect x="${x + 3}" y="${y + 3}" width="${CELL_W - 6}" height="${CELL_H - 6}" rx="10" fill="${list.length ? '#222831' : '#1a1e25'}"${isToday ? ' stroke="#39c5bb" stroke-width="3"' : ''}/>`);
    const dayColor = col === 5 ? '#6ea8fe' : col === 6 ? '#ff7b8a' : '#e6ebf2';
    p.push(`<text x="${x + 16}" y="${y + 36}" font-size="24" font-weight="700" fill="${dayColor}">${day}</text>`);
    list.slice(0, 3).forEach((e, i) => {
      const ty = y + 68 + i * 26;
      p.push(`<circle cx="${x + 20}" cy="${ty - 7}" r="5" fill="${REGION_COLOR[e.region] ?? REGION_COLOR.OTHER}"/>`);
      p.push(`<text x="${x + 31}" y="${ty - 1}" font-size="16" fill="#e6ebf2">${xml(fitText(e.title, CELL_W - 40, 16))}</text>`);
    });
    if (list.length > 3) p.push(`<text x="${x + CELL_W - 16}" y="${y + 36}" font-size="18" fill="#9aa4b2" text-anchor="end">+${list.length - 3}</text>`);
  }
  if (longShown.length) {
    const top = gridTop + weeks * CELL_H + 44;
    p.push(`<text x="${PAD}" y="${top}" font-size="24" font-weight="700" fill="#ffffff">기간 행사</text>`);
    if (d.long.length > longShown.length) p.push(`<text x="${PAD + 120}" y="${top}" font-size="18" fill="#9aa4b2">외 ${d.long.length - longShown.length}건</text>`);
    const colW = (W - PAD * 2) / 2;
    longShown.forEach((e, i) => {
      const x = PAD + (i % 2) * colW;
      const y = top + 38 + Math.floor(i / 2) * 34;
      const period = `${e.startDate!.slice(5).replace('-', '.')}~${(e.endDate ?? e.startDate!).slice(5).replace('-', '.')}`;
      const label = `${period} · ${KIND_KO[e.kind] ?? e.kind}`;
      p.push(`<circle cx="${x + 8}" cy="${y - 7}" r="6" fill="${REGION_COLOR[e.region] ?? REGION_COLOR.OTHER}"/>`);
      p.push(`<text x="${x + 24}" y="${y}" font-size="20" fill="#e6ebf2">${xml(fitText(e.title, colW - 250, 20))}</text>`);
      p.push(`<text x="${x + colW - 16}" y="${y}" font-size="17" fill="#9aa4b2" text-anchor="end">${xml(label)}</text>`);
    });
  }
  p.push(`<text x="${W - PAD}" y="${height - 26}" font-size="17" fill="#6b7480" text-anchor="end">/행사 로 자세히 볼 수 있어요</text>`);
  p.push('</svg>');
  return { svg: p.join(''), height };
}

/** SVG를 PNG로. 글꼴 파일을 못 찾으면 예외 */
export async function renderCalendarPng(svg: string): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const { Resvg } = await import('@resvg/resvg-js');
  const fontFiles = ['400Regular/NotoSansKR_400Regular.ttf', '700Bold/NotoSansKR_700Bold.ttf'].map((f) => require.resolve(`@expo-google-fonts/noto-sans-kr/${f}`));
  const resvg = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Noto Sans KR' }, fitTo: { mode: 'original' } });
  return Buffer.from(resvg.render().asPng());
}

/** 이번 달(한국 날짜) 달력. 행사가 없으면 null */
export async function monthlyCalendar(db: Db, now: Date): Promise<{ png: Buffer; fileName: string; title: string; total: number } | null> {
  const today = kstDate(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const data = await calendarData(db, y, m);
  if (data.total === 0) return null;
  const { svg } = calendarSvg(data, today);
  return { png: await renderCalendarPng(svg), fileName: `miku-${y}-${String(m).padStart(2, '0')}.png`, title: `${y}년 ${m}월 미쿠 행사 달력`, total: data.total };
}
