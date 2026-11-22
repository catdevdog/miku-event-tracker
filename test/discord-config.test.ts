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
    expect(commandDefinitions.map((c) => c.name)).toEqual(['ping', '소스', '최근수집', '행사']);
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

describe('명령 응답', async () => {
  const { buildSourcesReply, buildRecentReply, buildEventsReply } = await import('../src/notify/commands.js');
  it('/소스', () => {
    const text = buildSourcesReply([
      { name: 'PR TIMES', adapter: 'rss', enabled: true, lastRunAt: null, lastSuccessAt: '2026-11-22T14:05:00.000Z', consecutiveFailures: 0 },
      { name: 'X @cfm_miku', adapter: 'x_crawl', enabled: true, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 3 },
      { name: 'NOL 티켓', adapter: 'ticket', enabled: false, lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
    ]);
    expect(text).toContain('소스 2/3개 활성 · 연속 실패 1개');
    expect(text).toContain('✅ PR TIMES · 성공 11-22 23:05');
    expect(text).toContain('⚠️ X @cfm_miku · 성공 - · 실패 3');
    expect(text).toContain('⏸ NOL 티켓');
  });
  it('/최근수집, /행사', () => {
    expect(buildRecentReply([])).toBe('아직 수집한 글이 없습니다.');
    expect(buildRecentReply([{ source: '멜론티켓', title: '하츠네 미쿠 EXPO', url: null, fetchedAt: '2026-11-22T14:05:00.000Z', keywordHit: 'strong', llmStatus: 'done' }])).toContain('11-22 23:05 [강·완료] 멜론티켓 · 하츠네 미쿠 EXPO');
    expect(buildEventsReply([])).toContain('없습니다');
  });
});
