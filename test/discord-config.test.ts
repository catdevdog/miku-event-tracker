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
  it('명령 정의는 ping 하나', () => {
    expect(commandDefinitions.map((c) => c.name)).toEqual(['ping']);
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
