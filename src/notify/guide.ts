import type { CollectionPlanRow } from '../services/sources.js';
import { BOOST_WINDOW_DAYS, X_JITTER_MIN } from '../scheduler/due.js';
import type { OutgoingMessage } from './types.js';

/** /가이드 임베드 색 (섹션마다 다르게) */
const C = { miku: 0x39c5bb, flow: 0x4a90e2, time: 0x9b59b6, bell: 0xf5a623, tag: 0x7ed321, note: 0xe86a92 };

const ADAPTER_KO: Record<string, string> = {
  x_crawl: 'X 계정',
  rss: 'RSS',
  html_diff: '사이트 변경 감지',
  ticket: '예매처',
  kopis: 'KOPIS 공연목록',
  instagram: '인스타그램',
  naver: '네이버 검색',
  playwright: '렌더링',
};

/** 60 → "1시간마다", 1440 → "하루 1번" */
export function intervalKo(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? '하루 1번' : `${min / 1440}일마다`;
  if (min % 60 === 0) return `${min / 60}시간마다`;
  return `${min}분마다`;
}

/** 소스 이름 뒤 괄호 설명은 뺀다: "AGF 공식 사이트 (부스 배치도·타임테이블)" → "AGF 공식 사이트" */
const shortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '');

/** 수집 주기 섹션. 소스 설정에서 바로 계산하므로 소스가 바뀌어도 안내가 맞다. */
export function scheduleLines(plan: CollectionPlanRow[]): { active: string[]; boost: string[]; idle: string } {
  const running = plan.filter((p) => p.schedulable && p.implemented);
  const byInterval = new Map<number, Map<string, number>>();
  for (const p of running) {
    const g = byInterval.get(p.intervalMin) ?? new Map<string, number>();
    g.set(p.adapter, (g.get(p.adapter) ?? 0) + 1);
    byInterval.set(p.intervalMin, g);
  }
  const active = [...byInterval.entries()]
    .sort(([a], [b]) => a - b)
    .map(([min, g]) => {
      const parts = [...g.entries()].map(([adapter, n]) => `${ADAPTER_KO[adapter] ?? adapter} ${n}곳${adapter === 'x_crawl' ? ` (±${X_JITTER_MIN}분)` : ''}`);
      return `**${intervalKo(min)}**　${parts.join(' · ')}`;
    });

  const boostGroups = new Map<number, string[]>();
  for (const p of running) {
    if (p.boostIntervalMin && p.boostIntervalMin < p.intervalMin) {
      boostGroups.set(p.boostIntervalMin, [...(boostGroups.get(p.boostIntervalMin) ?? []), shortName(p.name)]);
    }
  }
  const boost = [...boostGroups.entries()].map(([min, names]) => `${names.join(' · ')} → ${intervalKo(min)}`);

  const idle = plan
    .filter((p) => !(p.schedulable && p.implemented))
    .map((p) => shortName(p.name))
    .join(' · ');
  return { active, boost, idle };
}

