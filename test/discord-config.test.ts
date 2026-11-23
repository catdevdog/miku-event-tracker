import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildPingReply, commandDefinitions } from '../src/notify/commands.js';
import { formatKst } from '../src/notify/format.js';

const base = { DATABASE_URL: 'file:./t.db', TZ: 'UTC', ADMIN_BASIC_AUTH: 'a:b' };
const ids = {
  DISCORD_APP_ID: '123456789012345678',
  DISCORD_GUILD_ID: '123456789012345679',
  DISCORD_NOTICE_CHANNEL_ID: '123456789012345680',
  DISCORD_ADMIN_CHANNEL_ID: '123456789012345681',
};

describe('디스코드 설정', () => {
  it('토큰이 없으면 봇 관련 값이 없어도 된다', () => {
    expect(() => loadConfig(base)).not.toThrow();
  });

  it('토큰이 있으면 앱·서버·채널 ID가 모두 필요하다', () => {
    expect(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: 't' })).toThrow(/DISCORD_APP_ID[\s\S]*DISCORD_ADMIN_CHANNEL_ID/);
    expect(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: 't', ...ids })).not.toThrow();
    expect(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: 't', ...ids, DISCORD_GUILD_ID: 'abc' })).toThrow(/숫자 ID/);
  });

  it('웹후크 URL 형식을 검사한다', () => {
    expect(() => loadConfig({ ...base, DISCORD_NOTICE_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc-_X' })).not.toThrow();
    expect(() => loadConfig({ ...base, DISCORD_NOTICE_WEBHOOK_URL: 'https://example.com/hook' })).toThrow(/웹후크/);
  });
});

describe('/ping', () => {
  it('명령 정의: ping, 소스, 최근수집, 행사', () => {
    expect(commandDefinitions.map((c) => c.name)).toEqual(['ping', '소스', '최근수집', '행사', '점검', '가이드', '내알림', '제보', '행사 제보', '관리']);
    const scopeOpt = (commandDefinitions[3] as { options?: { choices?: { value: string }[] }[] }).options![0]!;
    expect(scopeOpt.choices!.map((c) => c.value)).toEqual(['domestic', 'japan', 'overseas', 'all']);
  });

  it('응답에 지연, 가동 시간, 소스 수, 마지막 수집(KST), 연속 실패 소스가 들어간다', () => {
    const text = buildPingReply({
      status: { sourcesTotal: 32, sourcesEnabled: 29, failingSources: ['X @cfm_miku'], lastJobRunAt: '2026-11-22T13:18:00.000Z' },
      wsPingMs: 42,
      uptimeSec: 3720,
    });
    expect(text).toContain('42ms');
    expect(text).toContain('1시간 2분');
    expect(text).toContain('29/32');
    expect(text).toContain('22:18');
    expect(text).toContain('X @cfm_miku');
  });

  it('UTC를 한국 시각으로 표시한다', () => {
    expect(formatKst('2026-11-22T15:30:00.000Z')).toMatch(/2026\. 11\. 23\.\s*00:30 KST/);
    expect(formatKst(null)).toBe('-');
  });
});

describe('명령 응답 (임베드 + 고정폭 표)', async () => {
  const { buildSourcesReply, buildRecentReply, buildEventsReply } = await import('../src/notify/commands.js');
  const { displayWidth, textTable } = await import('../src/notify/format.js');
  const desc = (m: { embeds?: Record<string, unknown>[] }) => String(m.embeds![0]!.description);

  it('표: 한글은 2칸으로 계산해 앞쪽 열을 맞추고, 마지막 열은 자른다', () => {
    expect(displayWidth('정상 ab')).toBe(7);
    const table = textTable(['상태', '시각', '이름'], [['정상', '11-22 23:05', 'PR TIMES'], ['경보', '-----------', '가'.repeat(40)]], 10);
    expect(table.split('\n')).toEqual(['```', '상태  시각         이름', '정상  11-22 23:05  PR TIMES', '경보  -----------  가가가가…', '```']);
  });

  it('/소스', () => {
    const m = buildSourcesReply([
      { name: 'PR TIMES', adapter: 'rss', enabled: true, paused: false, lastRunAt: null, lastSuccessAt: '2026-11-22T14:05:00.000Z', consecutiveFailures: 0, implemented: true },
      { name: 'X @cfm_miku', adapter: 'x_crawl', enabled: true, paused: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 3, implemented: true },
      { name: 'NOL 티켓', adapter: 'ticket', enabled: false, paused: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0, implemented: true },
    ]);
    expect(desc(m)).toContain('정상  11-22 23:05  0     PR TIMES');
    expect(desc(m)).toContain('경보  -----------  3     X @cfm_miku');
    expect(desc(m)).toContain('꺼짐  -----------  0     NOL 티켓');
    expect((m.embeds![0]!.footer as { text: string }).text).toContain('활성 2/3개 · 3회 이상 연속 실패 1개');
  });

  it('/최근수집, /행사', () => {
    expect(desc(buildRecentReply([]))).toBe('아직 수집한 글이 없습니다.');
    const r = buildRecentReply([{ source: '멜론티켓', title: '하츠네 미쿠 EXPO', url: null, fetchedAt: '2026-11-22T14:05:00.000Z', keywordHit: 'strong', llmStatus: 'done' }]);
    expect(desc(r)).toContain('11-22 23:05  강  완료  멜론티켓 · 하츠네 미쿠 EXPO');
    const ev = buildEventsReply(
      [
        { id: 1, title: 'HATSUNE MIKU EXPO 2027 KOREA', kind: 'concert', officiality: 'crypton', region: 'KR', city: '서울', venue: '올림픽홀', startDate: '2027-03-06', endDate: '2027-03-07', ticketOpenAt: '2026-12-01T11:00:00.000Z', ticketUrl: null, status: 'ticket_scheduled', parentEventId: null, summaryKo: null, dedupKey: 'k', needsReview: 0, mergedInto: null, aliases: '[]', dupOfId: null, presales: '[]', createdAt: '', updatedAt: '' },
      ],
      'domestic',
    );
    expect(ev.embeds![0]!.title).toBe('다가오는 행사 · 국내');
    expect(desc(ev)).toContain('27.03.06~03.07  국내  예정  HATSUNE MIKU EXPO 2027 KOREA @올림픽홀 · 티켓 12-01 20:00');
    expect(desc(buildEventsReply([], 'overseas'))).toContain('없습니다');
    expect(buildEventsReply([], 'japan').embeds![0]!.title).toBe('다가오는 행사 · 일본');
  });
});
