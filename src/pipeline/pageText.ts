import * as cheerio from 'cheerio';
import { fetchText as defaultFetchText, squash, type FetchText } from '../adapters/http.js';

/** 원문 페이지의 본문 텍스트. 메뉴·머리말·꼬리말을 빼고 main/article을 우선한다. */
export function htmlToText(html: string, maxChars = 8000): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, header, footer, form').remove();
  const title = squash($('title').first().text());
  const main = $('main, article, [role=main]').first();
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
