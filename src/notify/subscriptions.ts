import { ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorSpacingSize } from 'discord.js';
import type { Db } from '../db/client.js';
import { discordMembers } from '../db/schema.js';
import { SETTING, getSetting, setSetting } from '../services/settings.js';
import { discordErrorCode, type DiscordBot, type InteractionCtx, type Reply } from './discord.js';
import { REGION_META } from './labels.js';
import type { OutgoingMessage } from './types.js';

/**
 * 알림 역할 구독.
 * - 지역별 역할(국내·일본·해외)을 만들고, 공지할 때 행사 지역의 역할을 멘션한다.
 * - 국내 역할은 서버 멤버 전원에게 한 번 준다(기본 구독). 스스로 해제한 사람에게는 다시 주지 않는다(discord_members).
 * - 공지 채널에 고정한 구독 패널 버튼으로 각자 켜고 끈다.
 */
export const SUB_REGIONS = ['KR', 'JP', 'OTHER'] as const;
export type SubRegion = (typeof SUB_REGIONS)[number];
/** 처음 들어온 멤버에게 주는 역할 */
export const DEFAULT_REGIONS: SubRegion[] = ['KR'];

export const ROLE_NAME: Record<SubRegion, string> = { KR: '국내 행사 알림', JP: '일본 행사 알림', OTHER: '해외 행사 알림' };

export const subButtonId = (region: SubRegion) => `sub:${region}`;
export function parseSubId(id: string): SubRegion | null {
  const m = /^sub:(KR|JP|OTHER)$/.exec(id);
  return m ? (m[1] as SubRegion) : null;
}

/** 저장된 지역 역할 ID */
export async function roleIds(db: Db): Promise<Partial<Record<SubRegion, string>>> {
  const out: Partial<Record<SubRegion, string>> = {};
  for (const r of SUB_REGIONS) {
    const id = await getSetting(db, SETTING.role(r));
    if (id) out[r] = id;
  }
  return out;
}

/** 행사 지역에 맞는 멘션 역할 (events.region: KR·JP·OTHER) */
export async function mentionRoleFor(db: Db, region: string): Promise<string | undefined> {
  return getSetting(db, SETTING.role(region));
}

/** 공지 채널에 고정하는 구독 패널 */
export function panelMessage(): OutgoingMessage {
  const lines = [
    '**국내 행사는 기본으로 모두 받아요.** 일본·해외 행사도 알림을 받고 싶으면 버튼을 눌러 켜세요.',
    '버튼을 다시 누르면 꺼져요. 누른 사람에게만 결과가 보여요.',
  ];
  const tips = [
    '🔔 공지 카드의 **알림 받기**: 그 행사만 티켓 오픈 24시간·1시간 전, 판매 시작·취소를 DM으로',
    '📮 놓친 행사는 메시지 우클릭 → 앱 → **행사 제보** 또는 `/제보`',
    '🔎 `/행사 검색:`으로 행사 찾기 · `/가이드`로 전체 사용법',
  ];
  const c = new ContainerBuilder()
    .setAccentColor(REGION_META.KR!.color)
    .addTextDisplayComponents((t) => t.setContent(`## 🔔 알림 설정\n${lines.join('\n')}`))
    .addActionRowComponents((r) =>
      r.setComponents(
        SUB_REGIONS.map((region) =>
          new ButtonBuilder()
            .setCustomId(subButtonId(region))
            .setLabel(`${REGION_META[region]!.flag} ${REGION_META[region]!.label} 알림`)
            .setStyle(region === 'KR' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        ),
      ),
    )
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent(tips.join('\n')));
  return {
    card: [c.toJSON()],
    embeds: [{ title: '🔔 알림 설정', description: `${lines.join('\n')}\n\n${tips.join('\n')}\n\n(버튼은 카드 형식에서만 보여요)`, color: REGION_META.KR!.color }],
  };
}

export interface SetupResult {
  roles: Partial<Record<SubRegion, string>>;
  panelPosted: boolean;
  errors: string[];
}

