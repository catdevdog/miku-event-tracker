// docs/schema.sql과 1:1. 테이블·컬럼·제약을 바꾸면 docs/schema.sql도 같이 바꾸고
// `npm run db:generate`로 마이그레이션을 만든 뒤 `scripts/compare-schema.ts`로 비교한다.
import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  unique,
  check,
  primaryKey,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const now = sql`(datetime('now'))`;

// CHECK 제약과 TS 타입이 같은 목록을 쓰도록 enum 값을 한곳에 둔다.
export const LAYERS = ['L1', 'L2', 'L3', 'L4'] as const;
export const ADAPTERS = ['rss', 'html_diff', 'playwright', 'x_crawl', 'instagram', 'kopis', 'naver'] as const;
export const SOURCE_REGIONS = ['KR', 'JP', 'GLOBAL'] as const;
export const JOB_STATUSES = ['running', 'ok', 'error', 'skipped'] as const;
export const KEYWORD_HITS = ['strong', 'weak', 'none'] as const;
export const LLM_STATUSES = ['pending', 'done', 'skipped', 'error'] as const;
export const EVENT_KINDS = ['concert', 'booth', 'stage', 'popup', 'cafe', 'exhibition', 'live_viewing', 'goods', 'other'] as const;
export const OFFICIALITIES = ['crypton', 'licensed', 'permitted_doujin', 'unverified'] as const;
export const EVENT_REGIONS = ['KR', 'JP', 'OTHER'] as const;
export const EVENT_STATUSES = ['announced', 'ticket_scheduled', 'on_sale', 'ongoing', 'ended', 'cancelled'] as const;
export const SUBSCRIBER_CHANNELS = ['discord_channel', 'discord_dm'] as const;
export const NOTIFICATION_REASONS = ['new', 'status_change', 'reminder'] as const;
export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;
export const KEYWORD_TIERS = ['strong', 'weak', 'context', 'exclude'] as const;

