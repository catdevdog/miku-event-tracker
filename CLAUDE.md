# 미쿠 행사 트래커 (miku-event-tracker)

하츠네 미쿠 관련 공연과 공식 행사를 주기적으로 수집해 행사 단위로 DB에 쌓고, 조건에 맞는 행사를 디스코드 봇으로 공지한다.
범위는 국내 행사 알림 + 일본 행사 정보이다. 단독 공연, 서브컬처 행사 안의 부스·스테이지, 팝업·콜라보 카페, 라이브뷰잉, 굿즈 공지를 모두 포함하고, 프로세카와 허가받은 동인 공연도 포함한다.

구현 기준은 이 레포의 `CLAUDE.md`, `docs/`, `seed/`이다.
설계 문서(https://claude.ai/artifact/DYcuhNJB99tR7gaYXFJqAr)는 사람이 보는 요약본이고 Claude Code에서는 열 수 없다. 레포 파일 사이에 모순이 있으면 임의로 정하지 말고 보고한다.

## 확정 스택

| 영역 | 선택 |
| --- | --- |
| 런타임 | Node.js 24.17 이상 (discord.js 요구 사항), TypeScript, ESM. 로컬 개발은 Node 24, 배포 이미지(Playwright v1.65.1)는 Node 26 |
| 서버 | Express. 관리 API와 관리 화면 정적 파일을 같은 프로세스에서 제공 |
| 관리 화면 | React + Vite (`web/`) |
| 스케줄러 | node-cron (프로세스 안). `job_locks` 테이블로 같은 작업의 중복 실행 방지 |
| DB | SQLite. `@libsql/client` + `drizzle-orm/libsql`. `DATABASE_URL=file:/data/tracker.db` (Railway 볼륨). Turso로 옮길 때는 URL과 토큰만 교체 |
| 수집 | `rss-parser`, `fetch` + `cheerio`, `playwright`(컨테이너 안 chromium), `@the-convocation/twitter-scraper`(X), 인스타그램 Graph API Business Discovery, KOPIS 오픈API(XML 응답, `fast-xml-parser`), 네이버 검색 API(API HUB) |
| LLM | `@anthropic-ai/sdk`. 기본 `claude-haiku-5-5`, 확신도가 낮을 때만 `claude-sonnet-5-5`. tool use로 JSON 스키마 강제 |
| 알림 | discord.js v14 봇. 공지 채널, 관리자 경보 채널, DM, 슬래시 명령 |
| 배포 | Railway Hobby, Docker 1개 (Playwright 공식 이미지 기반), 볼륨 `/data`. 헬스체크 경로 `/health`는 Railway 대시보드에서 설정한다(railway.json 같은 Config as Code는 Railway에서 폐기 예정이라 쓰지 않음) |
| 개발 | NAS DevBox. 단 DevBox 컨테이너에는 chromium을 설치할 수 없으므로 Playwright 어댑터는 로컬 PC나 Railway에서 테스트 |

## 디렉터리 구조

```
src/
  index.ts              부트스트랩: 마이그레이션 → 시드 → 스케줄러 → 디스코드 봇 → Express
  config.ts             환경 변수 파싱 (zod)
  db/schema.ts          drizzle 스키마. docs/schema.sql과 1:1로 맞춘다
  db/client.ts
  db/seed.ts            seed/*.json을 sources·keywords에 upsert (name, term 기준)
  scheduler/            1분 틱으로 차례가 된 소스 실행(runner), job lock, boost 주기·X 지터 계산(due)
  adapters/
    types.ts            interface SourceAdapter { run(source, ctx): Promise<{ items: RawItemInput[]; state? }> }
    registry.ts         구현된 어댑터 목록. 없는 어댑터의 소스는 job_runs에 skipped로 남는다
    rss.ts  htmlDiff.ts  playwright.ts  xCrawl.ts  instagram.ts  kopis.ts  naver.ts
  pipeline/
    keywordFilter.ts    keywords 테이블 기반 판정
    extract.ts          Claude 판정·추출 (tool use)
    merge.ts            dedup_key 생성, 병합, parent_event_id 연결
    state.ts            상태 전이 + event_state_log
  notify/
    discord.ts          봇 클라이언트, 발송, 슬래시 명령
    planner.ts          notifications 생성, subscribers.filters 매칭
    reminders.ts        ticket_open_at 기준 T-24h, T-1h
  services/             행사 조회 등 공용 로직 (디스코드 명령, 관리 화면, 추후 공개 웹이 같이 씀)
  admin/                Express 라우트(/api/admin/*): 소스 상태, 키워드, 행사 검수, misses 기록
web/                    관리 화면
drizzle/                마이그레이션 (npm run db:generate로 생성)
scripts/schema-diff.ts  docs/schema.sql과 마이그레이션 구조 비교 (npm run db:diff, test/schema.test.ts)
docs/schema.sql         DDL 정본 (SQLite 3.53에서 검증 완료)
docs/kopis.md           KOPIS 어댑터 명세 (원문 PDF는 docs/kopis/)
docs/naver.md           네이버 검색(NAVER API HUB) 어댑터 명세
seed/sources.json       초기 소스 32개 (enabled=false 3개는 URL·계정 미확인)
seed/keywords.json      키워드 사전 (strong 21, weak 12, context 15, exclude 2)
```

## 핵심 규칙

1. 어댑터는 새 글만 반환한다. since_id, etag, 페이지 해시는 `sources.state`에 저장한다. 결과는 `raw_items`에 `(source_id, external_id)` 기준으로 upsert한다.
2. 키워드 필터를 통과한 글만 LLM으로 넘긴다. 매칭은 대소문자를 구분하지 않는다.
    - strong 1개 이상 → 통과
    - weak는 context와 같이 있을 때만 통과
    - exclude만 걸리고 strong이 없으면 버림
    - 통과하지 못한 글은 `llm_status='skipped'`
3. LLM 출력은 tool use의 input_schema로 강제한다. 필드: `is_relevant, title, kind, officiality, region, city, venue, start_date, end_date, ticket_open_at, ticket_url, parent_event_hint, summary_ko, confidence`. enum 값은 schema.sql의 CHECK와 같게 맞춘다.
4. confidence가 0.7 미만이면 Sonnet으로 다시 판정한다(0.7은 초기값, 운영하며 조정). 그래도 낮으면 `needs_review=1`로 두고 알림을 보내지 않는다.
5. 병합 키: `dedup_key = normalize(title) + start_date + venue`. 키가 같으면 `event_sources`만 추가한다. 필드가 바뀌면 `event_state_log`에 changed_fields를 남긴다.
6. 상태 전이: announced → ticket_scheduled → on_sale → ongoing → ended. cancelled는 어느 단계에서든 가능하다. 예매가 없는 팝업·카페·부스는 announced에서 바로 ongoing으로 간다.
7. 알림 시점:
    - announced: 새 행사 알림 (reason=new)
    - ticket_scheduled: 예매 일정 알림 + 리마인더 T-24h, T-1h (reason=reminder, slot 컬럼으로 구분)
    - on_sale, cancelled: 상태 변경 알림
    - ongoing, ended: 알림 없음
    - 중복 발송은 notifications의 유일 제약으로 막는다.
    - 일정·장소 변경 알림은 알림 조건과 함께 나중에 정한다. 지금은 로그만 남긴다.
8. DB 시각은 UTC ISO 문자열이고, 디스코드 표시는 Asia/Seoul로 한다.
9. 네이버 검색 어댑터는 `docs/naver.md`를 따른다(NAVER API HUB, HTTPS 전용, 429는 하루 한도 초과). 네이버 검색 결과는 새 글 감지용으로만 쓴다. LLM에는 원문 페이지를 다시 가져와 넘긴다. 약관상 서버 보관이 최대 21일이므로 `purge_after = fetched_at + 20일`로 두고 매일 삭제 작업을 돌린다.
10. X 크롤링:
    - 순서: 게스트 토큰 → 보조 계정 쿠키(`X_AUTH_TOKEN`, `X_CT0`) → Playwright로 프로필 페이지를 열어 GraphQL 응답 가로채기
    - 계정마다 1시간 간격에 ±10분 지터
    - 메인 계정 쿠키는 절대 쓰지 않는다.
11. 어댑터가 연속 3회 실패하면(`consecutive_failures >= 3`) 관리자 경보 채널로 한 번 알리고, 회복하면 회복 알림을 보낸다. 쿠키 만료도 같은 경로로 알린다.
12. boost 주기: L2 소스에 연결된 행사의 start_date가 60일 이내이면 `boost_interval_min`을 쓴다.
13. LLM 호출마다 `llm_calls`에 토큰 수와 비용을 기록한다. Haiku 5.5 단가는 입력 100만 토큰당 $0.10, 출력 100만 토큰당 $0.50이다(10만 토큰 이하 프롬프트 기준).
14. `seed/sources.json`에서 `enabled=false`이거나 `target="TODO"`인 소스는 스케줄러에 올리지 않는다.
15. KOPIS 어댑터는 `docs/kopis.md`를 따른다. 요점:
    - 조회 기간이 최대 31일이므로 31일 창으로 나눠 스캔한다.
    - `afterdate`로 증분 수집한다.
    - 제목은 로컬에서 키워드로 판정한다(`implicit_context`).
    - 상세의 예매처 목록(`relates`)은 `ticket_url`에 채운다.
    - KOPIS만으로 on_sale을 만들지 않는다.

## 환경 변수

```
DATABASE_URL=file:/data/tracker.db
TURSO_AUTH_TOKEN=                 # Turso로 옮길 때만
ANTHROPIC_API_KEY=                # Max 크레딧이 연결된 Console 조직에서 발급
DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
DISCORD_GUILD_ID=
DISCORD_NOTICE_CHANNEL_ID=
DISCORD_ADMIN_CHANNEL_ID=
KOPIS_SERVICE_KEY=
NAVER_CLIENT_ID=                  # NAVER API HUB Client ID → 헤더 X-NCP-APIGW-API-KEY-ID
NAVER_CLIENT_SECRET=              # NAVER API HUB Client Secret → 헤더 X-NCP-APIGW-API-KEY
X_AUTH_TOKEN=                     # 보조 계정 쿠키
X_CT0=
IG_USER_ID=                       # 내 프로페셔널 계정
IG_ACCESS_TOKEN=
ADMIN_BASIC_AUTH=user:password    # 관리 화면 보호
TZ=UTC
```

## 구현 순서 (MVP)

1. 뼈대: package.json, tsconfig, Dockerfile, drizzle 스키마와 마이그레이션(docs/schema.sql 기준), 시드, config, 스케줄러와 락, `/health`
2. 디스코드 봇: 로그인, 공지 채널 발송, 관리자 경보, `/ping`
3. L1 + L3 어댑터: htmlDiff, rss, xCrawl, kopis, 예매처 4곳(playwright)
4. 파이프라인: keywordFilter → extract → merge → state → planner → reminders
5. 관리 화면: 소스 상태, needs_review 검수, misses 기록
6. L2·L4: instagram, 서브컬처 행사 사이트, naver
7. 실데이터 검증: AGF 2026(12월 4~6일, 킨텍스)의 공개된 부스 배치도로 L2 부스 매칭 확인

각 단계가 끝나면 테스트를 돌리고 결과를 보고한 뒤 다음 단계로 넘어간다.

## 테스트

- vitest
- 어댑터: 저장해 둔 HTML·JSON fixture로 단위 테스트. 실제 사이트 호출은 테스트에 넣지 않는다.
- 키워드 필터: '나카노 미쿠'만 있는 글은 버림, '미쿠 팝업'은 weak + context로 통과, '하츠네 미쿠'는 strong으로 통과
- 상태 전이, 리마인더 두 번 발송, 중복 발송 차단

## 금지

- 메인 X 계정 쿠키 사용
- 네이버 검색 결과를 LLM 입력으로 쓰거나 21일 넘게 보관
- 실패를 삼키고 다음으로 넘어가기. 실패는 job_runs와 관리자 경보에 남긴다.
- 시크릿을 커밋하거나 로그에 출력

## 추후 기능 (세부 기획 미정, 지금은 구현하지 않음)

1. 웹 열람 페이지
    - 사용자가 웹에서 행사 목록과 상세를 볼 수 있게 한다. UI/UX와 세부 기획은 미정이다.
    - 지금부터 지킬 것: 관리 화면과 관리 API는 `/admin`, `/api/admin/*`(Basic Auth) 아래에만 둔다. 공개 읽기 API(`/api/public/*`)와 공개 페이지 경로는 비워 둔다.
2. 디스코드 봇 멘션 질의
    - 봇을 멘션해 질문하면 DB의 행사 정보로 답한다(예: "이번 달 국내 미쿠 행사 뭐 있어?").
    - 지금부터 지킬 것: 행사 조회 로직은 `src/services/`처럼 디스코드·웹과 분리된 곳에 두고, 슬래시 명령, 멘션 질의, 공개 API가 같은 함수를 쓰게 한다.
    - 답변 생성에는 `events`와 공식 출처만 쓴다. 네이버 검색 결과(raw_items)는 약관상 AI 답변 생성에 쓸 수 없으므로 넣지 않는다.

## 아직 확인되지 않은 것

- PR TIMES 크립톤 기업 페이지(company_id 52709)의 RSS 제공 여부
- 유튜브 39ch 채널 ID (첫 실행 때 페이지에서 추출)
- 인스타그램 대상 계정이 비즈니스·크리에이터 계정인지
- AGF 공식 사이트 URL, 팝가 검색·목록 URL
- 프로세카 한국 서버(운영사 뉴버스) 공식 계정, 매지컬플레이 공식 채널
- 예매처 4곳이 내부적으로 쓰는 JSON 요청 (찾으면 Playwright 대신 fetch로 교체)
- KOPIS: https 동작 여부, 오류 응답 형식, `afterdate`와 기간 파라미터를 같이 쓸 때의 동작, `relates` 하위 요소 구조
- 알림 조건(지역·유형·공식성 등급). 정해지기 전까지는 모든 확정 행사를 공지 채널로 보낸다.