/** 역할을 만들고(없으면) 구독 패널을 공지 채널에 둔다(지워졌으면 다시 올려 고정). 10분마다 돌려도 결과가 같다. */
export async function ensureSubscriptionSetup(
  db: Db,
  bot: Pick<DiscordBot, 'ensureRole' | 'post' | 'editMessage' | 'pinMessage'>,
  noticeChannelId: string,
  now = new Date(),
): Promise<SetupResult> {
  const result: SetupResult = { roles: {}, panelPosted: false, errors: [] };
  for (const region of SUB_REGIONS) {
    const stored = await getSetting(db, SETTING.role(region));
    try {
      const id = await bot.ensureRole({ id: stored, name: ROLE_NAME[region], color: REGION_META[region]!.color });
      if (id !== stored) await setSetting(db, SETTING.role(region), id, now);
      result.roles[region] = id;
    } catch (err) {
      result.errors.push(`역할 "${ROLE_NAME[region]}" 준비 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const panelId = await getSetting(db, SETTING.panelMessage);
  if (panelId) {
    try {
      await bot.editMessage(noticeChannelId, panelId, panelMessage());
      return result;
    } catch (err) {
      const code = discordErrorCode(err);
      if (code !== 10008 && code !== 10003) {
        result.errors.push(`구독 패널 갱신 실패: ${err instanceof Error ? err.message : String(err)}`);
        return result;
      }
      // 지워졌거나 채널이 바뀌었으면 새로 올린다
    }
  }
  const id = await bot.post(noticeChannelId, panelMessage());
  await setSetting(db, SETTING.panelMessage, id, now);
  result.panelPosted = true;
  await bot.pinMessage(noticeChannelId, id).catch((err: unknown) => {
    result.errors.push(`구독 패널 고정 실패(메시지 고정 권한 필요): ${err instanceof Error ? err.message : String(err)}`);
  });
  return result;
}

/**
 * 기본 구독: 아직 기본 역할을 받은 적 없는 멤버에게 국내 알림 역할을 준다. 봇 계정은 뺀다.
 * 한 번에 cap명까지 주고 나머지는 다음 실행(10분 뒤)에 이어서 한다.
 * 멤버 목록 읽기는 Developer Portal의 Server Members Intent가 켜져 있어야 한다.
 */
export async function syncDefaultMembers(
  db: Db,
  bot: Pick<DiscordBot, 'listMembers' | 'addMemberRole'>,
  now = new Date(),
  cap = 200,
): Promise<{ added: number; initialized: number }> {
  const ids = await roleIds(db);
  const defaults = DEFAULT_REGIONS.map((r) => ids[r]).filter((x): x is string => !!x);
  if (defaults.length === 0) return { added: 0, initialized: 0 };
  const done = new Set((await db.select({ id: discordMembers.userId }).from(discordMembers)).map((r) => r.id));
  let added = 0;
  let initialized = 0;
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const members = await bot.listMembers(after);
    for (const m of members) {
      if (m.bot || done.has(m.id)) continue;
      const missing = defaults.filter((r) => !m.roles.includes(r));
      if (added + missing.length > cap) return { added, initialized };
      for (const roleId of missing) {
        await bot.addMemberRole(m.id, roleId);
        added++;
      }
      await db.insert(discordMembers).values({ userId: m.id, initializedAt: now.toISOString() }).onConflictDoNothing();
      done.add(m.id);
      initialized++;
    }
    if (members.length < 1000) break;
    after = members[members.length - 1]!.id;
  }
  return { added, initialized };
}

/** 현재 구독 상태 한 줄: 🇰🇷 국내 ✅ · 🇯🇵 일본 ⬜ · 🌏 해외 ⬜ */
export function subscriptionLine(ids: Partial<Record<SubRegion, string>>, memberRoleIds: string[]): string {
  return SUB_REGIONS.map((r) => `${REGION_META[r]!.flag} ${REGION_META[r]!.label} ${ids[r] && memberRoleIds.includes(ids[r]) ? '✅' : '⬜'}`).join(' · ');
}

/** 구독 패널 버튼: 역할을 켜거나 끈다. 결과는 누른 사람에게만 */
export async function toggleSubscription(
  db: Db,
  bot: Pick<DiscordBot, 'addMemberRole' | 'removeMemberRole'>,
  ctx: InteractionCtx,
  region: SubRegion,
  now = new Date(),
): Promise<Reply> {
  const ids = await roleIds(db);
  const roleId = ids[region];
  const label = `${REGION_META[region]!.flag} ${REGION_META[region]!.label}`;
  if (!roleId) return '알림 역할이 아직 준비되지 않았어요. 관리자에게 봇의 "역할 관리" 권한을 확인해 달라고 해 주세요.';
  const has = ctx.memberRoleIds.includes(roleId);
  try {
    if (has) await bot.removeMemberRole(ctx.userId, roleId);
    else await bot.addMemberRole(ctx.userId, roleId);
  } catch (err) {
    if (discordErrorCode(err) === 50013) {
      return '봇이 이 역할을 줄 수 없어요. 서버 설정 → 역할에서 봇 역할을 알림 역할들보다 위로 올려야 해요. 관리자에게 알려 주세요.';
    }
    throw err;
  }
  // 직접 바꾼 사람은 기본 구독 대상에서 뺀다 (국내를 끈 사람에게 다시 주지 않게)
  await db.insert(discordMembers).values({ userId: ctx.userId, initializedAt: now.toISOString() }).onConflictDoNothing();
  const roles = has ? ctx.memberRoleIds.filter((r) => r !== roleId) : [...ctx.memberRoleIds, roleId];
  return `${has ? '🔕' : '🔔'} ${label} 행사 알림을 ${has ? '껐어요' : '켰어요'}.\n${subscriptionLine(ids, roles)}`;
}
