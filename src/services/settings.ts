import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { discordSettings } from '../db/schema.js';

/** discord_settings 키 */
export const SETTING = {
  /** 지역 알림 역할 ID: role_KR, role_JP, role_OTHER */
  role: (region: string) => `role_${region}`,
  panelMessage: 'panel_message_id',
  statusMessage: 'status_message_id',
  /** '1'이면 알림을 큐에만 쌓고 보내지 않는다 (/관리 알림) */
  notifyPaused: 'notify_paused',
} as const;

export async function getSetting(db: Db, key: string): Promise<string | undefined> {
  const [row] = await db.select({ value: discordSettings.value }).from(discordSettings).where(eq(discordSettings.key, key));
  return row?.value;
}

export async function setSetting(db: Db, key: string, value: string, now = new Date()): Promise<void> {
  const updatedAt = now.toISOString();
  await db.insert(discordSettings).values({ key, value, updatedAt }).onConflictDoUpdate({ target: discordSettings.key, set: { value, updatedAt } });
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(discordSettings).where(eq(discordSettings.key, key));
}

/** 알림 일시정지: 환경 변수 NOTIFY_PAUSED 또는 /관리 알림 일시정지 */
export async function isNotifyPaused(db: Db, envPaused?: boolean): Promise<boolean> {
  return !!envPaused || (await getSetting(db, SETTING.notifyPaused)) === '1';
}

/** 기존 행사 중복 검사를 한 번 끝냈는지 ('done') */
export const SETTING_DUP_SWEEP = 'dup_sweep_v1';
