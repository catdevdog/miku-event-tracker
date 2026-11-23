import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { ButtonBuilder, ButtonStyle, ContainerBuilder, SeparatorSpacingSize, StringSelectMenuBuilder } from 'discord.js';
import type { Db } from '../db/client.js';
import { EVENT_KINDS, KEYWORD_TIERS, events, jobRuns, keywords, sources } from '../db/schema.js';
import { bestTitleSimilarity, periodsOverlap, type EventRow } from '../pipeline/merge.js';
import { TIER_KO, addKeyword, eventChoices, eventLabel, getEvent, listKeywords, removeKeyword, sourceAction, type KeywordTier, type SourceAction } from '../services/admin.js';
import { esc, type Card } from './cards.js';
import type { ButtonResult, InteractionCtx, ModalSpec, Reply } from './discord.js';
import { discordTime } from './format.js';
import { CARD_COLOR, DOT, kindLabel } from './labels.js';
import type { OutgoingMessage } from './types.js';

/**
 * 관리 패널: 관리자 채널에 고정된 상태판 아래 버튼으로 /관리 명령과 같은 일을 한다.
 * - 패널 버튼을 누르면 누른 사람에게만 보이는 화면이 열리고, 그 안의 선택 메뉴·버튼은 그 화면을 바꿔 가며 진행한다.
 * - custom_id는 모두 "ad:"로 시작한다. 서버 관리 권한 확인은 interactions.ts가 한다.
 * - 선택 메뉴는 25개까지라 수집처·키워드는 여러 메뉴로 나누고, 행사는 최근 25건 + 이름 검색을 쓴다.
 */
export const isAdminPanelId = (id: string) => id.startsWith('ad:');

/** 관리 작업 (interactions.ts가 /관리 명령과 같이 쓰는 구현을 넘긴다) */
export interface AdminOps {
  editModal(e: EventRow): ModalSpec;
  setKind(e: EventRow, kind: string, userId: string): Promise<string>;
  setHidden(e: EventRow, hidden: boolean): Promise<string>;
  merge(keepId: number, absorbId: number, userId: string): Promise<string>;
  notify(action: 'pause' | 'resume' | 'toggle' | 'status'): Promise<string>;
  dupSweep(): Promise<string>;
  calendar(): Promise<string>;
  setup(): Promise<string>;
  /** 행사 상세 카드 (숨김·검수 대기 포함) */
  detail(id: number): Promise<Reply>;
  diagnostics(): Promise<OutgoingMessage>;
  /** 지금 상태로 그린 패널(상태판) 메시지 */
  board(): Promise<OutgoingMessage>;
  /** 고정된 패널 메시지를 지금 고친다 */
  refreshBoard(): Promise<void>;
}

