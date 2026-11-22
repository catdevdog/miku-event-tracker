-- 미쿠 행사 트래커 DB 스키마 (SQLite / libSQL)
-- 시각은 모두 UTC ISO-8601 문자열, JSON 컬럼은 json_valid로 검증

PRAGMA foreign_keys = ON;

-- 감시 대상 소스
CREATE TABLE sources (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT    NOT NULL UNIQUE,          -- 시드 기준 키
  layer                TEXT    NOT NULL CHECK (layer IN ('L1','L2','L3','L4')),
  adapter              TEXT    NOT NULL CHECK (adapter IN ('rss','html_diff','playwright','x_crawl','instagram','kopis','naver','ticket','manual')),  -- manual: 사용자 제보(스케줄러에 올리지 않음)
  target               TEXT    NOT NULL,                 -- URL, X 핸들, 인스타 계정, 검색어
  region               TEXT    NOT NULL CHECK (region IN ('KR','JP','GLOBAL')),
  interval_min         INTEGER NOT NULL,                 -- 평시 주기
  boost_interval_min   INTEGER,                          -- 연결된 행사 60일 전부터 쓰는 주기
  config               TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(config)),  -- 셀렉터, 검색어 목록 등
  state                TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(state)),   -- since_id, etag, 페이지 해시
  enabled              INTEGER NOT NULL DEFAULT 1,
  paused               INTEGER NOT NULL DEFAULT 0,        -- /관리에서 멈춤 (시드가 덮어쓰지 않음)
  last_run_at          TEXT,
  last_success_at      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 수집 실행 이력
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES sources(id),
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('running','ok','error','skipped')),
  items_new   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX idx_job_runs_source ON job_runs(source_id, started_at);

-- 같은 작업의 중복 실행 방지
CREATE TABLE job_locks (
  name         TEXT PRIMARY KEY NOT NULL,
  owner        TEXT NOT NULL,
  locked_until TEXT NOT NULL
);

-- 수집 원문 (소스별 중복 제거)
CREATE TABLE raw_items (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES sources(id),
  external_id  TEXT    NOT NULL,                         -- 트윗 ID, URL, 페이지 해시
  url          TEXT,
  title        TEXT,
  body         TEXT,
  lang         TEXT,
  published_at TEXT,
  fetched_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  content_hash TEXT    NOT NULL,
  keyword_hit  TEXT    CHECK (keyword_hit IN ('strong','weak','none')),
  llm_status   TEXT    NOT NULL DEFAULT 'pending' CHECK (llm_status IN ('pending','done','skipped','error')),
  purge_after  TEXT,                                     -- 네이버 검색 원본은 21일 안에 삭제
  UNIQUE (source_id, external_id)
);
CREATE INDEX idx_raw_items_llm ON raw_items(llm_status);
CREATE INDEX idx_raw_items_purge ON raw_items(purge_after);

-- 정규화된 행사
CREATE TABLE events (
  id              INTEGER PRIMARY KEY,
  title           TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('concert','booth','stage','popup','cafe','exhibition','live_viewing','goods','other')),
  officiality     TEXT    NOT NULL CHECK (officiality IN ('crypton','licensed','permitted_doujin','unverified')),
  region          TEXT    NOT NULL CHECK (region IN ('KR','JP','OTHER')),
  city            TEXT,
  venue           TEXT,
  start_date      TEXT,
  end_date        TEXT,
  ticket_open_at  TEXT,
  ticket_url      TEXT,
  status          TEXT    NOT NULL DEFAULT 'announced' CHECK (status IN ('announced','ticket_scheduled','on_sale','ongoing','ended','cancelled')),
  parent_event_id INTEGER REFERENCES events(id),         -- AGF 같은 상위 행사 안의 부스·스테이지
  summary_ko      TEXT,
  dedup_key       TEXT    NOT NULL UNIQUE,               -- 정규화 행사명 + 시작일 + 장소
  needs_review    INTEGER NOT NULL DEFAULT 0,            -- 0 확정, 1 검수 대기(LLM 확신도 낮음), 2 검수에서 무시
  merged_into     INTEGER REFERENCES events(id),         -- /관리 합치기로 흡수된 행사 → 남긴 행사 (새 출처도 그쪽으로)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_dates ON events(start_date, status);
CREATE INDEX idx_events_parent ON events(parent_event_id);

-- 행사와 원문 연결 (출처 전부 보관)
CREATE TABLE event_sources (
  event_id    INTEGER NOT NULL REFERENCES events(id),
  raw_item_id INTEGER NOT NULL REFERENCES raw_items(id),
  extracted   TEXT    NOT NULL CHECK (json_valid(extracted)),  -- LLM 추출 결과
  confidence  REAL,
  model       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, raw_item_id)
);