/** `col IN ('a','b')` CHECK 식. 값은 위 상수에서만 오므로 sql.raw로 넣어도 안전하다. */
function inList(column: string, values: readonly string[]) {
  return sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(',')})`);
}

// 감시 대상 소스
export const sources = sqliteTable(
  'sources',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull().unique(),
    layer: text('layer', { enum: LAYERS }).notNull(),
    adapter: text('adapter', { enum: ADAPTERS }).notNull(),
    target: text('target').notNull(),
    region: text('region', { enum: SOURCE_REGIONS }).notNull(),
    intervalMin: integer('interval_min').notNull(),
    boostIntervalMin: integer('boost_interval_min'),
    config: text('config').notNull().default('{}'),
    state: text('state').notNull().default('{}'),
    enabled: integer('enabled').notNull().default(1),
    lastRunAt: text('last_run_at'),
    lastSuccessAt: text('last_success_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    check('sources_layer_check', inList('layer', LAYERS)),
    check('sources_adapter_check', inList('adapter', ADAPTERS)),
    check('sources_region_check', inList('region', SOURCE_REGIONS)),
    check('sources_config_check', sql.raw('json_valid(config)')),
    check('sources_state_check', sql.raw('json_valid(state)')),
  ],
);

// 수집 실행 이력
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey(),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    itemsNew: integer('items_new').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    check('job_runs_status_check', inList('status', JOB_STATUSES)),
    index('idx_job_runs_source').on(t.sourceId, t.startedAt),
  ],
);

// 같은 작업의 중복 실행 방지
export const jobLocks = sqliteTable('job_locks', {
  name: text('name').primaryKey(),
  owner: text('owner').notNull(),
  lockedUntil: text('locked_until').notNull(),
});

// 수집 원문 (소스별 중복 제거)
export const rawItems = sqliteTable(
  'raw_items',
  {
    id: integer('id').primaryKey(),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id),
    externalId: text('external_id').notNull(),
    url: text('url'),
    title: text('title'),
    body: text('body'),
    lang: text('lang'),
    publishedAt: text('published_at'),
    fetchedAt: text('fetched_at').notNull().default(now),
    contentHash: text('content_hash').notNull(),
    keywordHit: text('keyword_hit', { enum: KEYWORD_HITS }),
    llmStatus: text('llm_status', { enum: LLM_STATUSES }).notNull().default('pending'),
    purgeAfter: text('purge_after'),
  },
  (t) => [
    check('raw_items_keyword_hit_check', inList('keyword_hit', KEYWORD_HITS)),
    check('raw_items_llm_status_check', inList('llm_status', LLM_STATUSES)),
    unique('raw_items_source_external_unique').on(t.sourceId, t.externalId),
    index('idx_raw_items_llm').on(t.llmStatus),
    index('idx_raw_items_purge').on(t.purgeAfter),
  ],
);

// 정규화된 행사
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey(),
    title: text('title').notNull(),
    kind: text('kind', { enum: EVENT_KINDS }).notNull(),
    officiality: text('officiality', { enum: OFFICIALITIES }).notNull(),
    region: text('region', { enum: EVENT_REGIONS }).notNull(),
    city: text('city'),
    venue: text('venue'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    ticketOpenAt: text('ticket_open_at'),
    ticketUrl: text('ticket_url'),
    status: text('status', { enum: EVENT_STATUSES }).notNull().default('announced'),
    parentEventId: integer('parent_event_id').references((): AnySQLiteColumn => events.id),
    summaryKo: text('summary_ko'),
    dedupKey: text('dedup_key').notNull().unique(),
    needsReview: integer('needs_review').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    check('events_kind_check', inList('kind', EVENT_KINDS)),
    check('events_officiality_check', inList('officiality', OFFICIALITIES)),
    check('events_region_check', inList('region', EVENT_REGIONS)),
    check('events_status_check', inList('status', EVENT_STATUSES)),
    index('idx_events_dates').on(t.startDate, t.status),
    index('idx_events_parent').on(t.parentEventId),
  ],
);

// 행사와 원문 연결 (출처 전부 보관)
export const eventSources = sqliteTable(
  'event_sources',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    rawItemId: integer('raw_item_id')
      .notNull()
      .references(() => rawItems.id),
    extracted: text('extracted').notNull(),
    confidence: real('confidence'),
    model: text('model'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.rawItemId] }),
    check('event_sources_extracted_check', sql.raw('json_valid(extracted)')),
  ],
);

// 상태·필드 변경 이력
export const eventStateLog = sqliteTable(
  'event_state_log',
  {
    id: integer('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    changedFields: text('changed_fields'),
    rawItemId: integer('raw_item_id').references(() => rawItems.id),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    check('event_state_log_changed_fields_check', sql.raw('changed_fields IS NULL OR json_valid(changed_fields)')),
    index('idx_state_log_event').on(t.eventId, t.createdAt),
  ],
);

// 알림 받을 대상 (디스코드 봇)
export const subscribers = sqliteTable(
  'subscribers',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    channel: text('channel', { enum: SUBSCRIBER_CHANNELS }).notNull(),
    target: text('target').notNull(),
    filters: text('filters').notNull().default('{}'),
    isAdmin: integer('is_admin').notNull().default(0),
    active: integer('active').notNull().default(1),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    check('subscribers_channel_check', inList('channel', SUBSCRIBER_CHANNELS)),
    check('subscribers_filters_check', sql.raw('json_valid(filters)')),
  ],
);

// 발송 기록 (같은 행사·상태·슬롯으로 두 번 보내지 않음)
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id),
    reason: text('reason', { enum: NOTIFICATION_REASONS }).notNull(),
    eventStatus: text('event_status').notNull(),
    message: text('message').notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: text('sent_at'),
    error: text('error'),
    slot: text('slot').notNull().default(''),
  },
  (t) => [
    check('notifications_reason_check', inList('reason', NOTIFICATION_REASONS)),
    check('notifications_status_check', inList('status', NOTIFICATION_STATUSES)),
    unique('notifications_dedup_unique').on(t.eventId, t.subscriberId, t.reason, t.eventStatus, t.slot),
    index('idx_notifications_status').on(t.status),
  ],
);

// 키워드 사전
export const keywords = sqliteTable(
  'keywords',
  {
    id: integer('id').primaryKey(),
    term: text('term').notNull().unique(),
    tier: text('tier', { enum: KEYWORD_TIERS }).notNull(),
    lang: text('lang'),
  },
  () => [check('keywords_tier_check', inList('tier', KEYWORD_TIERS))],
);

// LLM 호출 비용 추적
export const llmCalls = sqliteTable('llm_calls', {
  id: integer('id').primaryKey(),
  rawItemId: integer('raw_item_id').references(() => rawItems.id),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

// 첫 4주 누락 기록
export const misses = sqliteTable('misses', {
  id: integer('id').primaryKey(),
  eventId: integer('event_id').references(() => events.id),
  noticedAt: text('noticed_at').notNull(),
  firstSeenSource: text('first_seen_source'),
  caughtBySystem: integer('caught_by_system').notNull(),
  systemLagMin: integer('system_lag_min'),
  note: text('note'),
});

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type JobRun = typeof jobRuns.$inferSelect;
export type Keyword = typeof keywords.$inferSelect;
