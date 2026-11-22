import express, { type Express, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { sources } from './db/schema.js';
import { getServiceStatus } from './services/status.js';

export interface AppDeps {
  db: Db;
  adminBasicAuth: string;
  startedAt: Date;
  /** 디스코드 봇 상태: disabled | connecting | ready | error | stopped */
  discordState?: () => string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 관리 경로 보호. 추후 공개 웹(/api/public/*)에는 붙이지 않는다. */
export function basicAuth(expected: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    if (safeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="miku-tracker-admin", charset="UTF-8"').status(401).end();
  };
}

export function createApp({ db, adminBasicAuth, startedAt, discordState = () => 'disabled' }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Railway 헬스체크와 수동 확인용. 인증 없음, 민감 정보 없음.
  app.get('/health', async (_req, res) => {
    try {
      await db.run(sql`SELECT 1`);
      const status = await getServiceStatus(db);
      // 디스코드가 끊겨도 수집은 계속되므로 200을 유지하고 상태만 알린다.
      res.json({
        status: 'ok',
        db: 'ok',
        discord: discordState(),
        lastJobRunAt: status.lastJobRunAt,
        failingSources: status.failingSources.length,
        uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      });
    } catch {
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  });

  // ── 관리 API (/api/admin/*) ── 5단계에서 확장
  const admin = express.Router();
  admin.use(basicAuth(adminBasicAuth));
  admin.get('/sources', async (_req, res) => {
    const rows = await db
      .select({
        id: sources.id,
        name: sources.name,
        layer: sources.layer,
        adapter: sources.adapter,
        enabled: sources.enabled,
        intervalMin: sources.intervalMin,
        lastRunAt: sources.lastRunAt,
        lastSuccessAt: sources.lastSuccessAt,
        consecutiveFailures: sources.consecutiveFailures,
      })
      .from(sources)
      .orderBy(sources.id);
    res.json(rows);
  });
  app.use('/api/admin', admin);

  return app;
}
