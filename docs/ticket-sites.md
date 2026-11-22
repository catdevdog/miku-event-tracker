# 예매처 요청 형식 (2026-11-23 브라우저로 확인)

사이트가 화면을 그릴 때 부르는 주소를 그대로 쓴다. 로그인·입력 없이 읽기만 했다.

## 멜론티켓 (구현)
- 검색: `GET https://ticket.melon.com/search/index.htm?q=<검색어>` (서버가 그린 HTML)
- 티켓 오픈 소식: `POST https://ticket.melon.com/csoon/ajax/listTicketOpen.htm` (`schText=<검색어>`)

## YES24 티켓 (구현)
- 공연 검색: `POST https://ticket.yes24.com/New/Search/Ajax/axPerfList.aspx`
    - 폼: `SearchText`, `SearchSubText=''`, `SearchType=''`, `BookingType=''`, `PerfCurPage=1`, `PageSize`, `SortType=1`
    - 응답 HTML `.srch-list-item`: `.item-tit a[href=/Perf/{id}]` 제목, `.item-state span` 판매 상태, 셋째 `div` 기간, 넷째 `div` 장소
    - 제목에 없어도 출연진으로 걸린 공연이 나온다 (예: "하츠네" → PINOCCHIOP ASIA TOUR)
    - 사람용 페이지: `https://ticket.yes24.com/Search/<검색어>` (옛 주소 `/Pages/Search/SearchList.aspx?SearchText=`는 여기로 넘어감)
- 티켓 오픈 공지: `POST https://ticket.yes24.com/New/Notice/Ajax/axList.aspx`
    - 폼: `page=1`, `size=20`, `genre=''`, `province=''`, `order=1`, `searchType=All`, `searchText=<검색어>`
    - 응답 HTML `.noti-tbl tr`: `a[href="#id={공지 번호}"]` 제목, 셋째 `td` 티켓오픈 일시 `2026.12.02(수) 20:00`(비어 있을 수 있음)
    - 공지 상세는 `https://ticket.yes24.com/Notice#id={번호}` (본문은 스크립트로 불러와 원문 페이지 텍스트로는 못 가져온다. 목록의 제목·오픈 시각만 쓴다)

## 티켓링크 (쓰지 않음)
- 검색 `https://www.ticketlink.co.kr/search?query=<검색어>` 결과는 서버가 그리지만, 스크립트 기반 자동화 차단(`evfw` 확인 후 새로고침)이 있다. 자동 브라우저에서는 새로고침이 계속 반복됐다.
- 차단을 우회하지 않는다. 티켓링크 단독 판매 공연은 KOPIS·네이버 뉴스·공식 X로 잡는다.

## NOL 티켓 (보류)
- `tickets.interpark.com/search?keyword=`는 `nol.yanolja.com/ticket`으로 넘어가며 검색어가 사라진다. 티켓 전용 검색 주소를 찾지 못했다.
- NOL 티켓 첫 화면의 "오픈 예정" 목록은 서버 HTML에 있지만 링크(`a[href]`)가 없고 클래스 이름이 빌드마다 바뀌는 형식이라 안정적으로 읽을 수 없다.
- 다음에 볼 것: NOL 앱 검색 화면이 부르는 주소, 공연 상세(`/ticket/products/{id}`) 구조.
