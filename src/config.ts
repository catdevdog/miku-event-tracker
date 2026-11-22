import { existsSync } from 'node:fs';
import { z } from 'zod';

// 빈 문자열은 값이 없는 것으로 본다 (.env의 `KEY=` 줄, Railway의 빈 변수).
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const requiredString = (name: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string({ error: `${name}가 필요합니다` }),
  );

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

  // ── 이후 단계에서 필수로 바꾼다 ──
  TURSO_AUTH_TOKEN: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_APP_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  DISCORD_NOTICE_CHANNEL_ID: optionalString,
  DISCORD_ADMIN_CHANNEL_ID: optionalString,
  // 선택: 공지 채널 웹후크. 봇과 같이 쓸지는 2단계에서 정한다.
  DISCORD_NOTICE_WEBHOOK_URL: optionalString,
  KOPIS_SERVICE_KEY: optionalString,
  NAVER_CLIENT_ID: optionalString,
  NAVER_CLIENT_SECRET: optionalString,
  X_AUTH_TOKEN: optionalString,
  X_CT0: optionalString,
  IG_USER_ID: optionalString,
  IG_ACCESS_TOKEN: optionalString,
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
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

/** 로컬 개발용: 작업 디렉터리에 .env가 있으면 process.env에 읽어 들인다. 이미 있는 값은 덮어쓰지 않는다. */
export function loadDotEnvIfPresent(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
