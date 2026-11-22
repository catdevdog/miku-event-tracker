import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventDiscord, events } from '../db/schema.js';
import type { EventRow } from '../pipeline/merge.js';
import { sha256 } from '../adapters/http.js';
import { eventLinks } from '../services/events.js';
import { formatKstShort, formatPeriodKo } from './format.js';
import { KIND_KO, OFFICIALITY_KO, REGION_IMAGES } from './labels.js';
import type { GuildEventSpec } from './discord.js';

/**
 * 국내 행사를 디스코드 서버의 '이벤트'(외부 장소 예약 이벤트)로 등록한다.
 * "관심 있음"을 누른 사람에게 디스코드가 시작 알림을 보낸다.
 * - 대상: 국내(KR), 확정(needs_review=0), 발표·예매 예정·판매 중, 시작일이 있고 시작 시각이 아직 안 지난 행사
 * - 시각: 행사는 날짜만 있으므로 시작일 10:00 ~ 종료일 21:00 (KST)로 넣고 설명에 적는다
 * - 행사가 취소되면 서버 이벤트를 지운다. 진행 중·종료는 그대로 둔다(디스코드가 종료 시각에 정리)
 */

export const START_HOUR_KST = 10;
export const END_HOUR_KST = 21;
/** 한 번에 새로 만드는 수 (처음 켤 때 몰리지 않게, 디스코드 요청 한도) */
export const CREATE_BATCH = 5;

const kstAt = (ymd: string, hour: number) => new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+09:00`).toISOString();

export function guildEventSpec(e: EventRow, link: string | undefined, now: Date): GuildEventSpec | null {
  if (e.region !== 'KR' || e.needsReview !== 0 || !e.startDate) return null;
  if (!['announced', 'ticket_scheduled', 'on_sale'].includes(e.status)) return null;
  const startIso = kstAt(e.startDate, START_HOUR_KST);
  // 디스코드는 지난 시각으로 만들 수 없다 (여유 5분)
  if (Date.parse(startIso) <= now.getTime() + 5 * 60_000) return null;
  const endIso = kstAt(e.endDate && e.endDate >= e.startDate ? e.endDate : e.startDate, END_HOUR_KST);
  const description = [
    (e.summaryKo ?? '').trim(),
    `📅 ${formatPeriodKo(e.startDate, e.endDate)}`,
    `🏷️ ${KIND_KO[e.kind] ?? e.kind} · ${OFFICIALITY_KO[e.officiality] ?? e.officiality}`,
    e.ticketOpenAt ? `🎫 티켓 오픈 ${formatKstShort(e.ticketOpenAt)} KST` : '',
    link ? `🔗 ${link}` : '',
    `※ 시각은 표시용(${START_HOUR_KST}~${END_HOUR_KST}시)이에요. 정확한 시간은 공지를 확인하세요.`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: e.title,
    description,
    location: [e.venue, e.city].filter(Boolean).join(', ') || '장소 미정',
    startIso,
    endIso,
    imageUrl: REGION_IMAGES.KR,
  };
}

/** 내용이 바뀌었는지 비교할 해시 (이미지는 빼고) */
export const specHash = (s: GuildEventSpec) => sha256([s.name, s.description, s.location, s.startIso, s.endIso].join('\n')).slice(0, 16);

export interface GuildEventApi {
  canManageEvents(): Promise<boolean>;
  createGuildEvent(spec: GuildEventSpec): Promise<string>;
  editGuildEvent(id: string, spec: GuildEventSpec): Promise<void>;
  deleteGuildEvent(id: string): Promise<void>;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  /** 권한이 없어 건너뛰었으면 true */
  noPermission: boolean;
  errors: string[];
}

/** 디스코드 API 오류 코드 10070: 알 수 없는 예약 이벤트 (누군가 서버에서 지움) */
const isUnknownEvent = (err: unknown) => (err as { code?: unknown } | null)?.code === 10070;

export async function syncGuildEvents(db: Db, api: GuildEventApi, now = new Date()): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, noPermission: false, errors: [] };
  if (!(await api.canManageEvents())) return { ...result, noPermission: true };

  const rows = await db
    .select({ e: events, d: eventDiscord })
    .from(events)
    .leftJoin(eventDiscord, eq(eventDiscord.eventId, events.id))
    .where(and(eq(events.region, 'KR'), inArray(events.needsReview, [0, 2])));
  const links = await eventLinks(db, rows.map((r) => r.e));
  const nowIso = now.toISOString();
  const save = (eventId: number, guildEventId: string | null, hash: string | null) =>
    db
      .insert(eventDiscord)
      .values({ eventId, guildEventId, guildEventHash: hash, updatedAt: nowIso })
      .onConflictDoUpdate({ target: eventDiscord.eventId, set: { guildEventId, guildEventHash: hash, updatedAt: nowIso } });

  for (const { e, d } of rows) {
    const existingId = d?.guildEventId ?? null;
    const spec = guildEventSpec(e, links.get(e.id), now);
    try {
      if (spec && !existingId) {
        if (result.created >= CREATE_BATCH) continue; // 나머지는 다음 실행에
        const id = await api.createGuildEvent(spec);
        await save(e.id, id, specHash(spec));
        result.created++;
      } else if (spec && existingId && d?.guildEventHash !== specHash(spec)) {
        await api.editGuildEvent(existingId, spec);
        await save(e.id, existingId, specHash(spec));
        result.updated++;
      } else if (existingId && (e.status === 'cancelled' || e.needsReview === 2)) {
        await api.deleteGuildEvent(existingId).catch((err: unknown) => {
          if (!isUnknownEvent(err)) throw err;
        });
        await save(e.id, null, null);
        result.deleted++;
      }
    } catch (err) {
      if (isUnknownEvent(err) && existingId) {
        await save(e.id, null, null); // 서버에서 지운 이벤트: 다음 실행에 다시 만든다
        continue;
      }
      result.errors.push(`${e.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
