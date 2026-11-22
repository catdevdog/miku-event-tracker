import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = { DATABASE_URL: 'file:./data/t.db', TZ: 'UTC', ADMIN_BASIC_AUTH: 'admin:s3cret-value' };

describe('loadConfig', () => {
  it('필수 값이 있으면 통과하고 PORT 기본값은 3000', () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(3000);
    expect(c.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it('필수 값이 없으면 키 이름을 모두 담아 실패', () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      for (const k of ['DATABASE_URL', 'TZ', 'ADMIN_BASIC_AUTH']) expect(msg).toContain(k);
    }
  });

  it('빈 문자열은 값이 없는 것으로 본다', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: '  ' })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ ...valid, KOPIS_SERVICE_KEY: '', PORT: '' }).KOPIS_SERVICE_KEY).toBeUndefined();
  });

  it('형식이 틀리면 실패하고 오류 메시지에 값은 넣지 않는다', () => {
    expect(() => loadConfig({ ...valid, TZ: 'Asia/Seoul' })).toThrow(/TZ/);
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'postgres://x' })).toThrow(/DATABASE_URL/);
    try {
      loadConfig({ ...valid, ADMIN_BASIC_AUTH: 'no-colon-secret' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('ADMIN_BASIC_AUTH');
      expect((e as Error).message).not.toContain('no-colon-secret');
    }
  });

  it('앞뒤 공백과 감싼 따옴표를 뗀다', () => {
    const c = loadConfig({ ...valid, DISCORD_BOT_TOKEN: ' "abc.def.ghi"\n', DISCORD_APP_ID: '123456789012345678', DISCORD_GUILD_ID: '123456789012345679', DISCORD_NOTICE_CHANNEL_ID: '123456789012345680', DISCORD_ADMIN_CHANNEL_ID: '123456789012345681' });
    expect(c.DISCORD_BOT_TOKEN).toBe('abc.def.ghi');
    expect(loadConfig({ ...valid, KOPIS_SERVICE_KEY: "''" }).KOPIS_SERVICE_KEY).toBeUndefined();
  });

  it('CLAUDE_API_KEY도 ANTHROPIC_API_KEY로 받는다', () => {
    expect(loadConfig({ ...valid, CLAUDE_API_KEY: 'sk-ant-x' }).ANTHROPIC_API_KEY).toBe('sk-ant-x');
    expect(loadConfig({ ...valid, CLAUDE_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }).ANTHROPIC_API_KEY).toBe('b');
  });

  it('NOTIFY_PAUSED는 1·true만 켠다', () => {
    expect(loadConfig(valid).NOTIFY_PAUSED).toBe(false);
    expect(loadConfig({ ...valid, NOTIFY_PAUSED: '1' }).NOTIFY_PAUSED).toBe(true);
    expect(loadConfig({ ...valid, NOTIFY_PAUSED: 'TRUE' }).NOTIFY_PAUSED).toBe(true);
    expect(loadConfig({ ...valid, NOTIFY_PAUSED: '0' }).NOTIFY_PAUSED).toBe(false);
  });
});
