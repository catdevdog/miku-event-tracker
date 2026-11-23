# 미쿠 행사 트래커 (miku-event-tracker)

하츠네 미쿠 관련 공연과 공식 행사를 주기적으로 수집해 행사 단위로 DB에 쌓고, 조건에 맞는 행사를 디스코드 봇으로 공지한다.
범위는 국내 행사 알림 + 일본 행사 정보이다. 단독 공연, 서브컬처 행사 안의 부스·스테이지, 팝업·콜라보 카페, 라이브뷰잉, 굿즈 공지를 모두 포함하고, 프로세카와 허가받은 동인 공연도 포함한다.

구현 기준은 이 레포의 `CLAUDE.md`, `docs/`, `seed/`이다.
설계 문서(https://claude.ai/artifact/DYcuhNJB99tR7gaYXFJqAr)는 사람이 보는 요약본이고 Claude Code에서는 열 수 없다. 레포 파일 사이에 모순이 있으면 임의로 정하지 말고 보고한다.

## 확정 스택

| 영역 | 선택 |
| --- | --- |
| 런타임 | Node.js 24.17 이상, TypeScript, ESM. 로컬 개발은 Node 24, 배포 이미지(Playwright v1.65.1)는 Node 26 |
| 서버 | Express. 관리 API와 관리 화면 정적 파일을 같은 프로세스에서 제공 |
| 관리 화면 | React + Vite (`web/`) |
| 스케줄러 | node-cron (프로세스 안). `job_locks` 테이블로 같은 작업의 중복 실행 방지 |
| DB | SQLite. `@libsql/client` + `drizzle-orm/libsql`. `DATABASE_URL=file:/data/tracker.db` (Railway 볼륨). Turso로 옮길 때는 URL과 토큰만 교체 |
| 수집 | `rss-parser`, `fetch` + `cheerio`, `playwright`(컨테이너 안 chromium, 스크립트로 그리는 페이지만), 예매처는 `ticket` 어댑터(멜론티켓은 서버 렌더링이라 fetch), `@the-convocation/twitter-scraper`(X), 인스타그램 Graph API Business Discovery, KOPIS 오픈API(XML 응답, `fast-xml-parser`), 네이버 검색 API(API HUB) |
| LLM | `@anthropic-ai/sdk`. 기본 `claude-haiku-5-5`, 확신도가 낮을 때만 `claude-sonnet-5-5`. tool use로 JSON 스키마 강제 |
| 알림 | discord.js v14 봇. 공지 채널, 관리자 경보 채널, DM, 슬래시 명령. 공지와 명령 응답은 Components V2 카드로 보내고, 디스코드가 카드를 형식 오류(400)로 거부하면 같은 메시지의 임베드로 보낸다. 관리자 채널 검수 카드(승인·무시 버튼), 국내 행사 서버 예약 이벤트, 매주 월요일 이번 주 요약, 봇 멘션 질문 답변, 지역 알림 역할 구독(국내 기본), 행사별 공지 스레드, 개인 리마인더(DM), `/관리`·`/제보`·`/행사 검색`, 관리자 상태판도 봇이 맡는다. 봇이 준비 전이거나 발송에 실패하면 공지는 웹후크(`DISCORD_NOTICE_WEBHOOK_URL`, 선택)로 임베드를 보낸다. 관리자 경보는 웹후크로 보내지 않는다 |
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
    implemented.ts      구현된 어댑터 이름(IMPLEMENTED_ADAPTERS). registry.ts가 같은 키로 만든다(타입 강제)
    registry.ts         구현된 어댑터 목록(createAdapters). 없는 어댑터의 소스는 job_runs에 skipped로 남는다
    http.ts             fetch 래퍼, 해시, 상태 목록 관리
    rss.ts              RSS 2.0·RSS 1.0(RDF)·Atom
    htmlDiff.ts         새 링크·새 문단·새 JSON 행(json 모드: 사이트가 부르는 데이터 주소) 감지, 연도별 페이지(404→200) 감지
    render.ts           Playwright 렌더링 (config.render=true인 소스만)
    ticket.ts           예매처 (멜론티켓·YES24 검색·티켓 오픈 소식 구현, 티켓링크는 자동화 차단으로 제외, NOL은 보류. docs/ticket-sites.md)
    kopis.ts  xCrawl.ts
    naver.ts            네이버 검색 (docs/naver.md). 뉴스·블로그·카페글 × 검색어, 본 글이 나올 때까지 페이지 넘김
    instagram.ts        (6단계)
  pipeline/
    index.ts            1분마다: pending 원문 처리 → 시간 경과 상태 전이 → 리마인더 → 알림 발송 (job lock 'pipeline')
    keywordFilter.ts    keywords 테이블 기반 판정 (NFKC·소문자·공백 무시)
    links.ts            행동 링크(예매·예약·판매) 검사: 예매처·일반·소개 글 구분, 덮어쓰기 우선순위
    pageText.ts         본문이 짧은 링크 항목·네이버 항목의 원문 페이지 텍스트
    extract.ts          Claude 판정·추출 (tool use, strict 스키마 + zod 검증), 단가
    dedupSweep.ts       이미 등록된 행사끼리의 중복 검사 (Claude 확인 → dup_of_id)
    merge.ts            dedup_key 생성, 병합(제목 유사도 보조), parent_event_id 연결, 시간 경과 상태 갱신
    state.ts            상태 계산(앞으로만 진행) + event_state_log
    purge.ts            보관 기한(purge_after) 지난 원문 삭제 (파이프라인 틱에서 하루 1회, job lock 'purge_daily')
  notify/
    discord.ts          봇 클라이언트(로그인 재시도), 채널 발송(카드 → 거부 시 임베드), 슬래시 명령·버튼 처리, 봇 상태 메시지
    commands.ts         슬래시 명령 정의와 응답 (/ping /소스 /최근수집 /행사 /점검 /가이드 /제보 /관리, 메시지 우클릭 '행사 제보')
    interactions.ts     명령·자동완성·버튼·입력 창 처리 (index.ts가 봇에 연결)
    subscriptions.ts    지역 알림 역할(국내·일본·해외) 생성, 공지 채널 구독 패널, 멤버 전원 국내 역할 기본 부여, 버튼 토글
    noticeThreads.ts    공지 채널 발송: 새 행사는 역할 멘션 + 스레드, 상태 변경은 원래 카드 수정 + 스레드, 리마인더는 멘션 답장
    watchers.ts         개인 리마인더(🔔 알림 받기) → DM 구독자(filters {"watch":true})
    reports.ts          사용자 제보 → '사용자 제보' 소스(adapter manual) raw_items → 파이프라인, 결과를 관리자 카드·misses에
    statusBoard.ts      관리자 채널 고정 상태판 + 관리 패널 버튼 (10분마다 수정)
    adminPanel.ts       관리 패널: 버튼·선택 메뉴로 수집처·행사·키워드·알림 관리 (custom_id 'ad:…')
    guide.ts            /가이드 응답 (수집 주기·미수집 소스는 sources 설정에서 계산)
    cards.ts            Components V2 카드: 공지(예매·원문·캘린더 버튼), /행사(8건씩 페이지), /소스·/최근수집·/점검 묶음 카드
    labels.ts           표시용 라벨·아이콘·지역 색·지역 이미지 주소
    review.ts           검수 대기 행사 카드(관리자 채널) + [승인]·[무시] 처리
    guildEvents.ts      국내 행사 → 디스코드 서버 예약 이벤트 생성·수정·삭제
    weekly.ts           매주 월요일 09:00 KST 이번 주 행사 요약
    discordJobs.ts      봇 주기 작업: 검수 카드·제보 결과(1분), 역할·구독 패널·기본 구독·상태판·서버 이벤트·권한 점검(10분, 봇 준비 직후 1회), 주간 요약(월 09:00 KST, job lock 'weekly_digest')
    notifier.ts         공지(봇 → 웹후크 순) · 관리자 경보(봇 → 콘솔, 30분 중복 억제)
    webhook.ts          공지 채널 웹후크 발송
    format.ts           2000자 자르기, KST 표시
    planner.ts          알림 임베드 생성, notifications 큐 적재, subscribers.filters 매칭, 기본 구독자(공지 채널)
    reminders.ts        티켓 오픈·선예매 T-24h, T-1h, 🔔 켠 사람에게 전날·종료 3일 전 DM
    calendarImage.ts    월간 행사 달력 그림 (SVG → PNG)
    sender.ts           큐 발송 (공지 채널은 봇 → 웹후크, 실패 시 3회까지 재시도)
  services/             공용 조회 로직: status(상태), sources(/소스·/가이드), rawItems(/최근수집), events(/행사·검색 상세), diagnostics(/점검), qa(멘션 질문 답변), admin(/관리 DB 작업), settings(discord_settings). 추후 공개 웹도 여기를 쓴다
  admin/                Express 라우트(/api/admin/*): 소스 상태, 키워드, 행사 검수, misses 기록
web/                    관리 화면
assets/                 공지 임베드 하단 지역 이미지(region-kr/jp/overseas.png, 800×400 투명 PNG). GitHub raw 주소로 참조
drizzle/                마이그레이션 (npm run db:generate로 생성)
scripts/schema-diff.ts  docs/schema.sql과 마이그레이션 구조 비교 (npm run db:diff, test/schema.test.ts)
docs/schema.sql         DDL 정본 (SQLite 3.53에서 검증 완료)
docs/kopis.md           KOPIS 어댑터 명세 (원문 PDF는 docs/kopis/)
docs/naver.md           네이버 검색(NAVER API HUB) 어댑터 명세
docs/ticket-sites.md    예매처 요청 형식 (멜론·YES24 확인, 티켓링크·NOL 보류 사유)
seed/sources.json       소스 36개 (enabled=false 3개: 매지컬플레이 계정 미확인, NOL 보류, 티켓링크 제외)
seed/keywords.json      키워드 사전 (strong 22, weak 12, context 19, exclude 2)
test/fixtures/          어댑터 테스트용 실제 응답 샘플 (2026-11-22 수집, 일부는 명세 기반 예시라고 파일에 표시. kopis/, naver/는 명세 기반 예시)
```

## 핵심 규칙

1. 어댑터는 새 글만 반환한다. since_id, etag, 페이지 해시는 `sources.state`에 저장한다. 결과는 `raw_items`에 `(source_id, external_id)` 기준으로 upsert한다.
2. 키워드 필터를 통과한 글만 LLM으로 넘긴다. 매칭은 대소문자를 구분하지 않는다.
    - strong 1개 이상 → 통과
    - weak는 context와 같이 있을 때만 통과
    - exclude만 걸리고 strong이 없으면 버림
    - 통과하지 못한 글은 `llm_status='skipped'`
3. LLM 출력은 tool use의 input_schema로 강제한다. 필드: `is_relevant, title, kind, officiality, region, city, venue, start_date, end_date, ticket_open_at, ticket_url, presales, is_cancelled, sale_started, parent_event_hint, summary_ko, confidence`. enum 값은 schema.sql의 CHECK와 같게 맞춘다.
    - `is_cancelled`(취소 공지)와 `sale_started`(판매 중 명시)는 상태 계산에 쓰려고 추가한 필드다.
    - 본문이 500자 미만인 html_diff·rss 항목은 원문 페이지를 가져와 넘긴다.
    - 본문이 500자 미만인 html_diff·rss·ticket 항목이 키워드에서 떨어지면 원문 페이지로 한 번 더 판정한다. 행사 이름에 미쿠가 없고 출연진·타임테이블에만 있는 경우(예: 원더리벳 2026)를 잡기 위해서다. 항목 주소가 출처 페이지 자체(본문 비교·JSON 모드)면 다시 가져오지 않는다.
    - API 일시 오류(429·529·5xx)는 원문을 pending으로 두고 다음 틱에, 키·요청 오류(400·401·403·404)는 파이프라인을 멈추고 관리자 경보.
4. confidence가 0.7 미만이면 Sonnet으로 다시 판정한다(0.7은 초기값, 운영하며 조정). 그래도 낮으면 `needs_review=1`로 두고 알림을 보내지 않는다.
    - 검수 대기 행사는 관리자 채널에 카드로 올린다(`event_discord.review_message_id`로 한 번만). [승인]은 `needs_review=0` + 새 행사 알림, [무시]는 `needs_review=2`.
    - 확신 높은 출처가 같은 행사로 합쳐지면 1 → 0으로 풀고 새 행사로 알린다. 2(무시)는 풀지 않는다.
5. 병합 키: `dedup_key = normalize(title) + start_date + venue`. 키가 같으면 `event_sources`만 추가한다. 필드가 바뀌면 `event_state_log`에 changed_fields를 남긴다.
    - 출처마다 제목 표기가 달라 키가 어긋나는 경우를 위해, 같은 지역·같은 시작일(또는 시작일 미정) 행사 중 제목 유사도(글자 2개 묶음 Jaccard)가 0.5 이상(장소가 같으면 0.3, 시작일 미정이면 0.6)인 행사에 합친다.
    - 기존 행사의 제목은 바꾸지 않는다. 장소·일정·티켓 정보는 새 값이 있으면 덮어쓴다. 다른 출처의 제목 표기는 `events.aliases`에 남겨 다음 비교에 쓴다.
    - 시작일이 다르게 뽑혀도 기간이 겹치고 유사도 0.6 이상이면 합친다. 지역이 다르게 뽑혀도 시작일·장소가 같고 0.5 이상이면 합친다.
    - 제목으로 못 찾았으면(언어가 다른 제목 등) 새 행사를 만들기 직전에, 기간이 겹치고(하루 여유) 지역이나 장소가 같은 행사 최대 6건을 후보로 Claude(Haiku, `judge_same_event` 도구)에게 같은 행사인지 묻는다. 후보가 없으면 묻지 않는다. 비용은 `llm_calls`.
        - same + 확신 0.8 이상: 그 행사에 합친다(새로 알리지 않음).
        - same + 0.5~0.8: 새 행사를 `needs_review=1`, `dup_of_id=후보`로 만들고 알리지 않는다. 관리자 채널 카드에 [같은 행사로 합치기]·[별개 행사로 알리기]·[무시]가 뜬다. 관리자가 정할 때까지 다른 출처가 와도 풀지 않는다.
        - part_of: 따로 등록하고, 부스·무대(또는 상위 행사 힌트가 있는 것)면 `parent_event_id`로 연결한다.
    - 합치면(`/관리 합치기`, 검수 카드) 흡수한 행사의 제목·별칭을 남긴 행사의 별칭으로 옮기고, 아직 안 보낸 알림을 지우고, 공지 채널의 중복 공지를 지운다(스레드에는 안내 한 줄).
    - 행동 링크(`events.ticket_url`: 예매·사전예약·판매 페이지)는 `pipeline/links.ts`로 검사한다. 블로그·뉴스·SNS·커뮤니티 주소와 원문 자체 주소(예매처·KOPIS 출처 제외)는 넣지 않는다. 예매처 링크는 예매처 링크로만 바뀐다. 시작할 때 기존 데이터도 같은 기준으로 정리한다(`cleanupActionLinks`).
    - 이미 등록된 행사끼리의 중복은 `pipeline/dedupSweep.ts`가 검사한다(배포 후 한 번 자동, `/관리 중복검사`로 다시, 한 번에 Claude 호출 30건까지). 같다고 하면 나중 행사에 `dup_of_id`만 적고 관리자 채널에 [같은 행사로 합치기]·[별개 행사] 카드(`event_discord.dup_message_id`)를 올린다. 둘 다 공지된 행사라 자동으로 합치지 않는다. 다르다고 한 쌍과 관리자가 별개로 정한 쌍은 `event_distinct`에 적어 다시 묻지 않는다.
    - 일정이 연기·변경된 행사는 날짜가 달라 제목만으로는 못 찾으므로, 제목 유사도 0.75 이상·시작일 차이 120일 이내면 기간이 안 겹쳐도 Claude 확인 후보에 넣는다.
    - 기존 기간 안에 들어가는 일정(여러 날 행사의 하루만 적은 출처)으로는 기간을 줄이지 않는다. 같은 장소의 다른 언어 표기로는 장소를 바꾸지 않는다.
    - 유형(`kind`)은 concert·booth·stage·popup·cafe·exhibition·live_viewing(상영 포함)·goods·collab(브랜드·교통 콜라보)·other. 표시는 `labels.ts`(아이콘·버튼 문구·일정 줄 이름)에서 정한다.
        - 버튼: 예매처 링크이거나 공연·상영이면 '예매하기', 굿즈·콜라보는 '판매처 보기', 팝업·카페·전시는 '예약·안내 보기', 그 외 '공식 페이지'.
        - 티켓 줄은 공연·상영·무대이거나 티켓 오픈 시각이 있을 때만. 굿즈는 '발매', 팝업·카페·전시·콜라보는 '기간'. 굿즈·콜라보는 서버 예약 이벤트를 만들지 않는다.
        - `/행사 유형:`으로 묶음별 필터, `/관리 행사 동작:유형 변경`으로 수정, `/점검`에 유형별 건수.
6. 상태 전이: announced → ticket_scheduled → on_sale → ongoing → ended. cancelled는 어느 단계에서든 가능하다. 예매가 없는 팝업·카페·부스는 announced에서 바로 ongoing으로 간다.
7. 알림 시점:
    - 새 행사: reason=new (발견 시점 상태가 무엇이든. 단 이미 종료된 행사와 검수 대기 행사는 알리지 않음)
    - ticket_scheduled: 예매 일정 알림 + 리마인더 T-24h, T-1h (reason=reminder, slot 컬럼으로 구분)
    - ticket_scheduled, on_sale, cancelled로 바뀌면: 상태 변경 알림 (reason=status_change)
    - 구독자가 없으면 시작할 때 공지 채널(없으면 웹후크)을 기본 구독자로 만든다.
    - 공지 채널 알림은 행사 지역의 알림 역할(국내·일본·해외 행사 알림)을 멘션한다. 국내 역할은 서버 멤버 전원에게 한 번 준다(기본 구독, `discord_members`에 기록해 스스로 끈 사람에게 다시 주지 않음). 일본·해외는 공지 채널 고정 패널 버튼으로 각자 켠다. 멤버 목록은 REST(List Guild Members)로 읽으므로 Developer Portal의 Server Members Intent가 켜져 있어야 한다(게이트웨이 인텐트에는 넣지 않음).
    - 새 행사 공지에는 스레드를 연다(`event_discord.notice_message_id`, `notice_thread_id`). 상태 변경은 원래 카드를 지금 상태로 고치고 스레드에 쓴다(멘션 없음: 스레드 안 역할 멘션은 스레드에 들어온 사람에게만 확실히 감). 티켓 리마인더는 공지 채널에 역할 멘션 + 원래 카드 답장으로 보낸다. 봇이 없으면 웹후크(스레드·멘션 없음).
    - 공지 카드의 🔔 알림 받기(`event_watchers`): 누른 사람에게 그 행사의 리마인더·상태 변경만 DM으로. DM이 막혀 있으면(50007) 다시 시도하지 않고 그 사람의 DM 구독을 멈춘다(다시 누르면 재개).
    - ongoing, ended: 알림 없음
    - 중복 발송은 notifications의 유일 제약으로 막는다.
    - 일정·장소 변경: 기존 행사의 기간이 바뀌거나(미정 → 확정 포함) 장소가 다른 곳으로 바뀌면 reason=status_change, slot=`chg:<바뀐 값>`으로 알린다(같은 값은 한 번만). 공지 채널에서는 원래 카드를 고치고 스레드에 쓰며(멘션 없음), 🔔를 켠 사람에게는 DM. 표기만 다른 장소(다른 언어, 포함 관계, 글자 겹침 0.3 이상)는 변경으로 보지 않는다. `/관리 행사 수정`도 같은 경로.
    - 선예매·추첨 접수(`events.presales`, 추출 필드 `presales`): 카드에 줄로 보여 주고, 시작 24시간·1시간 전에 리마인더(slot `pre:<해시>:T-24h|T-1h`)를 보낸다. 이름이 같은 일정은 새 값으로 바꾸고 새 이름은 추가한다(5개까지).
    - 🔔를 켠 사람에게만 DM(공지 채널에는 안 보냄, 한국 시간 09~22시): 시작 전날(slot `D-1`), 팝업·카페·전시·콜라보가 끝나기 3일 전(slot `END-3`).
    - 굿즈·콜라보(`QUIET_KINDS`)는 공지 채널에 올리되 역할 멘션을 하지 않는다.
    - 참석 표시(`event_attendees`, 공지 카드 🙋 갈 거예요): 굿즈·콜라보 제외. 누르면 원래 공지 카드의 숫자를 고친다. `/내알림`에서 🔔·🙋 행사와 지역 구독 상태를 본다.
    - 매월 1일 09:00 KST에 그달 행사 달력 그림을 공지 채널에 올린다(`notify/calendarImage.ts`: SVG → PNG, `@resvg/resvg-js` + Noto Sans KR 글꼴 파일, job lock 'monthly_calendar', 행사가 없으면 생략, `/관리 달력`으로 바로 올리기).
    - 디스코드 REST는 전용 undici Agent(`discordRestOptions`)를 쓴다. cheerio 안의 undici 7이 전역 dispatcher를 먼저 차지하면 discord.js(undici 6)의 파일 첨부가 "action is not a function"으로 실패하기 때문이다(JSON 요청은 영향 없음). `undici`는 discord.js와 같은 6.x로 맞춘다.
    - 매주 월요일 09:00 KST에 지난 7일 제보 리포트(놓친 행사·이미 잡은 행사·관련 없음, 놓친 출처 사이트)를 관리자 채널에 올린다(제보가 없으면 생략).
    - 매주 월요일 09:00 KST에 이번 주에 열리는 행사·이번 주 티켓 오픈·지난 7일 새 행사를 공지 채널에 요약한다(없으면 보내지 않음).
    - 국내 확정 행사(발표·예매 예정·판매 중, 시작 전)는 디스코드 서버 예약 이벤트로도 만든다. 날짜만 있으므로 시작일 10:00~종료일 21:00(KST)로 넣고 설명에 표시용이라고 적는다. 취소되면 지운다. 봇 역할에 '이벤트 만들기' 권한이 필요하다(없으면 하루 한 번 경보).
8. DB 시각은 UTC ISO 문자열이고, 디스코드 표시는 Asia/Seoul로 한다.
9. 네이버 검색 어댑터는 `docs/naver.md`를 따른다(NAVER API HUB, HTTPS 전용, 429는 하루 한도 초과). 네이버 검색 결과는 새 글 감지용으로만 쓴다. LLM에는 원문 페이지를 다시 가져와 넘긴다. 약관상 서버 보관이 최대 21일이므로 `purge_after = fetched_at + 20일`로 두고 매일 삭제 작업을 돌린다.
10. X 크롤링:
    - 순서: 게스트 토큰 → 보조 계정 쿠키(`X_AUTH_TOKEN`, `X_CT0`) → Playwright로 프로필 페이지를 열어 GraphQL 응답 가로채기
    - 계정마다 1시간 간격에 ±10분 지터
    - 메인 계정 쿠키는 절대 쓰지 않는다.
    - 현재 구현은 게스트 → 쿠키 두 단계. Playwright 단계는 두 경로가 모두 막히는 경우가 생기면 추가한다.
11. 어댑터가 연속 3회 실패하면(`consecutive_failures >= 3`) 관리자 경보 채널로 한 번 알리고, 회복하면 회복 알림을 보낸다. 쿠키 만료도 같은 경로로 알린다.
    - 키 오류·구독 안 함·요청 형식 오류처럼 재시도해도 같은 오류는 어댑터가 `AlertNowError`로 던지고, 러너가 첫 실패에서 바로 알린다(같은 문구는 30분 중복 억제).
12. boost 주기: L2 소스에 연결된 행사의 start_date가 60일 이내이면 `boost_interval_min`을 쓴다.
13. LLM 호출마다 `llm_calls`에 토큰 수와 비용을 기록한다. 100만 토큰당 단가: Haiku 5.5 입력 $0.10·출력 $0.50(10만 토큰 이하 프롬프트 기준), Sonnet 5.5 입력 $2·출력 $10. 단가는 `pipeline/extract.ts`의 PRICING에 있다.
14. `seed/sources.json`에서 `enabled=false`이거나 `target="TODO"`인 소스는 스케줄러에 올리지 않는다. `/관리 소스 멈춤`은 `sources.paused`(시드가 덮어쓰지 않음)를 쓰고, `/관리 키워드 삭제`는 `keywords.disabled`를 쓴다. 재배포해도 유지된다.
    - `/관리 합치기`는 흡수한 행사를 숨기고(needs_review=2) `merged_into`로 남긴 행사를 가리킨다. 병합 조회(`findExistingEvent`)는 merged_into를 따라가 새 출처도 남긴 행사에 붙인다.
    - `/관리`는 서버 관리 권한(Manage Server)만 보이고 쓸 수 있다(명령 기본 권한 + 서버 쪽 확인). 검수 승인·무시 버튼도 같은 권한을 확인한다.
    - 관리 패널: 관리자 채널에 고정된 상태판 아래 버튼(수집처·행사·키워드·알림 일시정지·설정 점검·중복검사·달력·점검·새로고침)으로 `/관리`와 같은 일을 한다. 구현은 `interactions.ts`의 `ops`를 명령과 같이 쓴다. 패널 버튼은 누른 사람에게만 보이는 화면을 열고, 그 안의 선택 메뉴·버튼이 화면을 바꿔 가며 진행한다. 선택 메뉴는 25개까지라 수집처·키워드는 여러 메뉴로 나누고(문제 있는 수집처 먼저), 행사는 최근 25건 + 이름 찾기(입력 창)를 쓴다. 합치기는 확인 화면을 한 번 거친다. 버튼·선택도 2초 안에 안 끝나면 응답을 미뤄 둔다.
    - 명령·버튼·입력 창 처리 중 오류는 누른 사람에게 디스코드 오류 문구를 보여 주고 관리자 경보로도 남긴다. 2초 안에 끝나지 않는 명령은 응답을 미뤄 두고(deferReply) 끝나면 고친다(디스코드 3초 제한).
    - 기본 구독은 봇 역할이 알림 역할보다 아래면 시도하지 않고 순서 변경을 안내한다. 한 멤버가 실패해도 나머지는 계속하고(실패한 사람은 다음 실행에 다시 시도), 처음 3명이 모두 실패하면 멈춘다. `/관리 설정`이 이번 실행 결과(부여 수·실패 사유)를 바로 보여 준다.
    - 사용자 제보(`/제보`, 메시지 우클릭 '행사 제보')는 '사용자 제보' 소스(adapter `manual`, 스케줄러에 안 올림)의 raw_items로 넣고 키워드 판정을 건너뛰어 Claude 판정으로 보낸다. 같은 사람 1분 1건, 전체 하루 30건.
15. KOPIS 어댑터는 `docs/kopis.md`를 따른다. 요점:
    - 조회 기간이 최대 31일이므로 31일 창으로 나눠 스캔한다.
    - `afterdate`로 증분 수집한다.
    - 제목은 로컬에서 키워드로 판정한다(`implicit_context`).
    - 상세의 예매처 목록(`relates`)은 `ticket_url`에 채운다.
    - KOPIS만으로 on_sale을 만들지 않는다.
16. 첫 실행 처리: 기존 글이 전부 새 소식으로 잡히지 않도록 한다.
    - html_diff: 첫 실행은 기준점만 기록하고 항목을 내지 않는다(links·text·json 모드 모두).
    - rss, x_crawl: 첫 실행은 최근 30일 글만 낸다.
    - naver: (검색어, 종류) 조합마다 첫 실행은 첫 페이지 중 최근 14일 글만 낸다. 날짜가 없는 카페글은 기준점만 잡는다.
    - ticket, kopis: 검색 결과가 미쿠 관련으로 좁혀져 있으므로 전부 낸다(지난 행사는 파이프라인에서 ended로 판정).

## 환경 변수

```
DATABASE_URL=file:/data/tracker.db
TURSO_AUTH_TOKEN=                 # Turso로 옮길 때만
ANTHROPIC_API_KEY=                # Max 크레딧이 연결된 Console 조직에서 발급
DISCORD_BOT_TOKEN=                # 있으면 봇을 켠다. 이때 아래 4개 ID도 필수
DISCORD_APP_ID=
DISCORD_GUILD_ID=
DISCORD_NOTICE_CHANNEL_ID=
DISCORD_ADMIN_CHANNEL_ID=
DISCORD_NOTICE_WEBHOOK_URL=       # 선택. 공지 채널 웹후크 (커밋 금지)
NOTIFY_PAUSED=                    # 선택. 1이면 알림을 큐에만 쌓고 보내지 않음
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
5. 관리 화면: 소스 상태, needs_review 검수, misses 기록 → 디스코드로 대체(`/소스`·`/점검`·상태판, 검수 카드, `/관리`, 제보 결과가 misses에 기록)
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
2. 디스코드 봇 멘션 질의 (구현됨: `services/qa.ts`, `notify/discord.ts`)
    - 봇을 멘션해 질문하면 DB의 행사 정보로 답한다(예: "이번 달 국내 미쿠 행사 뭐 있어?"). Haiku, 같은 사람 15초에 한 번, 동시 2건, 호출 비용은 `llm_calls`(raw_item_id 없음).
    - 행사 조회 로직은 `src/services/`에 두고, 슬래시 명령, 멘션 질의, 공개 API가 같은 함수를 쓴다.
    - 답변 생성에는 `events`만 쓴다(확정 행사, 다가오는 것 + 최근 60일 안에 끝난 것). 네이버 검색 결과(raw_items)는 약관상 AI 답변 생성에 쓸 수 없으므로 넣지 않는다.
    - 봇은 GuildMessages 인텐트만 쓴다. 봇을 멘션한 메시지는 MessageContent(특권) 없이도 본문이 온다.

## 아직 확인되지 않은 것

- 인스타그램 대상 계정이 비즈니스·크리에이터 계정인지
- 팝가 검색·목록 URL (AGF 공식 사이트는 www.agfkorea.com, 데이터 주소는 seed/sources.json에 기록)
- 매지컬플레이 공식 채널 (프로세카 한국 서버는 X @kr_pjsekai 확인: 한국 App Store 앱 설명에 적힌 계정. 인스타그램은 미확인)
- NOL 티켓 검색 주소 (멜론·YES24는 확인 완료, 티켓링크는 자동화 차단으로 쓰지 않음. docs/ticket-sites.md)
- KOPIS: https 동작 여부, 오류 응답 형식, `afterdate`와 기간 파라미터를 같이 쓸 때의 동작, `relates` 하위 요소 구조
- 알림 조건 중 유형·공식성 등급(유형별 멘션 구분은 실제 유형 분포를 본 뒤 결정). 지역은 알림 역할 구독으로 정했다(국내 기본, 일본·해외 선택). 공지 채널에는 모든 확정 행사가 올라가고 멘션만 지역 역할로 나뉜다.
- 봇 권한(운영 확인 필요): 서버 전체는 역할 관리(봇 역할이 알림 역할보다 위)·이벤트 만들기, 공지 채널은 채널 보기·메시지 보내기·링크 첨부·메시지 기록 보기(답장에 필요)·공개 스레드 만들기·스레드에서 메시지 보내기·메시지 고정. 부족하면 하루 한 번 관리자 경보. 구독 패널을 못 올려도 역할·기본 구독은 계속 진행하고, 봇이 공지 채널에 못 써서 웹후크로 돌리면 관리자 경보를 보낸다.
