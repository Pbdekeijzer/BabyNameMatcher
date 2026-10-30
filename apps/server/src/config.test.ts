import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';

describe('server configuration', () => {
  beforeEach(() => {
    for (const key of ['HOST', 'PORT', 'RUNTIME_DIR', 'WEB_DIST', 'COOKIE_SECURE', 'TRUST_PROXY', 'PUBLIC_ORIGIN', 'NODE_ENV']) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to loopback without trusting forwarded headers', () => {
    expect(loadConfig()).toMatchObject({ host: '127.0.0.1', port: 3000, trustProxy: false, cookieSecure: false, databasePath: resolve('runtime/baby-name-matcher.sqlite') });
  });

  it('supports empty Docker environment defaults and an explicit HTTPS origin', () => {
    vi.stubEnv('PUBLIC_ORIGIN', '');
    vi.stubEnv('TRUST_PROXY', '');
    expect(loadConfig().publicOrigin).toBeUndefined();
    vi.stubEnv('PUBLIC_ORIGIN', 'https://names.example.com');
    vi.stubEnv('TRUST_PROXY', 'loopback');
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(loadConfig()).toMatchObject({ publicOrigin: 'https://names.example.com', trustProxy: 'loopback', cookieSecure: true });
  });

  it.each(['0', '-1', '65536', 'not-a-port', '3000.5'])('rejects invalid port %s', (port) => {
    vi.stubEnv('PORT', port);
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it('fails closed on typos in cookie security and blanket proxy trust', () => {
    vi.stubEnv('COOKIE_SECURE', 'tru');
    expect(() => loadConfig()).toThrow(/COOKIE_SECURE/);
    vi.stubEnv('COOKIE_SECURE', 'true');
    vi.stubEnv('TRUST_PROXY', 'true');
    expect(() => loadConfig()).toThrow(/TRUST_PROXY/);
  });

  it.each(['null', 'https://names.example.com/path', 'http://user:pass@localhost', 'file:///tmp'])('rejects invalid public origin %s', (origin) => {
    vi.stubEnv('PUBLIC_ORIGIN', origin);
    expect(() => loadConfig()).toThrow(/PUBLIC_ORIGIN/);
  });
});
