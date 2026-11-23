import { sql } from 'drizzle-orm';
import { ContainerBuilder, SeparatorSpacingSize } from 'discord.js';
import type { Db } from '../db/client.js';
import { SETTING, getSetting, isNotifyPaused, setSetting } from '../services/settings.js';
import { kstDate } from '../pipeline/state.js';
import { discordErrorCode, type DiscordBot } from './discord.js';
import { discordTime } from './format.js';
import { CARD_COLOR, DOT } from './labels.js';
import { panelButtonRows } from './adminPanel.js';
import type { OutgoingMessage } from './types.js';

/**
 * 관리자 채널에 고정해 두고 10분마다 고치는 상태판: 수집처·판정 대기·행사 수·알림 큐·Claude 비용.
 * /점검을 매번 치지 않아도 되게 하기 위해서다.
 */
export interface StatusBoardData {
  sources: { ok: number; failing: number; alert: number; paused: number; total: number; alertNames: string[] };
  lastRunAt: string | null;
  pendingItems: number;
  errorItems: number;
  events: { kr: number; jp: number; other: number; review: number };
  queue: { queued: number; failed: number };
  notifyPaused: boolean;
  cost: { todayUsd: number; todayCalls: number; monthUsd: number };
  now: string;
}

const num = (v: unknown) => Number(v ?? 0);

export async function statusBoardData(db: Db, now: Date, envPaused?: boolean): Promise<StatusBoardData> {
  const [s] = await db.all<Record<string, unknown>>(sql`
    SELECT
      sum(CASE WHEN consecutive_failures = 0 THEN 1 ELSE 0 END) AS ok,
      sum(CASE WHEN consecutive_failures BETWEEN 1 AND 2 THEN 1 ELSE 0 END) AS failing,
      sum(CASE WHEN consecutive_failures >= 3 THEN 1 ELSE 0 END) AS alert,
      count(*) AS total,
      max(last_run_at) AS last_run
    FROM sources WHERE enabled = 1 AND paused = 0 AND target <> 'TODO' AND adapter <> 'manual'
  `);
  const [p] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM sources WHERE paused = 1 AND adapter <> 'manual'`);
  const alertNames = (await db.all<{ name: string }>(sql`SELECT name FROM sources WHERE enabled = 1 AND paused = 0 AND consecutive_failures >= 3 AND adapter <> 'manual' LIMIT 5`)).map((r) => r.name);
  const [items] = await db.all<Record<string, unknown>>(sql`
    SELECT sum(CASE WHEN llm_status = 'pending' THEN 1 ELSE 0 END) AS pending, sum(CASE WHEN llm_status = 'error' THEN 1 ELSE 0 END) AS error FROM raw_items
  `);
  const [ev] = await db.all<Record<string, unknown>>(sql`
    SELECT
      sum(CASE WHEN needs_review = 0 AND status NOT IN ('ended','cancelled') AND region = 'KR' THEN 1 ELSE 0 END) AS kr,
      sum(CASE WHEN needs_review = 0 AND status NOT IN ('ended','cancelled') AND region = 'JP' THEN 1 ELSE 0 END) AS jp,
      sum(CASE WHEN needs_review = 0 AND status NOT IN ('ended','cancelled') AND region = 'OTHER' THEN 1 ELSE 0 END) AS other,
      sum(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS review
    FROM events
  `);
  const [q] = await db.all<Record<string, unknown>>(sql`
    SELECT sum(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, sum(CASE WHEN status = 'failed' AND attempts >= 3 THEN 1 ELSE 0 END) AS failed FROM notifications
  `);
  // 비용: 한국 날짜 기준 오늘(00:00 KST = 전날 15:00 UTC)과 이번 달
  const today = kstDate(now);
  const dayStart = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const monthStart = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00+09:00`)).toISOString();
  const [c] = await db.all<Record<string, unknown>>(sql`
    SELECT
      sum(CASE WHEN created_at >= ${dayStart} THEN cost_usd ELSE 0 END) AS today_usd,
      sum(CASE WHEN created_at >= ${dayStart} THEN 1 ELSE 0 END) AS today_calls,
      sum(cost_usd) AS month_usd
    FROM llm_calls WHERE created_at >= ${monthStart}
  `);
  return {
    sources: { ok: num(s?.ok), failing: num(s?.failing), alert: num(s?.alert), paused: num(p?.n), total: num(s?.total), alertNames },
    lastRunAt: (s?.last_run as string | null) ?? null,
    pendingItems: num(items?.pending),
    errorItems: num(items?.error),
    events: { kr: num(ev?.kr), jp: num(ev?.jp), other: num(ev?.other), review: num(ev?.review) },
    queue: { queued: num(q?.queued), failed: num(q?.failed) },
    notifyPaused: await isNotifyPaused(db, envPaused),
    cost: { todayUsd: num(c?.today_usd), todayCalls: num(c?.today_calls), monthUsd: num(c?.month_usd) },
    now: now.toISOString(),
  };
}

