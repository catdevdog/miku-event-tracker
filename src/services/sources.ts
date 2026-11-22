import { asc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sources } from '../db/schema.js';

export interface SourceStatusRow {
  name: string;
  adapter: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

/** 소스별 실행 상태 (/소스, 관리 화면) */
export async function listSourceStatuses(db: Db): Promise<SourceStatusRow[]> {
  const rows = await db
    .select({
      name: sources.name,
      adapter: sources.adapter,
      enabled: sources.enabled,
      lastRunAt: sources.lastRunAt,
      lastSuccessAt: sources.lastSuccessAt,
      consecutiveFailures: sources.consecutiveFailures,
    })
    .from(sources)
    .orderBy(asc(sources.id));
  return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}
