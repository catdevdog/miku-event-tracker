import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// cheerio가 먼저 불려 그 안의 undici 7이 전역 dispatcher를 차지한 상태를 만든다 (실제 서비스와 같은 순서)
import 'cheerio';
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
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('디스코드 REST 파일 첨부', () => {
  it('전용 Agent를 쓰면 다른 undici가 전역 dispatcher를 차지해도 파일이 올라간다 (월간 달력)', async () => {
    const rest = new REST({ api: url, version: '10', ...discordRestOptions() }).setToken('t');
    const r = (await rest.post('/channels/1/messages', { body: { content: '달력' }, files: [{ name: 'miku.png', data: Buffer.alloc(20_000, 7) }] })) as { bytes: number; type: string };
    expect(r.bytes).toBeGreaterThan(20_000);
    expect(r.type).toContain('multipart/form-data');
  });
});
