import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { ContainerBuilder } from 'discord.js';
import type { Db } from '../db/client.js';
import { eventSources, events, misses, rawItems, reports, sources } from '../db/schema.js';
import type { DiscordBot } from './discord.js';
import { esc } from './cards.js';
import { CARD_COLOR } from './labels.js';
import type { OutgoingMessage } from './types.js';

/**
 * 사용자 제보: 디스코드 메시지 우클릭 → 앱 → 행사 제보, 또는 /제보.
 * 제보 내용은 '사용자 제보' 소스(adapter manual, 스케줄러에 안 올림)의 raw_items로 넣어
 * 키워드 판정을 건너뛰고 Claude 판정 → 병합 → 알림의 일반 경로로 처리한다.
 * 결과(새 행사·기존 행사 연결·관련 없음)는 관리자 채널 제보 카드에 적고 misses에도 남긴다.
 */
export const MANUAL_SOURCE_NAME = '사용자 제보';
/** 같은 사람은 1분에 한 건, 전체 하루 30건 (Claude 호출 비용 상한) */
export const REPORT_COOLDOWN_MS = 60_000;
export const REPORT_DAILY_LIMIT = 30;

export async function ensureManualSource(db: Db): Promise<number> {
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.name, MANUAL_SOURCE_NAME));
  if (s) return s.id;
  const [created] = await db
    .insert(sources)
    .values({ name: MANUAL_SOURCE_NAME, layer: 'L4', adapter: 'manual', target: 'discord', region: 'GLOBAL', intervalMin: 1440, enabled: 0 })
    .onConflictDoNothing()
    .returning({ id: sources.id });
  if (created) return created.id;
  const [again] = await db.select({ id: sources.id }).from(sources).where(eq(sources.name, MANUAL_SOURCE_NAME));
  return again!.id;
}

/** 글에서 첫 http(s) 링크 */
export function firstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>()]+/.exec(text)?.[0]?.replace(/[.,!?)\]]+$/, '');
}

export interface ReportInput {
  reporterId: string;
  /** 제보 링크 (/제보 링크, 또는 메시지 본문의 첫 링크) */
  url?: string;
  /** 메모·메시지 본문 */
  note?: string;
  /** 우클릭 제보한 디스코드 메시지 주소 (링크가 없을 때 출처로) */
  messageUrl?: string;
}

export type ReportOutcome = { ok: true; reportId: number } | { ok: false; reason: string };

export async function createReport(db: Db, input: ReportInput, now = new Date()): Promise<ReportOutcome> {
  const url = input.url?.trim() || undefined;
  const note = (input.note ?? '').trim().slice(0, 1500);
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    } catch {
      return { ok: false, reason: '링크는 http(s) 주소로 넣어 주세요.' };
    }
  }
  if (!url && note.length < 10) return { ok: false, reason: '링크가 있거나 10자 이상 설명이 있는 메시지만 제보할 수 있어요.' };

  const [last] = await db
    .select({ at: reports.createdAt })
    .from(reports)
    .where(eq(reports.reporterId, input.reporterId))
    .orderBy(desc(reports.id))
    .limit(1);
  if (last && now.getTime() - Date.parse(last.at) < REPORT_COOLDOWN_MS) return { ok: false, reason: '제보는 1분에 한 번 할 수 있어요. 잠시 뒤에 다시 해 주세요.' };
  const day = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const recent = await db.select({ id: reports.id }).from(reports).where(gte(reports.createdAt, day));
  if (recent.length >= REPORT_DAILY_LIMIT) return { ok: false, reason: '오늘 제보가 많아 잠시 받지 않아요. 내일 다시 해 주세요.' };

  const sourceId = await ensureManualSource(db);
  const externalId = url ?? `msg:${input.messageUrl ?? createHash('sha1').update(note).digest('hex')}`;
  const [dup] = await db
    .select({ id: rawItems.id })
    .from(rawItems)
    .where(and(eq(rawItems.sourceId, sourceId), eq(rawItems.externalId, externalId)));
  if (dup) {
    const [prev] = await db.select({ result: reports.result }).from(reports).where(eq(reports.rawItemId, dup.id)).limit(1);
    return { ok: false, reason: `이미 제보된 내용이에요.${prev?.result ? ` (판정: ${prev.result})` : ' 판정을 기다리는 중이에요.'}` };
  }
  const nowIso = now.toISOString();
  const body = [note, input.messageUrl && !url ? `(디스코드 메시지: ${input.messageUrl})` : ''].filter(Boolean).join('\n');
  const [item] = await db
    .insert(rawItems)
    .values({
      sourceId,
      externalId,
      url: url ?? input.messageUrl ?? null,
      title: null,
      body,
      publishedAt: nowIso,
      fetchedAt: nowIso,
      contentHash: createHash('sha1').update(`${externalId}\n${body}`).digest('hex'),
      llmStatus: 'pending',
    })
    .returning({ id: rawItems.id });
  const [report] = await db
    .insert(reports)
    .values({ rawItemId: item!.id, url: url ?? input.messageUrl ?? null, note: note || null, reporterId: input.reporterId, createdAt: nowIso })
    .returning({ id: reports.id });
  return { ok: true, reportId: report!.id };
}

