import { copyFile, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase, backupIfDue } from './database.js';
import { AppStore } from './domain.js';

const DAY = 24 * 60 * 60 * 1000;

function scheduledFilename(date: Date): string {
  return `baby-name-matcher-${date.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '')}.sqlite`;
}

describe('scheduled SQLite backups', () => {
  let directory: string;
  let backupDirectory: string;
  let database: AppDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'baby-name-matcher-backup-test-'));
    backupDirectory = join(directory, 'backups');
    database = new AppDatabase(join(directory, 'live.sqlite'));
  });

  afterEach(() => {
    database.close();
  });

  it('creates a valid snapshot of committed WAL data that can restore a room', async () => {
    const store = new AppStore(database);
    const created = store.createRoom('Backup tester');
    const context = store.authenticate(created.sessionToken)!;
    const expectedRoom = store.getBootstrap(context).room.publicCode;
    const name = await backupIfDue(database, backupDirectory, new Date('2026-10-01T12:00:00Z'));
    expect(name).toBe('baby-name-matcher-2026-10-01T12-00-00.sqlite');
    const backupPath = join(backupDirectory, name!);

    const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.prepare('SELECT public_code FROM rooms WHERE id = ?').get(created.roomId))
        .toEqual({ public_code: expectedRoom });
    } finally {
      snapshot.close();
    }

    // A restore must reflect the snapshot, not data committed after it was taken.
    store.createRoom('Created after backup');
    const restoredPath = join(directory, 'restored.sqlite');
    await copyFile(backupPath, restoredPath);
    const restored = new AppDatabase(restoredPath);
    try {
      const restoredStore = new AppStore(restored);
      const restoredContext = restoredStore.authenticate(created.sessionToken);
      expect(restoredContext).not.toBeNull();
      expect(restoredStore.getBootstrap(restoredContext!).room.publicCode).toBe(expectedRoom);
      expect(restored.connection.prepare('SELECT COUNT(*) AS count FROM rooms').get())
        .toEqual({ count: 1 });
      expect(restored.connection.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restored.close();
    }
  });

  it('waits a full 24 hours and creates the next backup exactly at the threshold', async () => {
    const firstTime = new Date('2026-10-01T12:00:00Z');
    const first = await backupIfDue(database, backupDirectory, firstTime);
    expect(first).not.toBeNull();
    await utimes(join(backupDirectory, first!), firstTime, firstTime);

    expect(await backupIfDue(database, backupDirectory, new Date(firstTime.getTime() + DAY - 1)))
      .toBeNull();
    expect(await readdir(backupDirectory)).toEqual([first]);

    const nextTime = new Date(firstTime.getTime() + DAY);
    const next = await backupIfDue(database, backupDirectory, nextTime);
    expect(next).toBe(scheduledFilename(nextTime));
    expect((await readdir(backupDirectory)).sort()).toEqual([first, next].sort());
  });

  it('keeps 14 scheduled backups and leaves exports and unrelated files untouched', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    await mkdir(backupDirectory, { recursive: true });
    const historical: string[] = [];
    for (let age = 13; age >= 1; age -= 1) {
      const date = new Date(now.getTime() - age * DAY);
      const filename = scheduledFilename(date);
      historical.push(filename);
      const path = join(backupDirectory, filename);
      await writeFile(path, 'historical backup');
      await utimes(path, date, date);
    }
    const exportName = 'baby-name-matcher-export-2026-10-17T12-00-00.sqlite';
    const noteName = 'keep-this-note.txt';
    await writeFile(join(backupDirectory, exportName), 'private export');
    await writeFile(join(backupDirectory, noteName), 'keep this');
    // A newer manual export must not suppress the scheduled backup.
    const future = new Date(now.getTime() + 365 * DAY);
    await utimes(join(backupDirectory, exportName), future, future);

    const first = await backupIfDue(database, backupDirectory, now);
    expect(first).toBe(scheduledFilename(now));
    await utimes(join(backupDirectory, first!), now, now);
    expect((await readdir(backupDirectory)).sort())
      .toEqual([...historical, first, exportName, noteName].sort());

    const nextTime = new Date(now.getTime() + DAY);
    const next = await backupIfDue(database, backupDirectory, nextTime);
    expect(next).toBe(scheduledFilename(nextTime));
    expect((await readdir(backupDirectory)).sort())
      .toEqual([...historical.slice(1), first, next, exportName, noteName].sort());
    expect(await readFile(join(backupDirectory, exportName), 'utf8')).toBe('private export');
    expect(await readFile(join(backupDirectory, noteName), 'utf8')).toBe('keep this');
  });
});
