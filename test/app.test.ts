import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';
import { makeTestDb } from './helpers.js';

let t: Awaited<ReturnType<typeof makeTestDb>>;
let server: Server;
let base: string;

beforeEach(async () => {
  t = await makeTestDb();
  await seedDatabase(t.db);
  server = createApp({ db: t.db, adminBasicAuth: 'admin:pw', startedAt: new Date() }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  t.cleanup();
});

describe('HTTP', () => {
  it('/health는 인증 없이 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', db: 'ok', discord: 'disabled', lastJobRunAt: null, failingSources: 0 });
  });

  it('/api/admin은 Basic Auth가 없으면 401, 맞으면 200', async () => {
    expect((await fetch(`${base}/api/admin/sources`)).status).toBe(401);
    const wrong = await fetch(`${base}/api/admin/sources`, { headers: { authorization: `Basic ${btoa('admin:x')}` } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/api/admin/sources`, { headers: { authorization: `Basic ${btoa('admin:pw')}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveLength(35);
  });

  it('/api/admin/job-runs, /api/admin/raw-items', async () => {
    const auth = { authorization: `Basic ${btoa('admin:pw')}` };
    expect(await (await fetch(`${base}/api/admin/job-runs`, { headers: auth })).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/admin/raw-items`, { headers: auth })).json()).toEqual([]);
    expect((await fetch(`${base}/api/admin/raw-items`)).status).toBe(401);
  });
});
