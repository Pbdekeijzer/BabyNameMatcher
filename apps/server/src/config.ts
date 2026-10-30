import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  runtimeDir: string;
  databasePath: string;
  backupDir: string;
  webDist: string;
  cookieSecure: boolean;
  logLevel: string;
  trustProxy: false | string;
  publicOrigin: string | undefined;
}

function booleanFromEnvironment(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error('COOKIE_SECURE must be true or false.');
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const runtimeDir = overrides.runtimeDir ?? resolve(process.env.RUNTIME_DIR ?? './runtime');
  const port = overrides.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const proxySetting = process.env.TRUST_PROXY?.trim();
  const trustProxy = overrides.trustProxy ?? (!proxySetting || proxySetting === 'false' ? false : proxySetting);
  if (trustProxy === 'true' || trustProxy === '*') throw new Error('TRUST_PROXY must identify a trusted proxy IP or CIDR.');
  const publicOrigin = overrides.publicOrigin ?? (process.env.PUBLIC_ORIGIN || undefined);
  if (publicOrigin) {
    try {
      const parsed = new URL(publicOrigin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin) throw new Error();
    } catch {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path or trailing slash.');
    }
  }
  return {
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port,
    runtimeDir,
    databasePath: overrides.databasePath ?? resolve(runtimeDir, 'baby-name-matcher.sqlite'),
    backupDir: overrides.backupDir ?? resolve(runtimeDir, 'backups'),
    webDist: overrides.webDist ?? resolve(process.env.WEB_DIST ?? './apps/web/dist'),
    cookieSecure:
      overrides.cookieSecure ??
      booleanFromEnvironment(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
    logLevel: overrides.logLevel ?? process.env.LOG_LEVEL ?? 'info',
    trustProxy,
    publicOrigin,
  };
}
