import { USER_AGENT } from './http.js';

/**
 * Playwright(chromium)로 페이지를 렌더링한 HTML을 돌려준다.
 * 배포 이미지(Playwright 공식 이미지)에는 브라우저가 들어 있다. 로컬에 브라우저가 없으면 실패한다.
 * 실행할 때마다 브라우저를 띄우고 닫는다(렌더링이 필요한 소스는 6시간 주기라 비용이 작다).
 */
export async function renderHtml(url: string, timeoutMs = 45_000): Promise<string> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}
