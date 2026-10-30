import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CATALOGUE_VERSION,
  type BootstrapPayload,
  type Decision,
  type Match,
  type OperationError,
  type SyncOperation,
  normalizeName,
} from '@baby-name-matcher/shared';
import { AppDatabase } from './database.js';
import {
  createPin,
  createRecoveryCode,
  createRoomCode,
  hashPin,
  hashToken,
  randomToken,
  stableShuffleKey,
  verifyPin,
} from './security.js';

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

interface RoomRow {
  id: string;
  public_code: string;
  invite_token_hash: string;
  pin_salt: string;
  pin_hash: string;
  revision: number;
  created_at: string;
}

interface ParticipantRow {
  id: string;
  room_id: string;
  role: 'creator' | 'partner';
  display_name: string;
  recovery_token_hash: string;
  created_at: string;
}

interface NameRow {
  id: string;
  room_id: string | null;
  display_name: string;
  normalized_name: string;
  category: 'male' | 'neutral' | 'custom';
  added_by: string | null;
  created_at: string;
}

interface DecisionRow {
  name_id: string;
  value: 'like' | 'pass' | null;
  sequence: number;
  updated_at: string;
}

interface MatchRow {
  name_id: string;
  matched_at: string;
}

interface OperationRow {
  status: 'accepted' | 'rejected';
  error: string | null;
}

export interface SessionContext {
  participantId: string;
  roomId: string;
  role: 'creator' | 'partner';
  displayName: string;
  deviceEpoch: string;
}

export interface CreatedRoom {
  participantId: string;
  roomId: string;
  sessionToken: string;
  inviteToken: string;
  pin: string;
  recoveryCode: string;
}

export interface JoinedRoom {
  participantId: string;
  roomId: string;
  sessionToken: string;
  recoveryCode: string;
}

