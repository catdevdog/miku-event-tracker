export const DISCORD_CONTENT_LIMIT = 2000;

/** 디스코드 메시지 본문 길이 제한(2000자)에 맞춘다. */
export function truncate(text: string, limit = DISCORD_CONTENT_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** DB의 UTC ISO 문자열을 디스코드 표시용 한국 시각으로 바꾼다. (CLAUDE.md 규칙 8) */
export function formatKst(iso: string | null | undefined): string {
  if (!iso) return '-';
  return `${KST.format(new Date(iso))} KST`;
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** "2027-03-06" → "2027.03.06(토)" */
export function formatDateKo(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return `${ymd.replace(/-/g, '.')}(${WEEKDAY_KO[d.getUTCDay()]})`;
}

/** 기간 표시. 같은 해면 끝 날짜의 연도를 뺀다. */
export function formatPeriodKo(start: string | null, end: string | null): string {
  if (!start) return '미정';
  if (!end || end === start) return formatDateKo(start);
  const e = end.slice(0, 4) === start.slice(0, 4) ? formatDateKo(end).slice(5) : formatDateKo(end);
  return `${formatDateKo(start)} ~ ${e}`;
}

/** "2026.12.01(화) 20:00" (한국 시각) */
export function formatKstShort(iso: string): string {
  const k = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${formatDateKo(k.slice(0, 10))} ${k.slice(11, 16)}`;
}

/** 디스코드 타임스탬프. 보는 사람의 시간대로 표시되고 R은 "2일 후"처럼 상대 시간 */
export function discordTime(iso: string, style: 'f' | 'F' | 'R' | 'd' | 't' = 'f'): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/** 고정폭 글꼴에서의 표시 폭 (한글·한자·가나·전각은 2칸) */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

/** 표시 폭 기준으로 자른다 */
export function clipWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export const padWidth = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

/**
 * 디스코드 코드 블록용 표. 마지막 열은 폭을 맞추지 않는다(가변 길이 텍스트를 마지막에 두면 정렬이 깨지지 않는다).
 * 앞쪽 열에는 폭이 일정한 값(숫자·영문 코드·글자 수가 같은 한글)만 둔다.
 */
export function textTable(header: string[], rows: string[][], lastColMax = 44): string {
  const cols = header.length;
  const widths = header.map((h, i) => (i === cols - 1 ? 0 : Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? '')))));
  const line = (r: string[]) =>
    r.map((c, i) => (i === cols - 1 ? clipWidth(c, lastColMax) : padWidth(c, widths[i]!))).join('  ').trimEnd();
  return ['```', line(header), ...rows.map(line), '```'].join('\n');
}
