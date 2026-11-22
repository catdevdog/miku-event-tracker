# KOPIS 오픈API 어댑터 명세

원문:
- `docs/kopis/kopis-openapi-guide-v5.0.pdf`: 개발가이드, 서비스 버전 5.0, 2026-04-23 배포
- `docs/kopis/kopis-openapi-code-v3.7.pdf`: 공통코드 v3.7

이 문서는 트래커에 필요한 부분만 추린 것이다. 필드명과 제약은 원문에 적힌 그대로이다.

## 공통

- 인증: 쿼리 파라미터 `service={KOPIS_SERVICE_KEY}`
- 전송: 원문 운영 URL이 `http://www.kopis.or.kr/openApi/restful/...`이고 전송 암호화 항목은 "없음"으로 표시돼 있다. https 동작 여부는 실제 호출로 확인하고, 되면 https를 쓴다.
- 응답 형식은 XML뿐이다. `fast-xml-parser`로 파싱한다.
- 루트는 `<dbs><db>...</db></dbs>`이다. 결과가 1건이면 `db`가 배열이 아닐 수 있으므로 항상 배열로 정규화한다.
- 날짜 표기:
    - 목록·상세의 공연기간은 `2021.08.21` 형식이다.
    - 상세의 `frstregdt`, `updatedate`는 `2019-07-25 10:03:14` 형식이고 KST로 간주한다.
    - DB에 넣을 때 ISO(UTC)로 바꾼다.
- 오류 응답 형식과 호출량 제한은 원문에 나와 있지 않다. 첫 구현 때 잘못된 키로 호출해 응답을 fixture로 저장하고, 그 형식으로 오류를 판정한다.

## 1. 공연목록 `GET /openApi/restful/pblprfr`

| 파라미터 | 필수 | 내용 |
| --- | --- | --- |
| service | O | 서비스키 |
| stdate | O | 공연시작일 YYYYMMDD |
| eddate | O | 공연종료일 YYYYMMDD. stdate부터 최대 31일 |
| cpage | O | 현재 페이지 |
| rows | O | 페이지당 건수, 최대 100 |
| shprfnm |  | 공연명 검색어 (URL 인코딩) |
| shcate |  | 장르코드 |
| signgucode |  | 지역(시도)코드 2자리 |
| prfstate |  | 01 공연예정, 02 공연중, 03 공연완료 |
| afterdate |  | YYYYMMDD. 이 날짜 이후 등록·수정된 항목만 반환 |

응답 `db` 필드: `mt20id`(공연 ID), `prfnm`, `prfpdfrom`, `prfpdto`, `fcltynm`, `poster`, `area`, `genrenm`, `openrun`, `prfstate`

## 2. 공연상세 `GET /openApi/restful/pblprfr/{mt20id}`

파라미터: `service`

트래커에서 쓰는 응답 필드:

| 필드 | 용도 |
| --- | --- |
| mt20id | raw_items.external_id |
| prfnm | 제목 |
| fcltynm, mt10id(공연시설 ID), mt13id(공연장 ID) | venue, 병합 키 정규화 |
| prfpdfrom, prfpdto | start_date, end_date |
| dtguidance | 회차 시간 원문. LLM 입력에 포함 |
| prfcast | 출연진. 키워드 판정과 LLM 입력에 포함 |
| entrpsnmH(주최), entrpsnmS(주관), entrpsnmA(기획사), entrpsnmP(제작사) | officiality 판정 근거 |
| pcseguidance | 가격. summary_ko에 포함 |
| relates > relate > relatenm, relateurl | 예매처 이름과 URL. `events.ticket_url` 후보이자 L3 예매처 어댑터와 교차 확인용 |
| visit | 내한 여부 Y/N |
| festival | 축제 여부 Y/N |
| genrenm | 장르 |
| prfstate | 공연예정 / 공연중 / 공연완료 |
| updatedate | 변경 감지. content_hash에 포함 |
| poster | 디스코드 임베드 이미지 |

원문 예시에서 `relates` 밑의 반복 요소 이름이 명확하지 않다(`relatenm`/`relateurl` 쌍이 반복됨). 실제 응답으로 구조를 확인하고 fixture로 저장한다.