export interface SyncResult {
  acknowledged: string[];
  rejected: OperationError[];
  changed: boolean;
}

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export class AppStore {
  private readonly sql: Database.Database;

  constructor(private readonly database: AppDatabase) {
    this.sql = database.connection;
  }

  createRoom(displayName: string, now = new Date()): CreatedRoom {
    const roomId = randomUUID();
    const participantId = randomUUID();
    const inviteToken = randomToken();
    const recoveryCode = createRecoveryCode();
    const pin = createPin();
    const pinHash = hashPin(pin);
    const sessionToken = randomToken();
    const deviceEpoch = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();

    let roomCode = createRoomCode();
    while (
      this.sql.prepare('SELECT 1 FROM rooms WHERE public_code = ?').get(roomCode) !== undefined
    ) {
      roomCode = createRoomCode();
    }

    this.sql.transaction(() => {
      this.sql
        .prepare(`
          INSERT INTO rooms
            (id, public_code, invite_token_hash, pin_salt, pin_hash, revision, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `)
        .run(roomId, roomCode, hashToken(inviteToken), pinHash.salt, pinHash.hash, createdAt);
      this.sql
        .prepare(`
          INSERT INTO participants
            (id, room_id, role, display_name, recovery_token_hash, created_at)
          VALUES (?, ?, 'creator', ?, ?, ?)
        `)
        .run(participantId, roomId, displayName, hashToken(recoveryCode), createdAt);
      this.sql
        .prepare(`
          INSERT INTO sessions
            (token_hash, participant_id, device_epoch, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(hashToken(sessionToken), participantId, deviceEpoch, expiresAt, createdAt);
    })();

    return {
      participantId,
      roomId,
      sessionToken,
      inviteToken,
      pin,
      recoveryCode,
    };
  }

  joinRoom(inviteToken: string, pin: string, displayName: string, now = new Date()): JoinedRoom {
    const room = this.sql
      .prepare('SELECT * FROM rooms WHERE invite_token_hash = ?')
      .get(hashToken(inviteToken)) as RoomRow | undefined;
    if (!room || !verifyPin(pin, room.pin_salt, room.pin_hash)) {
      throw new AppError('The invitation or PIN is not valid.', 401);
    }

    const existingPartner = this.sql
      .prepare("SELECT 1 FROM participants WHERE room_id = ? AND role = 'partner'")
      .get(room.id);
    if (existingPartner) {
      throw new AppError('This room already has two partners. Use your recovery code instead.', 409);
    }

    const participantId = randomUUID();
    const recoveryCode = createRecoveryCode();
    const sessionToken = randomToken();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
    this.sql.transaction(() => {
      this.sql
        .prepare(`
          INSERT INTO participants
            (id, room_id, role, display_name, recovery_token_hash, created_at)
          VALUES (?, ?, 'partner', ?, ?, ?)
        `)
        .run(participantId, room.id, displayName, hashToken(recoveryCode), createdAt);
      this.sql
        .prepare(`
          INSERT INTO sessions
            (token_hash, participant_id, device_epoch, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(hashToken(sessionToken), participantId, randomUUID(), expiresAt, createdAt);
      this.bumpRevision(room.id);
    })();

    return {
      participantId,
      roomId: room.id,
      sessionToken,
      recoveryCode,
    };
  }

  recover(roomCode: string, recoveryCode: string, now = new Date()): JoinedRoom {
    const participant = this.sql
      .prepare(`
        SELECT p.*
        FROM participants p
        JOIN rooms r ON r.id = p.room_id
        WHERE r.public_code = ? AND p.recovery_token_hash = ?
      `)
      .get(roomCode.toUpperCase(), hashToken(recoveryCode.toUpperCase())) as
      | ParticipantRow
      | undefined;
    if (!participant) throw new AppError('The room or recovery code is not valid.', 401);

    const sessionToken = randomToken();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
    this.sql.transaction(() => {
      this.sql.prepare('DELETE FROM sessions WHERE participant_id = ?').run(participant.id);
      this.sql
        .prepare(`
          INSERT INTO sessions
            (token_hash, participant_id, device_epoch, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(hashToken(sessionToken), participant.id, randomUUID(), expiresAt, createdAt);
    })();

    return {
      participantId: participant.id,
      roomId: participant.room_id,
      sessionToken,
      recoveryCode,
    };
  }

  authenticate(sessionToken: string | undefined, now = new Date()): SessionContext | null {
    if (!sessionToken) return null;
    const row = this.sql
      .prepare(`
        SELECT
          p.id AS participant_id,
          p.room_id,
          p.role,
          p.display_name,
          s.device_epoch
        FROM sessions s
        JOIN participants p ON p.id = s.participant_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `)
      .get(hashToken(sessionToken), now.toISOString()) as
      | {
          participant_id: string;
          room_id: string;
          role: 'creator' | 'partner';
          display_name: string;
          device_epoch: string;
        }
      | undefined;
    if (!row) return null;
    return {
      participantId: row.participant_id,
      roomId: row.room_id,
      role: row.role,
      displayName: row.display_name,
      deviceEpoch: row.device_epoch,
    };
  }

  getBootstrap(context: SessionContext): BootstrapPayload {
    const room = this.sql.prepare('SELECT * FROM rooms WHERE id = ?').get(context.roomId) as RoomRow;
    const participants = this.sql
      .prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY created_at')
      .all(context.roomId) as ParticipantRow[];
    const partner = participants.find((participant) => participant.id !== context.participantId);
    const names = this.sql
      .prepare(`
        SELECT * FROM names
        WHERE room_id IS NULL OR room_id = ?
        ORDER BY display_name COLLATE NOCASE
      `)
      .all(context.roomId) as NameRow[];
    const decisionRows = this.sql
      .prepare(`
        SELECT name_id, value, sequence, updated_at
        FROM decisions
        WHERE participant_id = ? AND value IS NOT NULL
        ORDER BY updated_at DESC
      `)
      .all(context.participantId) as DecisionRow[];
    const decisions: Decision[] = decisionRows
      .filter((decision): decision is DecisionRow & { value: 'like' | 'pass' } => decision.value !== null)
      .map((decision) => ({
        nameId: decision.name_id,
        value: decision.value,
        updatedAt: decision.updated_at,
      }));
    const matches = this.sql
      .prepare(`
        SELECT
          mine.name_id,
          CASE WHEN mine.updated_at > theirs.updated_at THEN mine.updated_at ELSE theirs.updated_at END AS matched_at
        FROM decisions mine
        JOIN participants other
          ON other.room_id = ? AND other.id <> mine.participant_id
        JOIN decisions theirs
          ON theirs.participant_id = other.id AND theirs.name_id = mine.name_id
        WHERE mine.participant_id = ? AND mine.value = 'like' AND theirs.value = 'like'
        ORDER BY matched_at DESC
      `)
      .all(context.roomId, context.participantId) as MatchRow[];
    const shortlist = this.sql
      .prepare(`
        SELECT s.name_id
        FROM shortlist s
        WHERE s.room_id = ?
          AND 2 = (
            SELECT COUNT(*)
            FROM decisions d
            JOIN participants p ON p.id = d.participant_id
            WHERE p.room_id = s.room_id AND d.name_id = s.name_id AND d.value = 'like'
          )
        ORDER BY s.updated_at DESC
      `)
      .all(context.roomId) as Array<{ name_id: string }>;
    const addedByMe = this.sql
      .prepare('SELECT id FROM names WHERE room_id = ? AND added_by = ? ORDER BY created_at DESC')
      .all(context.roomId, context.participantId) as Array<{ id: string }>;
    const ownDecisions = new Set(decisions.map((decision) => decision.nameId));
    const queue = names
      .filter((name) => !ownDecisions.has(name.id))
      .map((name) => ({
        id: name.id,
        tier: name.room_id !== null ? 0 : 1,
        shuffle: stableShuffleKey(context.participantId, name.id),
      }))
      .sort((left, right) => left.tier - right.tier || left.shuffle.localeCompare(right.shuffle))
      .map((name) => name.id);

    return {
      catalogueVersion: CATALOGUE_VERSION,
      revision: room.revision,
      lastSequence: (this.sql.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM operations WHERE participant_id = ?')
        .get(context.participantId) as { value: number }).value,
      room: {
        publicCode: room.public_code,
        partnerConnected: participants.length === 2,
      },
      participant: {
        id: context.participantId,
        displayName: context.displayName,
        role: context.role,
      },
      partnerName: partner?.display_name ?? null,
      names: names.map((name) => ({ id: name.id, displayName: name.display_name })),
      queue,
      decisions,
      matches: matches.map(
        (match): Match => ({ nameId: match.name_id, matchedAt: match.matched_at }),
      ),
      shortlist: shortlist.map((item) => item.name_id),
      addedByMe: addedByMe.map((item) => item.id),
    };
  }

  sync(context: SessionContext, operations: SyncOperation[]): SyncResult {
    const acknowledged: string[] = [];
    const rejected: OperationError[] = [];
    let changed = false;
    const sorted = [...operations].sort((left, right) => left.sequence - right.sequence);

    this.sql.transaction(() => {
      for (const operation of sorted) {
        const previous = this.sql
          .prepare(`
            SELECT status, error FROM operations
            WHERE participant_id = ? AND operation_id = ?
          `)
          .get(context.participantId, operation.operationId) as OperationRow | undefined;
        if (previous) {
          if (previous.status === 'accepted') acknowledged.push(operation.operationId);
          else rejected.push({ operationId: operation.operationId, message: previous.error ?? 'Rejected.' });
          continue;
        }

        try {
          changed = this.applyOperation(context, operation) || changed;
          this.recordOperation(context.participantId, operation, 'accepted', null);
          acknowledged.push(operation.operationId);
        } catch (error) {
          const message = error instanceof AppError ? error.message : 'The change could not be applied.';
          this.recordOperation(context.participantId, operation, 'rejected', message);
          rejected.push({ operationId: operation.operationId, message });
        }
      }
      if (changed) this.bumpRevision(context.roomId);
    })();

    return { acknowledged, rejected, changed };
  }

  private applyOperation(context: SessionContext, operation: SyncOperation): boolean {
    const now = new Date().toISOString();
    if (operation.kind === 'customName.add') {
      const normalized = normalizeName(operation.displayName);
      const duplicate = this.sql
        .prepare(`
          SELECT 1 FROM names
          WHERE normalized_name = ? AND (room_id IS NULL OR room_id = ?)
        `)
        .get(normalized, context.roomId);
      if (duplicate) throw new AppError('That name already exists in the list.');
      this.sql
        .prepare(`
          INSERT INTO names
            (id, room_id, display_name, normalized_name, category, added_by, created_at)
          VALUES (?, ?, ?, ?, 'custom', ?, ?)
        `)
        .run(
          operation.nameId,
          context.roomId,
          operation.displayName.trim().replace(/\s+/g, ' '),
          normalized,
          context.participantId,
          now,
        );
      return true;
    }

    this.assertNameAvailable(context.roomId, operation.nameId);
    if (operation.kind === 'decision.set' || operation.kind === 'decision.clear') {
      const value = operation.kind === 'decision.set' ? operation.value : null;
      const result = this.sql
        .prepare(`
          INSERT INTO decisions (participant_id, name_id, value, sequence, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(participant_id, name_id) DO UPDATE SET
            value = excluded.value,
            sequence = excluded.sequence,
            updated_at = excluded.updated_at
          WHERE excluded.sequence > decisions.sequence
        `)
        .run(context.participantId, operation.nameId, value, operation.sequence, now);
      if (result.changes > 0) {
        this.removeInvalidShortlist(context.roomId, operation.nameId);
        return true;
      }
      return false;
    }

    if (operation.shortlisted) {
      if (!this.isMatch(context.roomId, operation.nameId)) {
        throw new AppError('Only mutual matches can be shortlisted.');
      }
      const result = this.sql
        .prepare(`
          INSERT INTO shortlist (room_id, name_id, selected_by, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(room_id, name_id) DO UPDATE SET
            selected_by = excluded.selected_by,
            updated_at = excluded.updated_at
        `)
        .run(context.roomId, operation.nameId, context.participantId, now);
      return result.changes > 0;
    }
    return (
      this.sql
        .prepare('DELETE FROM shortlist WHERE room_id = ? AND name_id = ?')
        .run(context.roomId, operation.nameId).changes > 0
    );
  }

  private assertNameAvailable(roomId: string, nameId: string): void {
    const name = this.sql
      .prepare('SELECT 1 FROM names WHERE id = ? AND (room_id IS NULL OR room_id = ?)')
      .get(nameId, roomId);
    if (!name) throw new AppError('That name is not available in this room.');
  }

  private isMatch(roomId: string, nameId: string): boolean {
    const row = this.sql
      .prepare(`
        SELECT COUNT(*) AS likes
        FROM decisions d
        JOIN participants p ON p.id = d.participant_id
        WHERE p.room_id = ? AND d.name_id = ? AND d.value = 'like'
      `)
      .get(roomId, nameId) as { likes: number };
    return row.likes === 2;
  }

  private removeInvalidShortlist(roomId: string, nameId: string): void {
    if (!this.isMatch(roomId, nameId)) {
      this.sql
        .prepare('DELETE FROM shortlist WHERE room_id = ? AND name_id = ?')
        .run(roomId, nameId);
    }
  }

  private recordOperation(
    participantId: string,
    operation: SyncOperation,
    status: 'accepted' | 'rejected',
    error: string | null,
  ): void {
    this.sql
      .prepare(`
        INSERT INTO operations
          (participant_id, operation_id, sequence, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        participantId,
        operation.operationId,
        operation.sequence,
        status,
        error,
        new Date().toISOString(),
      );
  }

  private bumpRevision(roomId: string): void {
    this.sql.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(roomId);
  }
}
