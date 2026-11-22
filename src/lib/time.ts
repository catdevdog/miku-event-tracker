/** DB에 넣는 시각은 모두 UTC ISO 문자열(YYYY-MM-DDTHH:mm:ss.sssZ)이다. 길이가 같아 문자열 비교로 순서를 비교할 수 있다. */
export const toIso = (d: Date): string => d.toISOString();

export const addMinutes = (d: Date, min: number): Date => new Date(d.getTime() + min * 60_000);

export const minutesBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 60_000;
