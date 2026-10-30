import Database from 'better-sqlite3';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { catalogue, normalizeName } from '@baby-name-matcher/shared';

const migrations = [
  `
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    public_code TEXT NOT NULL UNIQUE,
    invite_token_hash TEXT NOT NULL UNIQUE,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('creator', 'partner')),
    display_name TEXT NOT NULL,
    recovery_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, role)
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    device_epoch TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE names (
    id TEXT PRIMARY KEY,
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('male', 'neutral', 'custom')),
    added_by TEXT REFERENCES participants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX names_builtin_normalized
    ON names(normalized_name) WHERE room_id IS NULL;
  CREATE UNIQUE INDEX names_room_normalized
    ON names(room_id, normalized_name) WHERE room_id IS NOT NULL;

  CREATE TABLE decisions (
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    name_id TEXT NOT NULL REFERENCES names(id) ON DELETE CASCADE,
    value TEXT CHECK (value IN ('like', 'pass') OR value IS NULL),
    sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (participant_id, name_id)
  );

  CREATE TABLE shortlist (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name_id TEXT NOT NULL REFERENCES names(id) ON DELETE CASCADE,
    selected_by TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (room_id, name_id)
  );

  CREATE TABLE operations (
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
    error TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (participant_id, operation_id)
  );

  CREATE INDEX decisions_by_name ON decisions(name_id, value);
  CREATE INDEX sessions_by_participant ON sessions(participant_id);
  `,
];

export class AppDatabase {
  readonly connection: Database.Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new Database(path);
    this.connection.pragma('journal_mode = WAL');
    this.connection.pragma('foreign_keys = ON');
    this.connection.pragma('busy_timeout = 5000');
    this.migrate();
    this.seedCatalogue();
  }

  private migrate(): void {
    const currentVersion = this.connection.pragma('user_version', { simple: true }) as number;
    for (let index = currentVersion; index < migrations.length; index += 1) {
      const sql = migrations[index];
      if (!sql) continue;
      this.connection.transaction(() => {
        this.connection.exec(sql);
        this.connection.pragma(`user_version = ${index + 1}`);
      })();
    }
  }

  private seedCatalogue(): void {
    const insert = this.connection.prepare(`
      INSERT OR IGNORE INTO names
        (id, room_id, display_name, normalized_name, category, added_by, created_at)
      VALUES
        (@id, NULL, @displayName, @normalizedName, @category, NULL, @createdAt)
    `);
    const createdAt = '2026-09-04T00:00:00.000Z';
    this.connection.transaction(() => {
      for (const name of catalogue) {
        insert.run({
          id: name.id,
          displayName: name.displayName,
          normalizedName: normalizeName(name.displayName),
          category: name.category,
          createdAt,
        });
      }
    })();
  }

  close(): void {
    this.connection.close();
  }

  async backup(destination: string): Promise<string> {
    await mkdir(dirname(destination), { recursive: true });
    await this.connection.backup(destination);
    return destination;
  }

  async backupRoom(destination: string, roomId: string): Promise<void> {
    await this.backup(destination);
    const snapshot = new Database(destination);
    try {
      snapshot.pragma('journal_mode = DELETE');
      snapshot.pragma('foreign_keys = ON');
      snapshot.pragma('secure_delete = ON');
      snapshot.prepare('DELETE FROM rooms WHERE id <> ?').run(roomId);
      // Rebuild pages so the download cannot disclose other rooms through free space.
      snapshot.exec('VACUUM');
    } finally {
      snapshot.close();
    }
  }
}

export async function backupIfDue(
  database: AppDatabase,
  backupDir: string,
  now = new Date(),
): Promise<string | null> {
  await mkdir(backupDir, { recursive: true });
  const files = (await readdir(backupDir))
    .filter((file) => /^baby-name-matcher-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/.test(file))
    .map((file) => join(backupDir, file));
  const details = await Promise.all(
    files.map(async (file) => ({ file, modifiedAt: (await stat(file)).mtimeMs })),
  );
  details.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const newest = details[0];
  if (newest && now.getTime() - newest.modifiedAt < 24 * 60 * 60 * 1000) return null;

  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
  const destination = join(backupDir, `baby-name-matcher-${stamp}.sqlite`);
  await database.backup(destination);

  const afterBackup = [
    { file: destination, modifiedAt: now.getTime() },
    ...details.filter((detail) => detail.file !== destination),
  ].sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const obsolete of afterBackup.slice(14)) {
    await unlink(obsolete.file);
  }
  return basename(destination);
}
