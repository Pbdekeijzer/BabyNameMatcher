import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreateRoomResponse, JoinRoomResponse, SyncResponse } from '@baby-name-matcher/shared';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AppDatabase } from './database.js';
import { AppStore } from './domain.js';
import { RoomEventBroker } from './events.js';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let backupDir: string;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    backupDir = await mkdtemp(join(tmpdir(), 'bnm-api-test-'));
    const config = loadConfig({
      databasePath: ':memory:',
      backupDir,
      webDist: 'runtime/no-web-build',
      cookieSecure: false,
      logLevel: 'silent',
    });
    app = await buildApp({
      config,
      database,
      store: new AppStore(database),
      events: new RoomEventBroker(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  const cookieFrom = (
    headers: Record<string, string | string[] | number | undefined>,
  ): string => {
    const header = headers['set-cookie'];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' ? (value.split(';')[0] ?? '') : '';
  };

  it('supports room creation, joining, authenticated sync, and private results', async () => {
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: { displayName: 'Alex' },
    });
    expect(createdResponse.statusCode).toBe(200);
    const created = createdResponse.json<CreateRoomResponse>();
    const creatorCookie = cookieFrom(createdResponse.headers);
    expect(created.pin).toMatch(/^\d{6}$/);
    expect(created.bootstrap.names).toHaveLength(2849);

    const joinedResponse = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: {
        inviteToken: created.inviteToken,
        pin: created.pin,
        displayName: 'Robin',
      },
    });
    expect(joinedResponse.statusCode).toBe(200);
    const joined = joinedResponse.json<JoinRoomResponse>();
    const partnerCookie = cookieFrom(joinedResponse.headers);
    const nameId = created.bootstrap.queue[0]!;

    const creatorSync = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { origin: 'http://localhost', host: 'localhost', cookie: creatorCookie },
      payload: {
        revision: created.bootstrap.revision,
        operations: [
          {
            operationId: '19dbb85b-2aa0-4cb1-bddb-221b3e182f88',
            sequence: 1,
            kind: 'decision.set',
            nameId,
            value: 'like',
          },
        ],
      },
    });
    expect(creatorSync.statusCode).toBe(200);
    expect(creatorSync.json<SyncResponse>().bootstrap.matches).toEqual([]);

    const partnerBootstrap = await app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { cookie: partnerCookie },
    });
    expect(partnerBootstrap.statusCode).toBe(200);
    expect(partnerBootstrap.json<JoinRoomResponse['bootstrap']>().queue).toEqual(
      joined.bootstrap.queue,
    );
    expect(partnerBootstrap.json<JoinRoomResponse['bootstrap']>().decisions).toEqual([]);

    const partnerSync = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { origin: 'http://localhost', host: 'localhost', cookie: partnerCookie },
      payload: {
        revision: joined.bootstrap.revision,
        operations: [
          {
            operationId: '43990b94-7f78-4cd1-9692-41f27a15168e',
            sequence: 1,
            kind: 'decision.set',
            nameId,
            value: 'like',
          },
        ],
      },
    });
    expect(partnerSync.statusCode).toBe(200);
    expect(partnerSync.json<SyncResponse>().bootstrap.matches[0]?.nameId).toBe(nameId);
  });

  it('rejects cross-origin state changes and unauthenticated data access', async () => {
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { origin: 'https://untrusted.example', host: 'localhost' },
      payload: { displayName: 'Alex' },
    });
    expect(crossOrigin.statusCode).toBe(403);

    const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(bootstrap.statusCode).toBe(401);
    expect(bootstrap.json()).toEqual({ message: 'Your session needs to be recovered.' });
  });

  it('accepts a 1,000-rating outbox from an already-installed client', async () => {
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { origin: 'http://localhost', host: 'localhost' },
      payload: { displayName: 'Robin' },
    });
    const created = createdResponse.json<CreateRoomResponse>();
    const creatorCookie = cookieFrom(createdResponse.headers);
    const operations = created.bootstrap.queue.slice(0, 1000).map((nameId, index) => ({
      operationId: randomUUID(),
      sequence: index + 1,
      kind: 'decision.set' as const,
      nameId,
      value: index % 2 === 0 ? ('like' as const) : ('pass' as const),
    }));

    const syncResponse = await app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { origin: 'http://localhost', host: 'localhost', cookie: creatorCookie },
      payload: { revision: created.bootstrap.revision, operations },
    });

    expect(syncResponse.statusCode).toBe(200);
    const result = syncResponse.json<SyncResponse>();
    expect(result.acknowledged).toHaveLength(1000);
    expect(result.rejected).toEqual([]);
    expect(result.bootstrap.decisions).toHaveLength(1000);
    expect(result.bootstrap.queue).toHaveLength(1849);
  });

  it('rejects malformed and downgraded origins without trusting forwarded hosts', async () => {
    for (const headers of [
      { origin: 'null', host: 'localhost' },
      { origin: 'not-a-url', host: 'localhost' },
      { origin: 'https://localhost', host: 'localhost' },
      { origin: 'https://attacker.example', host: 'localhost', 'x-forwarded-host': 'attacker.example' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { displayName: 'Alex' } });
      expect(response.statusCode).toBe(403);
    }
  });

  it('does not let clients bypass rate limits by spoofing forwarded IPs', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: '/api/rooms',
        headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` },
        payload: { displayName: 'Alex' },
      });
      expect(response.statusCode).toBe(attempt < 5 ? 200 : 429);
    }
  });

  it('preserves HTTP error statuses and prevents private API caching', async () => {
    const malformed = await app.inject({ method: 'POST', url: '/api/rooms', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400);
    const oversized = await app.inject({ method: 'POST', url: '/api/rooms', payload: { displayName: 'a'.repeat(1_100_000) } });
    expect(oversized.statusCode).toBe(413);
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(malformed.headers['cache-control']).toBe('no-store');
  });

  it('rejects sync operations bound to a different participant', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { displayName: 'Alex' } });
    const bootstrap = created.json<CreateRoomResponse>().bootstrap;
    const response = await app.inject({ method: 'POST', url: '/api/sync', headers: { cookie: cookieFrom(created.headers) }, payload: {
      participantId: randomUUID(), revision: bootstrap.revision,
      operations: [{ operationId: randomUUID(), sequence: 1, kind: 'decision.set', nameId: bootstrap.queue[0], value: 'like' }],
    } });
    expect(response.statusCode).toBe(401);
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM decisions').get()).toEqual({ count: 0 });
  });

  it('shuts down cleanly while an event stream is connected', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { displayName: 'Alex' } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get(`${address}/api/events`, { headers: { cookie: cookieFrom(created.headers) } }, (response) => {
        response.once('data', () => resolve(response));
      }).once('error', reject);
    });
    const ended = new Promise<void>((resolve) => stream.once('end', resolve));
    try {
      await Promise.race([
        Promise.all([app.close(), ended]),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Shutdown waited for an open event stream.')), 1000);
          timer.unref();
        }),
      ]);
    } finally {
      stream.destroy();
    }
  });

  it('exports only the creator room and never other rooms or deleted data', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/rooms', payload: { displayName: 'First room owner' } });
    const second = await app.inject({ method: 'POST', url: '/api/rooms', payload: { displayName: 'UnrelatedPrivatePerson' } });
    const firstBody = first.json<CreateRoomResponse>();
    const joined = await app.inject({ method: 'POST', url: '/api/join', payload: { inviteToken: firstBody.inviteToken, pin: firstBody.pin, displayName: 'Partner' } });
    const denied = await app.inject({ method: 'POST', url: '/api/backups/export', headers: { cookie: cookieFrom(joined.headers) } });
    expect(denied.statusCode).toBe(403);
    const exported = await app.inject({ method: 'POST', url: '/api/backups/export', headers: { cookie: cookieFrom(first.headers) } });
    expect(exported.statusCode).toBe(200);
    const path = join(backupDir, 'download.sqlite');
    await writeFile(path, exported.rawPayload);
    const snapshot = new Database(path);
    try {
      expect(snapshot.prepare('SELECT public_code FROM rooms').all()).toEqual([{ public_code: firstBody.bootstrap.room.publicCode }]);
      expect(snapshot.prepare('SELECT display_name FROM participants').all()).toHaveLength(2);
      expect(snapshot.pragma('foreign_key_check')).toEqual([]);
    } finally { snapshot.close(); }
    expect((await readFile(path)).includes(Buffer.from('UnrelatedPrivatePerson'))).toBe(false);
    expect((await readdir(backupDir)).filter((file) => file.startsWith('baby-name-matcher-export-'))).toEqual([]);
    const secondState = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { cookie: cookieFrom(second.headers) } });
    expect(secondState.statusCode).toBe(200);
  });
});