-- 상태·필드 변경 이력
CREATE TABLE event_state_log (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  from_status    TEXT,
  to_status      TEXT    NOT NULL,
  changed_fields TEXT    CHECK (changed_fields IS NULL OR json_valid(changed_fields)),
  raw_item_id    INTEGER REFERENCES raw_items(id),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_state_log_event ON event_state_log(event_id, created_at);

-- 행사별 디스코드 연동 상태: 관리자 채널 검수 카드, 서버 예약 이벤트
CREATE TABLE event_discord (
  event_id          INTEGER PRIMARY KEY REFERENCES events(id),
  review_channel_id TEXT,                                -- 검수 카드를 올린 채널
  review_message_id TEXT,                                -- 검수 카드 메시지 (있으면 다시 올리지 않음)
  reviewed_by       TEXT,                                -- 승인·무시한 디스코드 사용자 ID
  reviewed_at       TEXT,
  guild_event_id    TEXT,                                -- 디스코드 서버 예약 이벤트 ID
  guild_event_hash  TEXT,                                -- 마지막으로 반영한 제목·일정·장소 해시
  notice_message_id TEXT,                                -- 공지 채널의 첫 공지 메시지 (상태가 바뀌면 이 카드를 고친다)
  notice_thread_id  TEXT,                                -- 그 공지에 단 스레드 (상태 변경 소식을 여기에 쓴다)
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 알림 받을 대상 (디스코드 봇)
CREATE TABLE subscribers (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  channel    TEXT    NOT NULL CHECK (channel IN ('discord_channel','discord_dm')),
  target     TEXT    NOT NULL,                           -- 디스코드 채널 ID 또는 사용자 ID (봇 토큰은 환경 변수)
  filters    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(filters)),  -- 알림 조건 (미정이라 JSON)
  is_admin   INTEGER NOT NULL DEFAULT 0,                 -- 수집 장애 경보 수신
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 발송 기록 (같은 행사·상태로 두 번 보내지 않음)
CREATE TABLE notifications (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  reason        TEXT    NOT NULL CHECK (reason IN ('new','status_change','reminder')),
  event_status  TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  error         TEXT,
  slot          TEXT    NOT NULL DEFAULT '',             -- 리마인더 구분: 'T-24h', 'T-1h'
  UNIQUE (event_id, subscriber_id, reason, event_status, slot)
);
CREATE INDEX idx_notifications_status ON notifications(status);

-- 키워드 사전
CREATE TABLE keywords (
  id   INTEGER PRIMARY KEY,
  term TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL CHECK (tier IN ('strong','weak','context','exclude')),
  lang TEXT,
  disabled INTEGER NOT NULL DEFAULT 0                    -- /관리에서 삭제한 키워드 (시드가 다시 켜지 않음)
);

-- LLM 호출 비용 추적
CREATE TABLE llm_calls (
  id            INTEGER PRIMARY KEY,
  raw_item_id   INTEGER REFERENCES raw_items(id),
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 첫 4주 누락 기록 (X API 추가 여부 판단용)
CREATE TABLE misses (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER REFERENCES events(id),
  noticed_at         TEXT    NOT NULL,
  first_seen_source  TEXT,                               -- 사람이 처음 본 출처
  caught_by_system   INTEGER NOT NULL,                   -- 0 또는 1
  system_lag_min     INTEGER,                            -- 시스템이 늦은 시간(분)
  note               TEXT
);

-- 디스코드 봇 설정값: 알림 역할 ID, 구독 패널·상태판 메시지 ID, 알림 일시정지
CREATE TABLE discord_settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 기본 구독(국내 알림 역할)을 한 번 준 서버 멤버. 스스로 해제한 사람에게 다시 주지 않는다.
CREATE TABLE discord_members (
  user_id        TEXT PRIMARY KEY NOT NULL,
  initialized_at TEXT NOT NULL
);

-- 행사별 개인 리마인더(🔔 알림 받기)
CREATE TABLE event_watchers (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  user_id    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

-- 사용자 제보. 원문은 raw_items(사용자 제보 소스, adapter='manual')로 파이프라인에 들어간다.
CREATE TABLE reports (
  id               INTEGER PRIMARY KEY,
  raw_item_id      INTEGER REFERENCES raw_items(id),
  url              TEXT,
  note             TEXT,
  reporter_id      TEXT NOT NULL,
  admin_message_id TEXT,                                 -- 관리자 채널 제보 카드
  result           TEXT,                                 -- 판정 결과 요약
  resolved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