const SELECT_MAX = 25;
const btn = (id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 상태판 아래에 붙는 패널 버튼 두 줄 */
export function panelButtonRows(notifyPaused: boolean): ButtonBuilder[][] {
  return [
    [
      btn('ad:src', '📡 수집처', ButtonStyle.Primary),
      btn('ad:evt', '🎤 행사', ButtonStyle.Primary),
      btn('ad:kw', '🔑 키워드', ButtonStyle.Primary),
      btn('ad:pause', notifyPaused ? '▶️ 알림 재개' : '⏸️ 알림 일시정지', notifyPaused ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn('ad:setup', '🔧 설정 점검'),
    ],
    [btn('ad:dup', '🔁 중복검사'), btn('ad:cal', '🗓️ 달력 올리기'), btn('ad:diag', '🩺 점검'), btn('ad:refresh', '🔄 새로고침')],
  ];
}

const screen = (color: number, text: string) => new ContainerBuilder().setAccentColor(color).addTextDisplayComponents((t) => t.setContent(text.slice(0, 3500)));
const out = (c: ContainerBuilder, content: string): OutgoingMessage => ({ card: [c.toJSON()], content: content.slice(0, 1900) });

// ── 수집처 ────────────────────────────────────────────────

type SourceRow = Pick<typeof sources.$inferSelect, 'id' | 'name' | 'enabled' | 'paused' | 'target' | 'consecutiveFailures' | 'lastRunAt' | 'lastSuccessAt' | 'intervalMin' | 'region' | 'adapter'>;

const sourceIcon = (s: SourceRow) =>
  s.enabled !== 1 || s.target === 'TODO' ? DOT.off : s.paused === 1 ? DOT.paused : s.consecutiveFailures >= 3 ? DOT.alert : s.consecutiveFailures > 0 ? DOT.fail : DOT.ok;

/** 문제 있는 수집처(경보 → 실패 → 멈춤) 먼저, 그다음 정상, 꺼 둔 것은 맨 뒤 */
export async function panelSources(db: Db): Promise<SourceRow[]> {
  const rows = await db.select().from(sources).where(ne(sources.adapter, 'manual')).orderBy(asc(sources.id));
  const rank = (s: SourceRow) => (s.enabled !== 1 || s.target === 'TODO' ? 4 : s.consecutiveFailures >= 3 ? 0 : s.consecutiveFailures > 0 ? 1 : s.paused === 1 ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

export function sourcesScreen(rows: SourceRow[], note?: string): OutgoingMessage {
  const usable = rows.filter((s) => s.enabled === 1 && s.target !== 'TODO');
  const count = (icon: string) => usable.filter((s) => sourceIcon(s) === icon).length;
  const head = [
    '### 📡 수집처',
    `${DOT.ok} 정상 ${count(DOT.ok)} · ${DOT.fail} 실패 ${count(DOT.fail)} · ${DOT.alert} 경보 ${count(DOT.alert)} · ${DOT.paused} 멈춤 ${count(DOT.paused)}`,
    '-# 수집처를 고르면 멈춤·재개·지금 수집을 할 수 있어요. 문제 있는 곳이 위에 나와요.',
    ...(note ? ['', note] : []),
  ].join('\n');
  const c = screen(CARD_COLOR.miku, head);
  for (let i = 0; i * SELECT_MAX < usable.length && i < 4; i++) {
    const chunk = usable.slice(i * SELECT_MAX, (i + 1) * SELECT_MAX);
    c.addActionRowComponents((r) =>
      r.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ad:srcsel:${i}`)
          .setPlaceholder(i === 0 ? '수집처 고르기' : `수집처 고르기 (${i * SELECT_MAX + 1}번째부터)`)
          .addOptions(chunk.map((s) => ({ label: clip(`${sourceIcon(s)} ${s.name}`, 100), value: String(s.id), description: clip(`${s.region} · ${s.adapter} · ${s.intervalMin}분마다`, 100) }))),
      ),
    );
  }
  return out(c, head);
}

export function sourceScreen(s: SourceRow, note?: string, lastError?: string | null): OutgoingMessage {
  const state = s.paused === 1 ? '멈춤' : s.consecutiveFailures >= 3 ? `경보 (연속 실패 ${s.consecutiveFailures}회)` : s.consecutiveFailures > 0 ? `실패 ${s.consecutiveFailures}회` : '정상';
  const text = [
    `### ${sourceIcon(s)} ${esc(s.name)}`,
    `상태 **${state}** · ${s.intervalMin}분마다 · ${s.region}`,
    `마지막 수집 ${s.lastRunAt ? discordTime(s.lastRunAt, 'R') : '없음'} · 마지막 성공 ${s.lastSuccessAt ? discordTime(s.lastSuccessAt, 'R') : '없음'}`,
    ...(s.consecutiveFailures > 0 && lastError ? [`> ${esc(clip(lastError, 300))}`] : []),
    ...(note ? ['', note] : []),
  ].join('\n');
  const c = screen(s.consecutiveFailures >= 3 ? CARD_COLOR.alert : s.paused === 1 ? CARD_COLOR.off : CARD_COLOR.ok, text);
  c.addActionRowComponents((r) =>
    r.setComponents(
      s.paused === 1 ? btn(`ad:sa:resume:${s.id}`, '▶️ 재개', ButtonStyle.Success) : btn(`ad:sa:pause:${s.id}`, '⏸️ 멈춤'),
      btn(`ad:sa:run:${s.id}`, '🔄 지금 수집', ButtonStyle.Primary).setDisabled(s.paused === 1),
      btn('ad:src', '◀ 목록'),
    ),
  );
  return out(c, text);
}

// ── 행사 ──────────────────────────────────────────────────

export function eventsScreen(choices: { name: string; value: string }[], title = '최근 행사', note?: string): OutgoingMessage {
  const text = ['### 🎤 행사 관리', `-# ${title} ${choices.length}건. 고르면 수정·유형 변경·숨기기·합치기를 할 수 있어요.`, ...(note ? ['', note] : [])].join('\n');
  const c = screen(CARD_COLOR.miku, text);
  if (choices.length) {
    c.addActionRowComponents((r) =>
      r.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ad:evtsel')
          .setPlaceholder('행사 고르기')
          .addOptions(choices.slice(0, SELECT_MAX).map((o) => ({ label: clip(o.name, 100), value: o.value }))),
      ),
    );
  }
  c.addActionRowComponents((r) => r.setComponents(btn('ad:evtfind', '🔎 이름으로 찾기', ButtonStyle.Primary), btn('ad:evt', '🕓 최근 행사')));
  return out(c, text);
}

/** 행사 상세 카드 + 관리 버튼 */
export function eventAdminScreen(e: EventRow, detail: Reply, note?: string): OutgoingMessage {
  const base: Card = typeof detail === 'string' ? [screen(CARD_COLOR.off, detail).toJSON()] : (detail.card ?? []);
  const hidden = e.needsReview === 2;
  const c = new ContainerBuilder().setAccentColor(CARD_COLOR.miku);
  if (note) c.addTextDisplayComponents((t) => t.setContent(note.slice(0, 1500)));
  if (e.mergedInto) c.addTextDisplayComponents((t) => t.setContent(`-# 이 행사는 #${e.mergedInto}에 합쳐졌어요.`));
  c.addActionRowComponents((r) =>
    r.setComponents(
      btn(`ad:ee:${e.id}`, '✏️ 수정', ButtonStyle.Primary),
      btn(`ad:ek:${e.id}`, '🏷️ 유형 변경'),
      hidden ? btn(`ad:eh:show:${e.id}`, '👀 다시 보이기', ButtonStyle.Success) : btn(`ad:eh:hide:${e.id}`, '🙈 숨기기'),
      btn(`ad:em:${e.id}`, '🔗 다른 행사 합치기').setDisabled(!!e.mergedInto),
      btn('ad:evt', '◀ 목록'),
    ),
  );
  return { card: [...base, c.toJSON()], content: `행사 #${e.id} ${e.title}${note ? `\n${note}` : ''}`.slice(0, 1900) };
}

export function kindScreen(e: EventRow): OutgoingMessage {
  const text = `### 🏷️ 유형 변경\n#${e.id} **${esc(e.title)}** · 지금 ${kindLabel(e.kind)}`;
  const c = screen(CARD_COLOR.miku, text);
  c.addActionRowComponents((r) =>
    r.setComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ad:eksel:${e.id}`)
        .setPlaceholder('바꿀 유형 고르기')
        .addOptions(EVENT_KINDS.map((k) => ({ label: kindLabel(k), value: k, default: k === e.kind }))),
    ),
  );
  c.addActionRowComponents((r) => r.setComponents(btn(`ad:ev:${e.id}`, '◀ 돌아가기')));
  return out(c, text);
}

/** 합칠 상대 후보: 제목이 비슷하거나 기간이 겹치는 행사 먼저 (합쳐진 행사 제외) */
export async function mergeCandidates(db: Db, keep: EventRow): Promise<EventRow[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(ne(events.id, keep.id), isNull(events.mergedInto)))
    .orderBy(desc(events.updatedAt))
    .limit(400);
  const score = (c: EventRow) =>
    bestTitleSimilarity(c, keep.title) * 3 + (periodsOverlap(keep.startDate, keep.endDate, c.startDate, c.endDate, 1) ? 1 : 0) + (c.region === keep.region ? 0.3 : 0);
  return rows
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SELECT_MAX)
    .map((x) => x.c);
}

export function mergeScreen(keep: EventRow, candidates: EventRow[]): OutgoingMessage {
  const text = [
    '### 🔗 다른 행사 합치기',
    `남길 행사: #${keep.id} **${esc(keep.title)}**`,
    '-# 여기에 합쳐서 숨길 행사를 고르세요. 비슷한 행사가 위에 나와요. 고른 뒤 한 번 더 확인해요.',
  ].join('\n');
  const c = screen(CARD_COLOR.miku, text);
  if (candidates.length) {
    c.addActionRowComponents((r) =>
      r.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ad:emsel:${keep.id}`)
          .setPlaceholder('합칠 행사 고르기')
          .addOptions(candidates.map((e) => ({ label: clip(eventLabel(e), 100), value: String(e.id) }))),
      ),
    );
  }
  c.addActionRowComponents((r) => r.setComponents(btn(`ad:ev:${keep.id}`, '◀ 돌아가기')));
  return out(c, text);
}

export function mergeConfirmScreen(keep: EventRow, absorb: EventRow): OutgoingMessage {
  const text = [
    '### 🔗 합칠까요?',
    `남길 행사: ${esc(eventLabel(keep))}`,
    `합쳐서 숨길 행사: ${esc(eventLabel(absorb))}`,
    '-# 출처·알림 받기·참석 표시를 남길 행사로 옮기고, 합친 행사의 공지는 지워요. 되돌리려면 `/관리 행사`에서 다시 보이기를 해야 해요.',
  ].join('\n');
  const c = screen(CARD_COLOR.fail, text);
  c.addActionRowComponents((r) => r.setComponents(btn(`ad:emok:${keep.id}:${absorb.id}`, '🔗 합치기', ButtonStyle.Danger), btn(`ad:ev:${keep.id}`, '취소')));
  return out(c, text);
}

// ── 키워드 ────────────────────────────────────────────────

const TIER_INPUT: Record<string, KeywordTier> = { 강: 'strong', strong: 'strong', 약: 'weak', weak: 'weak', 맥락: 'context', context: 'context', 제외: 'exclude', exclude: 'exclude' };

export function keywordsScreen(k: Record<KeywordTier, string[]>, note?: string): OutgoingMessage {
  const text = [
    '### 🔑 키워드',
    ...KEYWORD_TIERS.map((t) => `**${TIER_KO[t]}** (${k[t].length})　${k[t].map(esc).join(', ') || '없음'}`),
    '-# 강: 하나만 있어도 통과 · 약: 맥락 단어와 같이 있어야 통과 · 제외: 강 키워드가 없으면 버림',
    ...(note ? ['', note] : []),
  ].join('\n');
  const c = screen(CARD_COLOR.miku, text);
  c.addActionRowComponents((r) => r.setComponents(btn('ad:kwadd', '➕ 추가', ButtonStyle.Primary), btn('ad:kwdel', '➖ 삭제')));
  return out(c, text);
}

export function keywordDeleteScreen(rows: { id: number; term: string; tier: KeywordTier }[]): OutgoingMessage {
  const text = '### ➖ 키워드 삭제\n-# 뺄 키워드를 고르세요. 재배포해도 다시 켜지지 않아요. 다시 쓰려면 추가하면 돼요.';
  const c = screen(CARD_COLOR.miku, text);
  for (let i = 0; i * SELECT_MAX < rows.length && i < 4; i++) {
    const chunk = rows.slice(i * SELECT_MAX, (i + 1) * SELECT_MAX);
    c.addActionRowComponents((r) =>
      r.setComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ad:kwdelsel:${i}`)
          .setPlaceholder(`${TIER_KO[chunk[0]!.tier].split('(')[0]} ~ ${TIER_KO[chunk[chunk.length - 1]!.tier].split('(')[0]} (${chunk.length}개)`)
          .addOptions(chunk.map((kw) => ({ label: clip(kw.term, 100), value: String(kw.id), description: TIER_KO[kw.tier] }))),
      ),
    );
  }
  c.addActionRowComponents((r) => r.setComponents(btn('ad:kw', '◀ 돌아가기')));
  return out(c, text);
}

// ── 처리 ──────────────────────────────────────────────────

export function createAdminPanel(deps: { db: Db; ops: AdminOps; now?: () => Date }) {
  const { db, ops } = deps;
  const getSource = async (id: number) => (await db.select().from(sources).where(and(eq(sources.id, id), ne(sources.adapter, 'manual'))))[0];
  /** 가장 최근 실패의 오류 문구 */
  const lastError = async (sourceId: number) =>
    (await db.select({ error: jobRuns.error }).from(jobRuns).where(and(eq(jobRuns.sourceId, sourceId), eq(jobRuns.status, 'error'))).orderBy(desc(jobRuns.id)).limit(1))[0]?.error;
  const eventView = async (id: number, note?: string): Promise<OutgoingMessage> => {
    const e = await getEvent(db, id);
    if (!e) return eventsScreen(await eventChoices(db, ''), '최근 행사', '행사를 찾을 수 없어요.');
    return eventAdminScreen(e, await ops.detail(id), note);
  };
  const activeKeywords = async () =>
    db
      .select({ id: keywords.id, term: keywords.term, tier: keywords.tier })
      .from(keywords)
      .where(eq(keywords.disabled, 0))
      // 강 → 약 → 맥락 → 제외
      .orderBy(sql`CASE ${keywords.tier} WHEN 'strong' THEN 0 WHEN 'weak' THEN 1 WHEN 'context' THEN 2 ELSE 3 END`, asc(keywords.id));

  return {
    /**
     * 버튼·선택 메뉴. 패널(고정 메시지)의 버튼은 누른 사람에게만 보이는 새 화면({reply})을 열고,
     * 그 화면 안의 버튼·메뉴는 화면을 바꾼다(OutgoingMessage). 권한 확인은 호출한 쪽에서 한다.
     */
    async onComponent(customId: string, values: string[], ctx: InteractionCtx): Promise<ButtonResult> {
      const [, action, a, b] = customId.split(':') as [string, string, string | undefined, string | undefined];
      const picked = values[0];
      switch (action) {
        // 패널 버튼
        case 'src':
          return { reply: sourcesScreen(await panelSources(db)) };
        case 'evt':
          return { reply: eventsScreen(await eventChoices(db, '')) };
        case 'kw':
          return { reply: keywordsScreen(await listKeywords(db)) };
        case 'pause': {
          const text = await ops.notify('toggle');
          await ops.refreshBoard();
          return { reply: text };
        }
        case 'setup':
          return { reply: await ops.setup() };
        case 'dup':
          return { reply: await ops.dupSweep() };
        case 'cal':
          return { reply: await ops.calendar() };
        case 'diag':
          return { reply: await ops.diagnostics() };
        case 'refresh':
          return ops.board();

        // 수집처
        case 'srcsel': {
          const s = picked ? await getSource(Number(picked)) : undefined;
          return s ? sourceScreen(s, undefined, await lastError(s.id)) : sourcesScreen(await panelSources(db), '수집처를 찾을 수 없어요.');
        }
        case 'sa': {
          const s = await getSource(Number(b));
          if (!s) return sourcesScreen(await panelSources(db), '수집처를 찾을 수 없어요.');
          const note = await sourceAction(db, s.name, a as SourceAction);
          return sourceScreen((await getSource(s.id))!, note, await lastError(s.id));
        }

        // 행사
        case 'evtsel':
          return picked ? eventView(Number(picked)) : null;
        case 'evtfind':
          return { modal: { customId: 'ad:evtfind', title: '행사 찾기', inputs: [{ id: 'q', label: '행사 이름 또는 #번호', required: true, maxLength: 50 }] } };
        case 'ev':
          return eventView(Number(a));
        case 'ee': {
          const e = await getEvent(db, Number(a));
          return e ? { modal: ops.editModal(e) } : null;
        }
        case 'ek': {
          const e = await getEvent(db, Number(a));
          return e ? kindScreen(e) : null;
        }
        case 'eksel': {
          const e = await getEvent(db, Number(a));
          if (!e || !picked) return null;
          return eventView(e.id, await ops.setKind(e, picked, ctx.userId));
        }
        case 'eh': {
          const e = await getEvent(db, Number(b));
          if (!e) return null;
          return eventView(e.id, await ops.setHidden(e, a === 'hide'));
        }
        case 'em': {
          const e = await getEvent(db, Number(a));
          return e ? mergeScreen(e, await mergeCandidates(db, e)) : null;
        }
        case 'emsel': {
          const keep = await getEvent(db, Number(a));
          const absorb = picked ? await getEvent(db, Number(picked)) : undefined;
          return keep && absorb ? mergeConfirmScreen(keep, absorb) : null;
        }
        case 'emok':
          return eventView(Number(a), await ops.merge(Number(a), Number(b), ctx.userId));

        // 키워드
        case 'kwadd':
          return {
            modal: {
              customId: 'ad:kwadd',
              title: '키워드 추가',
              inputs: [
                { id: 'term', label: '단어 (2~40자)', required: true, maxLength: 40 },
                { id: 'tier', label: '등급: 강 / 약 / 맥락 / 제외', value: '강', required: true, maxLength: 10 },
              ],
            },
          };
        case 'kwdel':
          return keywordDeleteScreen(await activeKeywords());
        case 'kwdelsel': {
          const [kw] = picked ? await db.select().from(keywords).where(eq(keywords.id, Number(picked))) : [];
          const note = kw ? await removeKeyword(db, kw.term) : '키워드를 찾을 수 없어요.';
          return keywordsScreen(await listKeywords(db), note);
        }
        default:
          return null;
      }
    },

    /** 입력 창 제출 (행사 찾기, 키워드 추가). 결과는 새 화면으로 보여 준다 */
    async onModal(customId: string, fields: Record<string, string>, _ctx: InteractionCtx): Promise<Reply> {
      if (customId === 'ad:evtfind') {
        const q = (fields.q ?? '').trim();
        const choices = await eventChoices(db, q);
        if (choices.length === 1) {
          const e = await getEvent(db, Number(choices[0]!.value));
          if (e) return eventAdminScreen(e, await ops.detail(e.id));
        }
        return eventsScreen(choices, `"${clip(q, 30)}" 검색 결과`, choices.length ? undefined : '찾는 행사가 없어요. 다른 단어로 찾아보세요.');
      }
      if (customId === 'ad:kwadd') {
        const tier = TIER_INPUT[(fields.tier ?? '').trim().toLowerCase()];
        if (!tier) return keywordsScreen(await listKeywords(db), '⚠️ 등급은 강 / 약 / 맥락 / 제외 중 하나로 써 주세요. (추가하지 않았어요)');
        const note = await addKeyword(db, fields.term ?? '', tier);
        return keywordsScreen(await listKeywords(db), note);
      }
      return '알 수 없는 입력 창이에요.';
    },
  };
}
