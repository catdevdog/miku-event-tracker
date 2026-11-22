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
