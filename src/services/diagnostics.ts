import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { isImplementedAdapter } from '../adapters/implemented.js';
import { isSchedulable } from '../scheduler/due.js';
import type { EventRow } from '../pipeline/merge.js';

export interface RegionEventCounts {
  region: string;
  /** 발표·예매 예정·판매 중·진행 중 (검수 대기 제외) */
  upcoming: number;
  ended: number;
  cancelled: number;
  needsReview: number;
}

/** 소스 하나의 수집 → 키워드 → 추출 → 행사 연결 단계별 건수 */
export interface SourceFunnelRow {
  name: string;
  adapter: string;
  schedulable: boolean;
  implemented: boolean;
  lastJobStatus: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  collected: number;
  passed: number;
  extracted: number;
  linked: number;
}

export interface Diagnostics {
  regions: RegionEventCounts[];
  /** 다가오는 확정 행사의 유형별 건수 (많은 순) */
  kinds: { kind: string; upcoming: number }[];
  recentKr: EventRow[];
  krSources: SourceFunnelRow[];
  pendingItems: number;
  errorItems: number;
}

/** /점검: 지역별 행사 수, 최근 국내 행사(종료 포함), 국내 소스의 단계별 건수 */
export async function getDiagnostics(db: Db): Promise<Diagnostics> {
  const counts = await db.all<{ region: string; upcoming: number; ended: number; cancelled: number; review: number }>(sql`
    SELECT region,
      sum(CASE WHEN needs_review = 0 AND status NOT IN ('ended','cancelled') THEN 1 ELSE 0 END) AS upcoming,
      sum(CASE WHEN needs_review = 0 AND status = 'ended' THEN 1 ELSE 0 END) AS ended,
      sum(CASE WHEN needs_review = 0 AND status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      sum(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) AS review
    FROM events GROUP BY region
  `);
  const byRegion = new Map(counts.map((c) => [c.region, c]));
  const regions = (['KR', 'JP', 'OTHER'] as const).map((region) => {
    const c = byRegion.get(region);
    return {
      region,
      upcoming: Number(c?.upcoming ?? 0),
      ended: Number(c?.ended ?? 0),
      cancelled: Number(c?.cancelled ?? 0),
      needsReview: Number(c?.review ?? 0),
    };
  });

  const recentKr = await db.select().from(events).where(eq(events.region, 'KR')).orderBy(desc(events.updatedAt), desc(events.id)).limit(5);

  const rows = await db.all<{
    name: string;
    adapter: string;
    enabled: number;
    paused: number;
    target: string;
    consecutive_failures: number;
    last_success_at: string | null;
    last_job: string | null;
    collected: number;
    passed: number;
    extracted: number;
    linked: number;
  }>(sql`
    SELECT s.name, s.adapter, s.enabled, s.paused, s.target, s.consecutive_failures, s.last_success_at,
      (SELECT j.status FROM job_runs j WHERE j.source_id = s.id ORDER BY j.id DESC LIMIT 1) AS last_job,
      (SELECT count(*) FROM raw_items r WHERE r.source_id = s.id) AS collected,
      (SELECT count(*) FROM raw_items r WHERE r.source_id = s.id AND r.llm_status <> 'skipped' AND r.keyword_hit IS NOT NULL) AS passed,
      (SELECT count(*) FROM raw_items r WHERE r.source_id = s.id AND r.llm_status = 'done') AS extracted,
      (SELECT count(DISTINCT es.raw_item_id) FROM event_sources es JOIN raw_items r ON r.id = es.raw_item_id WHERE r.source_id = s.id) AS linked
    FROM sources s WHERE s.region = 'KR' ORDER BY s.id
  `);
  const krSources = rows.map((r) => ({
    name: r.name,
    adapter: r.adapter,
    schedulable: isSchedulable({ enabled: r.enabled, target: r.target, paused: r.paused }),
    implemented: isImplementedAdapter(r.adapter),
    lastJobStatus: r.last_job,
    consecutiveFailures: r.consecutive_failures,
    lastSuccessAt: r.last_success_at,
    collected: Number(r.collected),
    passed: Number(r.passed),
    extracted: Number(r.extracted),
    linked: Number(r.linked),
  }));

  const [backlog] = await db.all<{ pending: number; error: number }>(sql`
    SELECT sum(CASE WHEN llm_status = 'pending' THEN 1 ELSE 0 END) AS pending,
           sum(CASE WHEN llm_status = 'error' THEN 1 ELSE 0 END) AS error
    FROM raw_items
  `);
  const kinds = (
    await db.all<{ kind: string; n: number }>(sql`
      SELECT kind, count(*) AS n FROM events
      WHERE needs_review = 0 AND status NOT IN ('ended','cancelled')
      GROUP BY kind ORDER BY n DESC, kind
    `)
  ).map((r) => ({ kind: r.kind, upcoming: Number(r.n) }));
  return { regions, kinds, recentKr, krSources, pendingItems: Number(backlog?.pending ?? 0), errorItems: Number(backlog?.error ?? 0) };
}
