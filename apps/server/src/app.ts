import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  createRoomRequestSchema,
  joinRoomRequestSchema,
  recoverRequestSchema,
  syncRequestSchema,
  type ApiErrorBody,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RecoverRoomResponse,
  type SyncResponse,
} from '@baby-name-matcher/shared';
import type { AppConfig } from './config.js';
import { backupIfDue, type AppDatabase } from './database.js';
import { AppError, AppStore, type SessionContext } from './domain.js';
import { RoomEventBroker } from './events.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionContext?: SessionContext;
  }
}

export interface AppDependencies {
  config: AppConfig;
  database: AppDatabase;
  store: AppStore;
  events: RoomEventBroker;
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function sendWebFile(
  request: FastifyRequest,
  reply: FastifyReply,
  webDist: string,
): Promise<FastifyReply> {
  const root = resolve(webDist);
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
  } catch {
    throw new AppError('The requested path is not valid.', 400);
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(root, relativePath);
  const isInsideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
  let selected = resolve(root, 'index.html');
  if (isInsideRoot) {
    try {
      if ((await stat(candidate)).isFile()) selected = candidate;
    } catch {
      // Client-side routes intentionally fall back to index.html.
    }
  }

  const extension = extname(selected).toLowerCase();
  reply.header('Content-Type', contentTypes[extension] ?? 'application/octet-stream');
  if (selected.endsWith('index.html') || selected.endsWith('sw.js') || selected.endsWith('.webmanifest')) {
    reply.header('Cache-Control', 'no-cache');
  } else {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  }
  return reply.send(await readFile(selected));
}

function cookieName(config: AppConfig): string {
  return config.cookieSecure ? '__Host-bnm_session' : 'bnm_session';
}

function setSessionCookie(reply: FastifyReply, token: string, config: AppConfig): void {
  reply.setCookie(cookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    maxAge: 90 * 24 * 60 * 60,
  });
}

function authenticate(
  request: FastifyRequest,
  store: AppStore,
  config: AppConfig,
): SessionContext {
  const context = store.authenticate(request.cookies[cookieName(config)]);
  if (!context) throw new AppError('Your session needs to be recovered.', 401);
  request.sessionContext = context;
  return context;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success || result.data === undefined) {
    const message = result.error?.issues[0]?.message ?? 'Check the submitted values.';
    throw new AppError(message, 400);
  }
  return result.data;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database, events, store } = dependencies;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
      serializers: {
        req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '/' }),
      },
    },
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        // HTTP on localhost is a supported secure context. Do not rewrite its assets to HTTPS.
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0]?.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    const expectedOrigin = config.publicOrigin ??
      `${config.cookieSecure ? 'https' : request.protocol}://${request.host}`;
    let validOrigin = false;
    try {
      const parsed = new URL(origin);
      validOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === expectedOrigin;
    } catch {
      // Invalid and opaque origins are rejected with the same response.
    }
    if (!validOrigin) {
      throw new AppError('The request origin is not allowed.', 403);
    }
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post(
    '/api/rooms',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply): Promise<CreateRoomResponse> => {
      const body = parseBody(createRoomRequestSchema, request.body);
      const created = store.createRoom(body.displayName);
      setSessionCookie(reply, created.sessionToken, config);
      const context = store.authenticate(created.sessionToken);
      if (!context) throw new AppError('The room could not be created.', 500);
      return {
        bootstrap: store.getBootstrap(context),
        inviteToken: created.inviteToken,
        pin: created.pin,
        recoveryCode: created.recoveryCode,
      };
    },
  );

  app.post(
    '/api/join',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (request, reply): Promise<JoinRoomResponse> => {
      const body = parseBody(joinRoomRequestSchema, request.body);
      const joined = store.joinRoom(body.inviteToken, body.pin, body.displayName);
      setSessionCookie(reply, joined.sessionToken, config);
      const context = store.authenticate(joined.sessionToken);
      if (!context) throw new AppError('The room could not be joined.', 500);
      events.publish(joined.roomId, store.getBootstrap(context).revision);
      return { bootstrap: store.getBootstrap(context), recoveryCode: joined.recoveryCode };
    },
  );

  app.post(
    '/api/recover',
    { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } },
    async (request, reply): Promise<RecoverRoomResponse> => {
      const body = parseBody(recoverRequestSchema, request.body);
      const recovered = store.recover(body.roomCode, body.recoveryCode);
      setSessionCookie(reply, recovered.sessionToken, config);
      const context = store.authenticate(recovered.sessionToken);
      if (!context) throw new AppError('The session could not be recovered.', 500);
      return { bootstrap: store.getBootstrap(context) };
    },
  );

  app.get('/api/bootstrap', async (request) => {
    const context = authenticate(request, store, config);
    return store.getBootstrap(context);
  });

  app.post('/api/sync', async (request): Promise<SyncResponse> => {
    const context = authenticate(request, store, config);
    const body = parseBody(syncRequestSchema, request.body);
    if (body.participantId && body.participantId !== context.participantId) {
      throw new AppError('This browser is signed in as a different participant. Recover your session.', 401);
    }
    const result = store.sync(context, body.operations);
    const bootstrap = store.getBootstrap(context);
    if (result.changed) events.publish(context.roomId, bootstrap.revision);
    return {
      bootstrap,
      acknowledged: result.acknowledged,
      rejected: result.rejected,
    };
  });

  app.get('/api/events', async (request, reply) => {
    const context = authenticate(request, store, config);
    const revision = store.getBootstrap(context).revision;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const unsubscribe = events.subscribe(context.roomId, reply.raw, revision);
    reply.raw.once('close', unsubscribe);
  });

  app.post('/api/backups/export', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (request, reply) => {
    const context = authenticate(request, store, config);
    if (context.role !== 'creator') throw new AppError('Only the room creator can export backups.', 403);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `baby-name-matcher-export-${stamp}-${randomUUID()}.sqlite`;
    const path = join(config.backupDir, filename);
    try {
      await database.backupRoom(path, context.roomId);
      const contents = await readFile(path);
      reply.header('Content-Type', 'application/vnd.sqlite3');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(contents);
    } finally {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });

  const hasWebBuild = existsSync(config.webDist);
  app.addHook('preClose', async () => events.close());

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ message: 'Not found.' } satisfies ApiErrorBody);
    }
    if (hasWebBuild) {
      return sendWebFile(request, reply, config.webDist);
    }
    return reply.code(503).send({ message: 'The web application has not been built yet.' });
  });

  app.setErrorHandler((error, _request, reply) => {
    const reportedStatus = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const statusCode = typeof reportedStatus === 'number' && reportedStatus >= 400 && reportedStatus <= 599
      ? reportedStatus : 500;
    if (statusCode >= 500) app.log.error({ err: error }, 'Request failed');
    const message =
      statusCode >= 500
        ? 'Something went wrong on the server.'
        : error instanceof AppError
          ? error.message
          : statusCode === 429 ? 'Too many requests. Please try again later.'
          : 'The request could not be completed.';
    void reply.code(statusCode).send({ message } satisfies ApiErrorBody);
  });

  app.addHook('onReady', async () => {
    try {
      const created = await backupIfDue(database, config.backupDir);
      if (created) app.log.info({ backup: created }, 'Created database backup');
    } catch (error) {
      app.log.error({ err: error }, 'Initial backup failed');
    }
  });

  return app;
}
