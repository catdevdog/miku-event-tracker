import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { REST } from 'discord.js';
import { discordRestOptions } from '../src/notify/discord.js';

let url = '';
const server = createServer((req, res) => {
  let bytes = 0;
  req.on('data', (c: Buffer) => (bytes += c.length));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: '1', bytes, type: req.headers['content-type'] }));
  });
});
// 실제 서비스와 같은 상태를 만든다: cheerio 안의 undici 7이 전역 dispatcher를 차지
const require = createRequire(import.meta.url);
const undici7 = createRequire(require.resolve('cheerio'))('undici') as typeof import('undici');
const original = undici7.getGlobalDispatcher();

beforeAll(async () => {
  expect(undici7.Agent).not.toBe((require('undici') as typeof import('undici')).Agent); // 서로 다른 undici
  undici7.setGlobalDispatcher(new undici7.Agent());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  undici7.setGlobalDispatcher(original);
  await new Promise((r) => server.close(r));
});

describe('디스코드 REST 파일 첨부', () => {
  it('전용 Agent를 쓰면 다른 undici가 전역 dispatcher를 차지해도 파일이 올라간다 (월간 달력)', async () => {
    const rest = new REST({ api: url, version: '10', ...discordRestOptions() }).setToken('t');
    const r = (await rest.post('/channels/1/messages', { body: { content: '달력' }, files: [{ name: 'miku.png', data: Buffer.alloc(20_000, 7) }] })) as { bytes: number; type: string };
    expect(r.bytes).toBeGreaterThan(20_000);
    expect(r.type).toContain('multipart/form-data');
  });

  it('전용 Agent가 없으면 같은 요청이 실패한다 (이 테스트가 원인을 재현하는지 확인)', async () => {
    const rest = new REST({ api: url, version: '10', retries: 0 }).setToken('t');
    await expect(rest.post('/channels/1/messages', { body: { content: '달력' }, files: [{ name: 'miku.png', data: Buffer.alloc(20_000, 7) }] })).rejects.toThrow('action is not a function');
  });
});
