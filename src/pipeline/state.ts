import type { EVENT_STATUSES } from '../db/schema.js';

export type EventStatus = (typeof EVENT_STATUSES)[number];

// CLAUDE.md 규칙 6. 순서가 뒤로 가지 않는다(늦게 처리된 옛 기사로 on_sale → ticket_scheduled가 되지 않게). cancelled는 어디서든.
export const STATUS_ORDER: Record<EventStatus, number> = {
  announced: 0,
  ticket_scheduled: 1,
  on_sale: 2,
  ongoing: 3,
  ended: 4,
  cancelled: 5,
};

export interface StatusInputs {
  startDate: string | null;
  endDate: string | null;
  ticketOpenAt: string | null;
  isCancelled?: boolean;
  /** 원문에 판매 중이라고 명시됨 */
  saleStarted?: boolean | null;
  /** KOPIS 원문이면 판매 시작을 추정하지 않는다 (규칙 15) */
  fromKopis?: boolean;
}

/** 한국 날짜 YYYY-MM-DD */
export const kstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/** 필드와 현재 시각으로 상태를 계산한다. */
export function deriveStatus(i: StatusInputs, now: Date): EventStatus {
  if (i.isCancelled) return 'cancelled';
  const today = kstDate(now);
  const end = i.endDate ?? i.startDate;
  if (end && today > end) return 'ended';
  if (i.startDate && today >= i.startDate) return 'ongoing';
  if (i.ticketOpenAt) return now.getTime() >= Date.parse(i.ticketOpenAt) ? 'on_sale' : 'ticket_scheduled';
  if (i.saleStarted === true && !i.fromKopis) return 'on_sale';
  return 'announced';
}

/** 현재 상태에서 계산된 상태로 넘어갈지. 앞으로만 간다. */
export function nextStatus(current: EventStatus, derived: EventStatus): EventStatus {
  if (current === 'cancelled') return 'cancelled';
  if (derived === 'cancelled') return 'cancelled';
  return STATUS_ORDER[derived] > STATUS_ORDER[current] ? derived : current;
}
