import { asc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sources } from '../db/schema.js';
import { isSchedulable } from '../scheduler/due.js';
import { isImplementedAdapter } from '../adapters/implemented.js';

export interface SourceStatusRow {
  name: string;
  adapter: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** 어댑터가 구현돼 실제로 수집하는지 */
  implemented: boolean;
}

export interface CollectionPlanRow {
  name: string;
  adapter: string;
  region: string;
  intervalMin: number;
  boostIntervalMin: number | null;
  /** 스케줄러에 오르는지 (enabled이고 대상이 TODO가 아님) */
  schedulable: boolean;
  /** 어댑터가 구현돼 실제로 수집하는지 */
  implemented: boolean;
}

/** 소스별 수집 주기와 실제 수집 여부 (/가이드) */
export async function listCollectionPlan(db: Db): Promise<CollectionPlanRow[]> {
  const rows = await db.select().from(sources).orderBy(asc(sources.id));
  return rows.map((s) => ({
    name: s.name,
    adapter: s.adapter,
    region: s.region,
    intervalMin: s.intervalMin,
    boostIntervalMin: s.boostIntervalMin,
    schedulable: isSchedulable(s),
    implemented: isImplementedAdapter(s.adapter),
  }));
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
  return rows.map((r) => ({ ...r, enabled: r.enabled === 1, implemented: isImplementedAdapter(r.adapter) }));
}
