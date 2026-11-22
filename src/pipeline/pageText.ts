import * as cheerio from 'cheerio';
import { fetchText as defaultFetchText, squash, type FetchText } from '../adapters/http.js';

/** 원문 페이지의 본문 텍스트. 메뉴·머리말·꼬리말을 빼고 main/article을 우선한다. */
export function htmlToText(html: string, maxChars = 8000): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, header, footer, form').remove();
  const title = squash($('title').first().text());
  // 네이버 뉴스 본문(#dic_area), 네이버 블로그 본문(.se-main-container, 옛 에디터 #postViewArea)도 본문으로 본다
  const main = $('main, article, [role=main], #dic_area, .se-main-container, #postViewArea').first();
  const root = main.length ? main : $('body');
  // 블록 경계를 줄바꿈으로 남긴다
  root.find('br').replaceWith('\n');
  root.find('p, li, h1, h2, h3, h4, h5, tr, dt, dd, div').each((_, el) => {
    $(el).append('\n');
  });
  const text = root
    .text()
    .split('\n')
    .map((l) => squash(l))
    .filter(Boolean)
    .join('\n');
  return (title ? `${title}\n${text}` : text).slice(0, maxChars);
}

export async function fetchPageText(url: string, fetchText: FetchText = defaultFetchText): Promise<string> {
  const { text } = await fetchText(url, { timeoutMs: 20_000 });
  return htmlToText(text);
}

/**
 * 네이버 검색 결과 link를 본문을 가져올 수 있는 주소로 바꾼다.
 * 블로그(blog.naver.com/{id}/{logNo})는 본문이 iframe 안에 있어 PostView 주소로 바꾼다. 나머지는 그대로.
 */
export function naverReadableUrl(link: string): string {
  try {
    const u = new URL(link);
    const m = /^\/([A-Za-z0-9_-]+)\/(\d+)\/?$/.exec(u.pathname);
    if ((u.hostname === 'blog.naver.com' || u.hostname === 'm.blog.naver.com') && m) {
      return `https://blog.naver.com/PostView.naver?blogId=${m[1]}&logNo=${m[2]}`;
    }
  } catch {
    // 주소가 이상하면 그대로
  }
  return link;
}
