/** 디스코드 표시용 한국어 라벨·아이콘·색. 공지 카드, 명령 응답, 임베드가 같이 쓴다. */

export const KIND_KO: Record<string, string> = {
  concert: '공연', booth: '부스', stage: '무대', popup: '팝업', cafe: '콜라보 카페',
  exhibition: '전시', live_viewing: '상영·라이브뷰잉', goods: '굿즈', collab: '콜라보', other: '기타',
};

export const KIND_ICON: Record<string, string> = {
  concert: '🎤', booth: '🎪', stage: '🎪', popup: '🏪', cafe: '☕',
  exhibition: '🖼️', live_viewing: '🎬', goods: '🛍️', collab: '🤝', other: '📌',
};

/** "🎤 공연" */
export const kindLabel = (kind: string) => `${KIND_ICON[kind] ?? '📌'} ${KIND_KO[kind] ?? kind}`;

/** /행사 유형 필터 묶음 */
export const KIND_GROUPS = {
  concert: { label: '🎤 공연', kinds: ['concert'] },
  fest: { label: '🎪 부스·무대', kinds: ['booth', 'stage'] },
  shop: { label: '🏪 팝업·카페·전시', kinds: ['popup', 'cafe', 'exhibition'] },
  screen: { label: '🎬 상영·라이브뷰잉', kinds: ['live_viewing'] },
  goods: { label: '🛍️ 굿즈·콜라보', kinds: ['goods', 'collab'] },
} as const;
export type KindGroup = keyof typeof KIND_GROUPS;
export const parseKindGroup = (v: string | null | undefined): KindGroup | undefined => (v && v in KIND_GROUPS ? (v as KindGroup) : undefined);

/** 좌석 예매가 있는 유형. 그 외 유형은 티켓 줄을 일정이 있을 때만 보여 준다 */
export const TICKETED_KINDS = new Set(['concert', 'live_viewing', 'stage']);

/** 일정 줄 이름: 굿즈는 발매, 팝업·카페·전시·콜라보는 기간 */
export const dateLabel = (kind: string) => (kind === 'goods' ? '발매' : ['popup', 'cafe', 'exhibition', 'collab'].includes(kind) ? '기간' : '일정');

/**
 * 행동 링크(events.ticket_url) 버튼 문구. 예매처 링크이거나 예매가 있는 유형이면 예매하기,
 * 굿즈·콜라보는 판매처, 팝업·카페·전시는 예약·안내, 나머지는 공식 페이지.
 */
export function actionLabel(kind: string, isTicketSite: boolean, short = false): string {
  if (isTicketSite || kind === 'concert' || kind === 'live_viewing') return short ? '🎫 예매' : '🎫 예매하기';
  if (kind === 'goods' || kind === 'collab') return short ? '🛍️ 판매처' : '🛍️ 판매처 보기';
  if (kind === 'popup' || kind === 'cafe' || kind === 'exhibition') return short ? '📝 예약·안내' : '📝 예약·안내 보기';
  return short ? '🔗 공식' : '🔗 공식 페이지';
}

export const OFFICIALITY_KO: Record<string, string> = {
  crypton: '크립톤 공식', licensed: '공식 라이선스', permitted_doujin: '허가 동인', unverified: '미확인',
};

export const STATUS_KO: Record<string, string> = {
  announced: '발표', ticket_scheduled: '예매 예정', on_sale: '판매 중', ongoing: '진행 중', ended: '종료', cancelled: '취소',
};

export const STATUS_ICON: Record<string, string> = {
  announced: '📣', ticket_scheduled: '🗓️', on_sale: '🎫', ongoing: '🎪', ended: '✅', cancelled: '⛔',
};

/** 지역별 깃발·이름·카드 색. 색은 지역 이미지 글자색(국내 하늘, 일본 빨강, 해외 파랑)에 맞췄다. */
export const REGION_META: Record<string, { flag: string; label: string; color: number }> = {
  KR: { flag: '🇰🇷', label: '국내', color: 0x39c5bb },
  JP: { flag: '🇯🇵', label: '일본', color: 0xe8384f },
  OTHER: { flag: '🌏', label: '해외', color: 0x3b82f6 },
};

export const regionMeta = (region: string) => REGION_META[region] ?? REGION_META.OTHER!;

/** 상태 점: 수집처 상태, 점검 */
export const DOT = { ok: '🟢', fail: '🟡', alert: '🔴', wait: '⚪', todo: '🔧', off: '⚫', paused: '⏸️' } as const;

export const CARD_COLOR = {
  miku: 0x39c5bb,
  ok: 0x2ecc71,
  fail: 0xf1c40f,
  alert: 0xe74c3c,
  wait: 0x95a5a6,
  off: 0x4f545c,
  info: 0x4a90e2,
} as const;

/**
 * 국내·일본·해외 구분 이미지. 2:1 가로형이라 썸네일(최대 80px)로는 글자가 안 보여 임베드 하단 이미지로 넣는다.
 * 파일은 레포 assets/에 두고 공개 레포의 GitHub raw 주소로 쓴다.
 */
export const ASSET_BASE = 'https://raw.githubusercontent.com/catdevdog/miku-event-tracker/main/assets';
export const REGION_IMAGES: Record<string, string | undefined> = {
  KR: `${ASSET_BASE}/region-kr.png`,
  JP: `${ASSET_BASE}/region-jp.png`,
  OTHER: `${ASSET_BASE}/region-overseas.png`,
};