type ReportRow = typeof reports.$inferSelect;

/** 관리자 채널 제보 카드 */
export function reportMessage(r: ReportRow, result?: string): OutgoingMessage {
  const lines = [
    `### 📮 제보 #${r.id}`,
    `제보한 사람 <@${r.reporterId}>`,
    ...(r.url ? [`🔗 ${r.url}`] : []),
    ...(r.note ? [`> ${esc(r.note).slice(0, 500).replace(/\n/g, '\n> ')}`] : []),
    result ? `**판정** ${result}` : '⏳ Claude 판정 대기 (1~2분)',
  ];
  const color = !result ? CARD_COLOR.wait : result.startsWith('🆕') || result.startsWith('🔗') ? CARD_COLOR.ok : CARD_COLOR.off;
  return {
    card: [new ContainerBuilder().setAccentColor(color).addTextDisplayComponents((t) => t.setContent(lines.join('\n').slice(0, 1900))).toJSON()],
    content: lines.join('\n').slice(0, 1900),
  };
}

/** 제보 카드를 관리자 채널에 올린다 (실패해도 제보는 유지, 판정 후 다시 시도) */
export async function postReportCard(db: Db, bot: Pick<DiscordBot, 'post'>, adminChannelId: string, reportId: number): Promise<void> {
  const [r] = await db.select().from(reports).where(eq(reports.id, reportId));
  if (!r) return;
  const id = await bot.post(adminChannelId, reportMessage(r));
  await db.update(reports).set({ adminMessageId: id }).where(eq(reports.id, reportId));
}

/** 판정이 끝난 제보의 결과를 적는다 (1분마다). 행사에 연결되면 misses에 사람·시스템 중 누가 먼저 봤는지 남긴다 */
export async function resolveReports(
  db: Db,
  bot: Pick<DiscordBot, 'post' | 'editMessage'> | undefined,
  adminChannelId: string | undefined,
  now = new Date(),
): Promise<number> {
  const open = await db.select({ r: reports, status: rawItems.llmStatus }).from(reports).leftJoin(rawItems, eq(rawItems.id, reports.rawItemId)).where(isNull(reports.resolvedAt)).limit(20);
  let resolved = 0;
  for (const { r, status } of open) {
    if (status === 'pending') continue;
    let result: string;
    if (!status) result = '⚠️ 원문이 지워져 판정하지 못했어요';
    else if (status === 'error') result = '⚠️ 판정 중 오류 (관리자 경보 확인)';
    else if (status === 'skipped') result = '⚪ 링크 본문을 가져오지 못해 판정하지 않았어요';
    else {
      const [linked] = await db
        .select({ id: events.id, title: events.title, createdAt: events.createdAt, needsReview: events.needsReview })
        .from(eventSources)
        .innerJoin(events, eq(events.id, eventSources.eventId))
        .where(eq(eventSources.rawItemId, r.rawItemId!))
        .limit(1);
      if (!linked) result = '⚪ 미쿠 행사와 관련 없다고 판정했어요';
      else {
        const caught = Date.parse(linked.createdAt) < Date.parse(r.createdAt);
        result = `${caught ? '🔗 이미 수집한 행사에 연결' : '🆕 새 행사로 등록'}: #${linked.id} ${linked.title}${linked.needsReview === 1 ? ' (검수 대기)' : ''}`;
        await db.insert(misses).values({
          eventId: linked.id,
          noticedAt: r.createdAt,
          firstSeenSource: r.url,
          caughtBySystem: caught ? 1 : 0,
          note: `디스코드 제보 #${r.id}`,
        });
      }
    }
    await db.update(reports).set({ result, resolvedAt: now.toISOString() }).where(eq(reports.id, r.id));
    resolved++;
    if (bot && adminChannelId) {
      const msg = reportMessage(r, result);
      try {
        if (r.adminMessageId) await bot.editMessage(adminChannelId, r.adminMessageId, msg);
        else await bot.post(adminChannelId, msg);
      } catch {
        /* 카드 갱신 실패는 결과 기록에 영향 없음 */
      }
    }
  }
  return resolved;
}