티켓 오픈 일시는 KOPIS에 없다. `ticket_open_at`은 예매처 어댑터나 공식 공지에서만 채운다.

## 3. 축제목록 `GET /openApi/restful/prffest`

파라미터는 공연목록과 같다(stdate/eddate 최대 31일, rows 최대 100, afterdate 지원). 응답에 `festival=Y`가 붙는다. 공연목록 스캔에서 축제도 함께 나오는지 확인하고, 빠지면 같은 방식으로 스캔 대상에 추가한다.

나머지 서비스(공연시설, 기획제작사, 수상작, 원·창작자, 예매상황판, 각종 통계)는 쓰지 않는다.

## 수집 전략

31일 제한 때문에 미래 공연은 기간을 31일 단위 창으로 나눠 조회한다.

1. 창 범위: 오늘 -30일 ~ 오늘 +365일. 31일씩 끊어 약 13개 창을 만든다(`config.window_days`, `config.horizon_days`).
2. 각 창에서 `afterdate`를 붙여 `rows=100`으로 전체를 조회하고, 100건 미만이 나올 때까지 `cpage`를 올린다. 장르나 제목으로 서버 쪽 필터는 걸지 않는다.
    - `afterdate`는 `sources.state.last_afterdate`에서 하루를 뺀 날짜이다. 겹치는 하루는 `(mt20id, updatedate)`로 중복을 거른다.
    - 첫 실행(state 없음)에서는 `afterdate` 없이 전체를 받는다. 1회성 백필이므로 호출 사이에 300ms 간격을 둔다.
3. 목록의 `prfnm`을 `keywords` 테이블로 로컬 판정한다. KOPIS는 공연 DB 자체이므로 context가 있는 것으로 보고 weak 키워드 하나로도 통과시킨다(`config.implicit_context: true`).
4. 통과한 `mt20id`만 상세를 호출한다. 제목에 키워드가 없고 출연진에만 있는 공연은 이 방식으로 잡히지 않는다. 그런 공연은 다른 소스(공식 X, 예매처, 네이버)에서 잡는 것으로 본다.
5. 상세 응답을 정리한 JSON을 `raw_items.body`에 넣고 일반 파이프라인(LLM 추출 → 병합 → 상태)으로 보낸다.
6. 성공하면 `state.last_afterdate = 오늘(KST)`로 갱신한다. 실패한 날이 있어도 다음 성공 실행이 그 날짜부터 다시 받는다.
7. 매 실행마다 창별 페이지 수와 총 호출 수를 `job_runs`에 남긴다. 일상 실행의 총 호출이 200회를 넘으면 관리자 경보를 보낸다(전체 스캔 대신 제목 검색 전환을 검토).

예비 경로: 전체 스캔이 무겁거나 막히면 `config.titles`의 검색어별로 `shprfnm`을 걸어 같은 창을 돈다. `shprfnm`의 부분 일치와 대소문자 처리 방식은 원문에 없으므로 실제 호출로 확인한다.

## 상태 매핑

KOPIS의 `prfstate`는 참고 값이다. 이것만으로 events.status를 바꾸지 않는다.

| KOPIS | 트래커 |
| --- | --- |
| 공연예정 | announced 유지 |
| 공연중 | ongoing |
| 공연완료 | ended |

`relates`에 예매처 URL이 있어도 판매가 이미 시작됐는지는 알 수 없다. 그래서 KOPIS만으로 on_sale을 만들지 않는다. URL은 `ticket_url`에 채우고, 판매 상태와 티켓 오픈 시각은 예매처 어댑터나 공식 공지로 정한다.

## 테스트 fixture

- 목록 응답: 0건, 1건(배열 아님), 100건(페이지 넘김)
- 상세 응답: 예매처 여러 개, 예매처 없음
- 오류 응답: 잘못된 서비스키
- 키워드: 제목 '하츠네 미쿠 심포니'는 strong으로 통과 / 제목 'MIKU 라이브'는 weak + implicit_context로 통과 / '미쿠니' 같은 오탐은 키워드는 통과하고 LLM 단계에서 is_relevant=false
