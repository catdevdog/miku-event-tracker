/**
 * 행사의 행동 링크(events.ticket_url: 예매·사전예약·판매 페이지) 검사.
 * - 블로그·뉴스·SNS·커뮤니티 주소는 행동 링크가 아니다(원문 보기로만 보여 준다).
 * - 예매처 주소는 가장 믿을 수 있는 링크라 다른 출처가 덮어쓰지 못한다.
 */
export type LinkTier = 'ticket' | 'other' | 'media';

/** 예매처 (하위 도메인 포함) */
const TICKET_HOSTS = [
  'ticket.melon.com', 'ticket.yes24.com', 'tickets.interpark.com', 'nol.interpark.com', 'nol.yanolja.com', 'ticketlink.co.kr',
  'eplus.jp', 'l-tike.com', 'pia.jp', 'ticket.rakuten.co.jp', 'livepocket.jp', 'tixplus.jp', 'ticketmaster.com', 'kktix.com', 'tickets.kakao.com',
];

/** 소개 글·기사·SNS·커뮤니티 (하위 도메인 포함) */
const MEDIA_HOSTS = [
  'blog.naver.com', 'cafe.naver.com', 'post.naver.com', 'news.naver.com', 'n.news.naver.com', 'naver.me', 'tistory.com', 'brunch.co.kr', 'velog.io',
  'x.com', 'twitter.com', 't.co', 'instagram.com', 'facebook.com', 'threads.net', 'threads.com', 'youtube.com', 'youtu.be', 'tiktok.com',
  'dcinside.com', 'arca.live', 'ruliweb.com', 'inven.co.kr', 'fmkorea.com', 'theqoo.net', 'namu.wiki', 'wikipedia.org',
  'note.com', 'ameblo.jp', 'hatenablog.com', 'prtimes.jp', 'natalie.mu', 'famitsu.com', '4gamer.net', 'gamer.ne.jp', 'dengekionline.com', 'oricon.co.jp',
  'medium.com', 'reddit.com', 'discord.com', 'discord.gg',
];

const hostMatches = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

export function linkTier(url: string | null | undefined): LinkTier | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  } catch {
    return null;
  }
  if (hostMatches(host, TICKET_HOSTS)) return 'ticket';
  if (hostMatches(host, MEDIA_HOSTS)) return 'media';
  return 'other';
}

const sameUrl = (a: string, b: string) => {
  const norm = (s: string) => s.replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * 추출된 링크를 행동 링크로 써도 되는지. 안 되면 null.
 * - 소개 글·기사·SNS 주소는 버린다.
 * - 원문 글 자체의 주소는 버린다(원문 보기와 같은 링크). 단 예매처 주소이거나 원문이 예매처·KOPIS에서 온 경우는 둔다.
 */
export function actionUrl(url: string | null | undefined, item: { url?: string | null; adapter?: string } = {}): string | null {
  const tier = linkTier(url);
  if (!url || !tier || tier === 'media') return null;
  if (tier === 'ticket' || item.adapter === 'ticket' || item.adapter === 'kopis') return url;
  if (item.url && sameUrl(url, item.url)) return null;
  return url;
}

/** 기존 링크를 새 링크로 바꿔도 되는지: 예매처 링크는 예매처 링크로만 바꾼다 */
export function mayReplaceLink(existing: string | null | undefined, incoming: string): boolean {
  if (!existing) return true;
  const rank = (u: string) => (linkTier(u) === 'ticket' ? 2 : linkTier(u) === 'other' ? 1 : 0);
  return rank(incoming) >= rank(existing);
}