export function buildGuideReply(plan: CollectionPlanRow[]): OutgoingMessage {
  const { active, boost, idle } = scheduleLines(plan);
  const runningCount = plan.filter((p) => p.schedulable && p.implemented).length;
  // 국내 팝업·카페 공지가 많은 채널 중 아직 수집하지 않는 것 (네이버 검색, 인스타그램)
  const socialIdle = [...new Set(plan.filter((p) => (p.adapter === 'naver' || p.adapter === 'instagram') && !(p.schedulable && p.implemented)).map((p) => ADAPTER_KO[p.adapter]!))];

  return {
    embeds: [
      {
        title: '📖 미쿠 행사 알림 가이드',
        description: [
          '하츠네 미쿠 **공연 · 팝업 · 콜라보 카페 · 행사 부스 · 라이브뷰잉 · 굿즈** 소식을 여러 곳에서 모아, 같은 행사끼리 하나로 정리해서 알려 주는 봇이에요.',
          '프로젝트 세카이와 허가받은 동인 공연도 포함해요.',
        ].join('\n'),
        color: C.miku,
        fields: [
          {
            name: '💬 명령어 (응답은 나에게만 보여요)',
            value: [
              '`/행사` 다가오는 행사 목록. `범위`로 국내 · 일본 · 해외(일본 제외) · 전체 선택',
              '`/행사 검색:` 행사 이름을 치면 후보가 떠요. 고르면 출처 · 변경 이력까지 보여 줘요',
              '`/제보` 봇이 놓친 행사 링크 알려 주기 (메시지 우클릭 → 앱 → **행사 제보**도 돼요)',
              '`/소스` 수집처별 상태와 마지막 수집 시각',
              '`/최근수집` 최근에 모은 글과 판정 결과',
              '`/점검` 지역별 행사 수와 국내 수집처 점검',
              '`/ping` 봇이 살아 있는지 확인',
              '`/가이드` 지금 보는 안내',
            ].join('\n'),
          },
        ],
      },
      {
        title: '🔄 이렇게 동작해요',
        description: [
          '**1. 수집**　공식 사이트 · X · RSS · 예매처 · KOPIS · 네이버 뉴스·블로그·카페를 정해진 주기로 확인해 **새 글만** 가져와요.',
          '**2. 키워드 거르기**　`하츠네 미쿠` `프로세카` 같은 확실한 단어가 있으면 통과. `미쿠`처럼 애매한 단어는 `팝업` `콘서트` 같은 단어와 같이 있을 때만 통과해요.',
          '**3. Claude 판정**　남은 글을 Claude가 읽고 실제로 갈 수 있는 행사인지, 일정 · 장소 · 티켓 오픈 시각을 뽑아요. 확신이 낮으면 더 큰 모델로 한 번 더 보고, 그래도 애매하면 **검수 대기**로 두고 알리지 않아요.',
          '**4. 합치기**　여러 곳에서 온 같은 행사 소식은 하나로 합쳐요.',
          '**5. 상태 계산**　날짜를 보고 발표 → 예매 예정 → 판매 중 → 진행 중 → 종료로 자동으로 넘어가요.',
          '**6. 알림**　조건이 맞으면 공지 채널로 보내요.',
          '',
          '판정 · 상태 계산 · 알림 발송은 **1분마다** 돌아요.',
        ].join('\n'),
        color: C.flow,
      },
      {
        title: '⏱️ 수집 주기',
        description: [
          `지금 실제로 수집하는 곳은 **${runningCount}곳**이에요.`,
          ...active,
          ...(boost.length
            ? ['', `행사가 **${BOOST_WINDOW_DAYS}일 안**으로 다가오면 행사장 사이트는 더 자주 봐요.`, ...boost.map((b) => `　${b}`)]
            : []),
          '',
          '사이트 변경 감지는 **처음 볼 때 기준만 잡고** 알리지 않아요. 그 뒤로 새로 올라온 내용부터 잡혀요.',
          'X · RSS는 처음 볼 때 최근 30일, 네이버는 최근 14일 글만 가져와요. 네이버 검색 결과는 20일 뒤 지워요.',
        ].join('\n'),
        color: C.time,
      },
      {
        title: '🔔 알림은 이럴 때 와요',
        description: [
          '🆕 새 행사를 찾았을 때 (이미 끝난 행사, 검수 대기는 빼요)',
          '🗓️ 예매 일정이 공개됐을 때',
          '⏰ 티켓 오픈 **24시간 전**, **1시간 전**',
          '🎫 판매가 시작됐을 때',
          '⛔ 행사가 취소됐을 때',
          '',
          '진행 중 · 종료로 바뀔 때, 일정 · 장소만 바뀔 때는 알리지 않아요. 같은 알림은 두 번 보내지 않아요.',
          '',
          '**멘션 알림**　공지 채널에 고정된 **🔔 알림 설정**에서 지역별로 켜고 꺼요. **국내는 기본으로 켜져 있고**, 일본 · 해외는 원하는 사람만 켜요.',
          '**행사별 스레드**　새 행사 공지마다 스레드가 열려요. 예매 일정 · 판매 시작 · 취소 소식은 스레드에 쓰고 원래 카드도 최신 상태로 고쳐요. 티켓 오픈 리마인더는 채널에 멘션으로 와요.',
          '**🔔 알림 받기**　공지 카드의 버튼을 누르면 그 행사만 티켓 오픈 24시간 · 1시간 전, 판매 시작 · 취소를 **DM**으로 받아요.',
        ].join('\n'),
        color: C.bell,
      },
      {
        title: '🏷️ 표시 읽는 법',
        fields: [
          { name: '상태', value: '발표 · 예정(예매 일정 공개) · 판매(판매 중) · 진행(행사 기간) · 종료 · 취소' },
          { name: '지역', value: '🇰🇷 국내 · 🇯🇵 일본 · 🌏 해외(일본 제외). 공지 맨 아래 이미지로도 구분돼요.' },
          { name: '구분', value: '크립톤 공식 · 라이선스(공식 콜라보) · 허가 동인 · 미확인' },
          { name: '시각', value: '모두 한국 시간. "2일 후" 같은 상대 시간은 디스코드가 보는 사람 기준으로 바꿔 줘요.' },
        ],
        color: C.tag,
      },
      {
        title: '⚠️ 알아 두세요',
        description: [
          ...(socialIdle.length ? [`국내 팝업 · 콜라보 카페 공지가 많은 ${socialIdle.join(' · ')}은 아직 연결 전이라 늦거나 놓칠 수 있어요.`] : []),
          ...(idle ? [`아직 확인하지 않는 곳: ${idle}`] : []),
          '예매 전에는 꼭 공지의 원문 · 예매 링크를 확인하세요.',
        ].join('\n'),
        color: C.note,
      },
    ],
  };
}