const usd = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;

export function statusBoardMessage(d: StatusBoardData): OutgoingMessage {
  const healthy = d.sources.alert === 0 && d.errorItems === 0 && d.queue.failed === 0 && !d.notifyPaused;
  const lines = [
    `## 📊 상태판 · 관리 패널`,
    `-# 10분마다 갱신 · 마지막 ${discordTime(d.now, 'R')}`,
  ];
  const body = [
    `**📡 수집** ${DOT.ok} 정상 ${d.sources.ok} · ${DOT.fail} 실패 ${d.sources.failing} · ${DOT.alert} 경보 ${d.sources.alert}${d.sources.paused ? ` · ⏸️ 멈춤 ${d.sources.paused}` : ''} (${d.sources.total}곳)`,
    ...(d.sources.alertNames.length ? [`-# 경보: ${d.sources.alertNames.join(', ')}`] : []),
    `-# 마지막 수집 ${d.lastRunAt ? discordTime(d.lastRunAt, 'R') : '기록 없음'}`,
    `**🧠 판정** 대기 ${d.pendingItems}건 · 오류 ${d.errorItems}건`,
    `**🎤 다가오는 행사** 🇰🇷 ${d.events.kr} · 🇯🇵 ${d.events.jp} · 🌏 ${d.events.other} · 검수 대기 ${d.events.review}`,
    `**📨 알림** ${d.notifyPaused ? '⏸️ **일시정지 중** · ' : ''}보낼 것 ${d.queue.queued}건 · 실패 ${d.queue.failed}건`,
    `**💸 Claude 비용** 오늘 ${usd(d.cost.todayUsd)} (${d.cost.todayCalls}회) · 이번 달 ${usd(d.cost.monthUsd)}`,
  ];
  const c = new ContainerBuilder()
    .setAccentColor(healthy ? CARD_COLOR.ok : CARD_COLOR.alert)
    .addTextDisplayComponents((t) => t.setContent(lines.join('\n')))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(body.join('\n')))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  // 관리 패널 버튼 (관리자만 동작). 누르면 누른 사람에게만 보이는 화면이 열린다
  for (const row of panelButtonRows(d.notifyPaused)) c.addActionRowComponents((r) => r.setComponents(row));
  c.addTextDisplayComponents((t) => t.setContent('-# 버튼은 서버 관리 권한이 있는 사람만 쓸 수 있어요 · `/관리` 명령으로도 같은 일을 할 수 있어요'));
  return { card: [c.toJSON()], content: [...lines, ...body, '(버튼은 카드 형식에서만 보여요. `/관리` 명령을 쓰세요)'].join('\n') };
}

/** 상태판 메시지를 고친다. 없거나 지워졌으면 새로 올려 고정한다 */
export async function syncStatusBoard(
  db: Db,
  bot: Pick<DiscordBot, 'post' | 'editMessage' | 'pinMessage'>,
  adminChannelId: string,
  now: Date,
  envPaused?: boolean,
): Promise<'edited' | 'posted'> {
  const msg = statusBoardMessage(await statusBoardData(db, now, envPaused));
  const id = await getSetting(db, SETTING.statusMessage);
  if (id) {
    try {
      await bot.editMessage(adminChannelId, id, msg);
      return 'edited';
    } catch (err) {
      const code = discordErrorCode(err);
      if (code !== 10008 && code !== 10003) throw err;
    }
  }
  const newId = await bot.post(adminChannelId, msg);
  await setSetting(db, SETTING.statusMessage, newId, now);
  await bot.pinMessage(adminChannelId, newId).catch(() => undefined);
  return 'posted';
}
