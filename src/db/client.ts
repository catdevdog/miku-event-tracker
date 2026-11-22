import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;

export interface DbHandle {
  client: Client;
  db: Db;
}

export interface OpenDbOptions {
  url: string;
  authToken?: string;
}

/** DB를 연다. file: URL이면 상위 폴더를 만든다. */
export async function openDb({ url, authToken }: OpenDbOptions): Promise<DbHandle> {
  if (url.startsWith('file:') && url !== 'file::memory:') {
    const path = url.slice('file:'.length);
    mkdirSync(dirname(path), { recursive: true });
  }
  const client = createClient(authToken ? { url, authToken } : { url });

  // libsql은 연결마다 foreign_keys를 켠 상태로 연다. 다른 드라이버로 바뀌는 경우를 대비해 확인한다.
  const fk = await client.execute('PRAGMA foreign_keys');
  if (Number(fk.rows[0]?.[0]) !== 1) {
    throw new Error('SQLite foreign_keys가 꺼져 있습니다. 드라이버 설정을 확인하세요.');
  }

  return { client, db: drizzle(client, { schema }) };
}
