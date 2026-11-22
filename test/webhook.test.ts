import { describe, expect, it, vi } from 'vitest';
import { createWebhookSender } from '../src/notify/webhook.js';

const URL = 'https://discord.com/api/webhooks/123/SECRET_TOKEN';

describe('웹후크 발송', () => {
  it('wait=true로 보내고 멘션을 막는다', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    await createWebhookSender(URL, fetchMock as unknown as typeof fetch).send({ content: '@everyone 새 행사' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL}?wait=true`);
    expect(JSON.parse(String(init.body))).toEqual({ content: '@everyone 새 행사', allowed_mentions: { parse: [] } });
  });

  it('429면 retry_after만큼 기다렸다가 한 번 더 보낸다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await createWebhookSender(URL, fetchMock as unknown as typeof fetch).send({ content: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('실패하면 상태 코드를 담아 던지고 URL(토큰)은 넣지 않는다', async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"Unknown Webhook"}', { status: 404 }));
    const err = await createWebhookSender(URL, fetchMock as unknown as typeof fetch)
      .send({ content: 'x' })
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('404');
    expect((err as Error).message).not.toContain('SECRET_TOKEN');
  });
});
