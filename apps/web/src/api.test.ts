import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, downloadBackup, synchronize } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('binds an uploaded outbox to its participant', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await synchronize('person-a', 4, []);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/sync');
    const options = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({ participantId: 'person-a', revision: 4, operations: [] });
    expect(options.credentials).toBe('same-origin');
  });

  it('downloads a backup without sending an invalid empty JSON request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('database', {
      headers: { 'Content-Disposition': 'attachment; filename="backup.sqlite"' },
    }));
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { createElement: () => link });
    await downloadBackup();
    const options = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).has('Content-Type')).toBe(false);
    expect(options.method).toBe('POST');
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.download).toBe('backup.sqlite');
  });

  it('surfaces session recovery errors with their HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Recover your session.' }), { status: 401 })));
    await expect(synchronize('person-a', 4, [])).rejects.toEqual(new ApiError('Recover your session.', 401));
  });
});
