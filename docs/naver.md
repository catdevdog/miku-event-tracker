# 네이버 검색 API 어댑터 명세 (NAVER API HUB)

출처: 네이버 클라우드 플랫폼 문서. 확인일은 2026-11-22이다.
- 공통 요청·응답: https://api.ncloud-docs.com/docs/naver-api-hub-overview
- 개발자센터에서 옮겨 올 때 바뀌는 점: https://guide.ncloud-docs.com/docs/apihub-migration
- 카페글 검색: https://api.ncloud-docs.com/docs/naver-api-hub-search-cafearticle

키는 네이버 클라우드 플랫폼 콘솔의 NAVER API HUB에서 발급받는다. 기존 개발자센터(openapi.naver.com) 키와 헤더는 여기서 쓸 수 없다.

## 요청

- 호스트: `https://naverapihub.apigw.ntruss.com`. HTTPS만 된다. HTTP로 호출하면 403이 난다.
- 인증 헤더:
    - `X-NCP-APIGW-API-KEY-ID`: Client ID (`NAVER_CLIENT_ID`)
    - `X-NCP-APIGW-API-KEY`: Client Secret (`NAVER_CLIENT_SECRET`)
- 경로: 모두 `GET`
    - 뉴스: `/search/v1/news`
    - 블로그: `/search/v1/blog`
    - 카페글: `/search/v1/cafearticle`
- 쿼리 파라미터:

| 이름 | 값 |
| --- | --- |
| query | 검색어. UTF-8로 URL 인코딩 |
| display | 1~100 (기본 10) |
| start | 1~1000 (기본 1) |
| sort | `sim`(정확도순, 기본) 또는 `date`(최신순) |
| format | `json`(기본) 또는 `xml` |

## 응답

- 최상위 필드: `lastBuildDate`, `total`, `start`, `display`, `items[]`
- `items`의 필드는 검색 종류마다 다르다. 첫 호출 응답을 종류별로 fixture로 저장하고, 그 필드를 기준으로 타입을 정의한다.
- `title`, `description`에는 강조용 `<b>` 태그가 들어 있을 수 있다. 키워드 판정 전에 태그를 제거한다.

## 오류

| HTTP | 코드 | 원인 | 처리 |
| --- | --- | --- | --- |
| 401 | | Client ID나 Secret이 틀렸거나, 해당 API를 구독하지 않음 | 관리자 경보 후 이번 실행 중단 |
| 403 | | HTTP로 호출함, 필수 파라미터가 없음, URL 인코딩 안 함 | 관리자 경보 |
| 429 | | 하루 호출 한도 초과 | 다음 날 0시(KST)까지 이 소스를 건너뛰고 관리자 경보 |
| 400 | SE02 / SE03 / SE04 / SE06 | display, start, sort 값 오류, 인코딩 오류 | 코드 버그로 보고 관리자 경보 |
| 404 | SE05 | 경로 오타 | 관리자 경보 |
| 500 | SE99 | 서버 오류 | 실패 1회로 집계하고 다음 주기에 재시도 |

## 호출량

- 문서에는 검색 API의 하루 호출 한도가 25,000회로 나와 있다.
- 우리 사용량은 검색어 5개 × 종류 3개 × 하루 24회 = 360회이다. 페이지를 넘기면 더 늘어난다.

## 수집 방식

1. 검색어와 종류 조합마다 `sort=date`, `display=100`, `start=1`로 호출한다.
2. 조합마다 직전 실행에서 가장 최근이었던 글을 `sources.state`에 저장해 둔다. 응답이 모두 그보다 새 글이면 `start`를 101, 201로 넘기고(최대 1000), 이미 본 글이 나오면 멈춘다.
3. 새 글은 `raw_items`에 넣는다. `external_id`는 `link`로 하고, `purge_after = fetched_at + 20일`로 둔다.
4. 키워드를 통과한 글은 `link`의 원문 페이지를 다시 가져와 그 본문을 LLM에 넘긴다. 네이버 검색 결과(title, description)는 LLM 입력에 넣지 않는다.
    - 카페글은 회원만 볼 수 있어 원문을 가져오지 못하는 경우가 있다. 그때는 LLM을 건너뛰고 관리 화면 검수 목록에 링크만 올린다.
5. 매일 1회 `purge_after`가 지난 행을 삭제한다.

## 구현 메모 (2026-11-23)

`src/adapters/naver.ts`, `src/pipeline/index.ts`, `src/pipeline/purge.ts`

- 응답 필드(문서 기준): 뉴스 `title, originallink, link, description, pubDate`(RFC 1123, +0900), 블로그 `title, link, description, bloggername, bloggerlink, postdate`(YYYYMMDD), 카페글 `title, link, description, cafename, cafeurl`(날짜 없음).
- fixture(`test/fixtures/naver/`)는 이 개발 환경에서 API에 접속할 수 없어 문서 필드로 만든 예시다. 운영에서 첫 응답을 받으면 실제 응답으로 바꾼다.
- 상태(`sources.state`): `combos["<종류>:<검색어>"].seen`에 최근 본 link 300개, 429 뒤에는 `blocked_until`(다음 날 0시 KST).
- 첫 실행: 조합마다 첫 페이지만 보고 최근 14일(`first_run_days`) 글만 낸다. 날짜가 없는 카페글은 기준점만 잡는다.
- 같은 link가 여러 검색어에 걸리면 한 번만 낸다(`external_id = link`).
- 오류 처리: 401·403·400·404는 `AlertNowError`(첫 실패에서 바로 관리자 경보), 500은 일반 실패(3회 연속이면 경보), 429는 그때까지 모은 글과 상태를 저장하고 다음 날 0시(KST)까지 건너뛴다.
- 키가 없으면(`NAVER_CLIENT_ID`·`NAVER_CLIENT_SECRET`) 실행마다 실패로 집계되고 3회째에 한 번 알린다.
- 원문 페이지: 블로그 `blog.naver.com/{id}/{logNo}`는 본문이 iframe 안에 있어 `PostView.naver?blogId=&logNo=`로 가져온다. 가져온 본문이 200자 미만이면(회원 전용 카페글 등) LLM을 건너뛰고 `llm_status='skipped'`로 둔다. 검수 목록에 링크를 올리는 것은 관리 화면(5단계)에서 붙인다.
- 삭제: 파이프라인 틱에서 하루 1회(job lock `purge_daily`, 24시간) `purge_after`가 지난 원문을 지운다. 원문을 가리키는 `event_sources`는 지우고, `event_state_log`·`llm_calls`는 `raw_item_id`만 비운다. 행사는 남는다.
- 공지·`/행사`의 원문 링크에는 네이버 검색 결과 link를 쓰지 않는다(기존 규칙).
