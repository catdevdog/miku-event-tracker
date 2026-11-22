import { existsSync } from 'node:fs';
import { z } from 'zod';

// 앞뒤 공백과 감싼 따옴표를 떼고, 빈 문자열은 값이 없는 것으로 본다 (.env의 `KEY=` 줄, Railway의 빈 변수).
// 대시보드에 붙여 넣을 때 섞여 들어간 공백·따옴표 때문에 토큰이 틀렸다고 나오는 일을 막는다.
export function cleanEnvValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  let s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1).trim();
  return s === '' ? undefined : s;
}

const optionalString = z.preprocess(cleanEnvValue, z.string().optional());

const requiredString = (name: string) =>
  z.preprocess(cleanEnvValue, z.string({ error: `${name}가 필요합니다` }));

const schema = z.object({
  // ── 1단계 필수 ──
  DATABASE_URL: requiredString('DATABASE_URL').pipe(
    z.string().regex(/^(file:|libsql:|https?:)/, 'DATABASE_URL은 file:, libsql:, http(s): 로 시작해야 합니다'),
  ),
  TZ: requiredString('TZ').pipe(z.literal('UTC', { error: 'TZ는 UTC여야 합니다 (DB 시각은 UTC 기준)' })),
  ADMIN_BASIC_AUTH: requiredString('ADMIN_BASIC_AUTH').pipe(
    z.string().regex(/^[^:]+:.+$/, 'ADMIN_BASIC_AUTH는 user:password 형식이어야 합니다'),
  ),

  // ── 서버 ──
  PORT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().positive().default(3000),
  ),

  // ── 기능별 선택 값 (디스코드는 아래 superRefine에서 묶음 검증) ──
  TURSO_AUTH_TOKEN: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_APP_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  DISCORD_NOTICE_CHANNEL_ID: optionalString,
  DISCORD_ADMIN_CHANNEL_ID: optionalString,
  // 선택: 공지 채널 웹후크. 봇이 준비되지 않았거나 발송에 실패하면 공지를 이쪽으로 보낸다.
  DISCORD_NOTICE_WEBHOOK_URL: optionalString,
  KOPIS_SERVICE_KEY: optionalString,
  NAVER_CLIENT_ID: optionalString,
  NAVER_CLIENT_SECRET: optionalString,
  X_AUTH_TOKEN: optionalString,
  X_CT0: optionalString,
  IG_USER_ID: optionalString,
  IG_ACCESS_TOKEN: optionalString,
});

const SNOWFLAKE = /^\d{17,20}$/;
const WEBHOOK_URL = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/** 디스코드 봇은 토큰을 넣으면 켜진다. 토큰이 있으면 앱·서버·채널 ID도 모두 있어야 한다. */
const refined = schema.superRefine((c, ctx) => {
  if (c.DISCORD_BOT_TOKEN) {
    for (const key of ['DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'DISCORD_NOTICE_CHANNEL_ID', 'DISCORD_ADMIN_CHANNEL_ID'] as const) {
      const v = c[key];
      if (!v) ctx.addIssue({ code: 'custom', path: [key], message: `DISCORD_BOT_TOKEN이 있으면 ${key}도 필요합니다` });
      else if (!SNOWFLAKE.test(v)) ctx.addIssue({ code: 'custom', path: [key], message: `${key}는 숫자 ID여야 합니다` });
    }
  }
  if (c.DISCORD_NOTICE_WEBHOOK_URL && !WEBHOOK_URL.test(c.DISCORD_NOTICE_WEBHOOK_URL)) {
    ctx.addIssue({ code: 'custom', path: ['DISCORD_NOTICE_WEBHOOK_URL'], message: '디스코드 웹후크 URL 형식이 아닙니다' });
  }
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`환경 변수 오류:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** 환경 변수를 검증한다. 오류 메시지에는 키 이름만 넣고 값은 넣지 않는다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // CLAUDE_API_KEY라는 이름으로 넣은 경우도 받아 준다 (정식 이름은 ANTHROPIC_API_KEY).
  if (!cleanEnvValue(env.ANTHROPIC_API_KEY) && cleanEnvValue(env.CLAUDE_API_KEY)) env = { ...env, ANTHROPIC_API_KEY: env.CLAUDE_API_KEY };
  const result = refined.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

/** 로컬 개발용: 작업 디렉터리에 .env가 있으면 process.env에 읽어 들인다. 이미 있는 값은 덮어쓰지 않는다. */
export function loadDotEnvIfPresent(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
