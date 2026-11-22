import type { NoticeSender, OutgoingMessage } from './types.js';
import { truncate } from './format.js';

export class WebhookError extends Error {
  constructor(public readonly status: number, detail: string) {
    // URL에 토큰이 들어 있으므로 오류 메시지에 URL을 넣지 않는다.
    super(`디스코드 웹후크 발송 실패 (HTTP ${status}) ${detail}`.trim());
    this.name = 'WebhookError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 공지 채널 웹후크 발송. 429면 retry_after만큼 기다렸다가 한 번 더 보낸다. */
export function createWebhookSender(url: string, fetchImpl: typeof fetch = fetch, maxWaitMs = 10_000): NoticeSender {
  const endpoint = `${url}?wait=true`;
  async function post(message: OutgoingMessage): Promise<Response> {
    return fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: message.content ? truncate(message.content) : undefined,
        embeds: message.embeds,
        // 공지 본문에 @everyone 같은 문자열이 섞여도 멘션되지 않게 막는다.
        allowed_mentions: { parse: [] },
      }),
    });
  }
  return {
    async send(message) {
      let res = await post(message);
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const waitMs = Math.min(Math.ceil((body.retry_after ?? 1) * 1000), maxWaitMs);
        await sleep(waitMs);
        res = await post(message);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WebhookError(res.status, text.slice(0, 200));
      }
    },
  };
}
