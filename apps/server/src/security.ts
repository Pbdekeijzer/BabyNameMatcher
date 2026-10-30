import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createRoomCode(length = 8): string {
  return Array.from({ length }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

export function createPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function createRecoveryCode(): string {
  const raw = randomToken(24).toUpperCase();
  return raw.match(/.{1,6}/g)?.join('-') ?? raw;
}

export function hashPin(pin: string, salt = randomBytes(16).toString('hex')): {
  salt: string;
  hash: string;
} {
  return {
    salt,
    hash: scryptSync(pin, salt, 32).toString('hex'),
  };
}

export function verifyPin(pin: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(pin, salt, 32);
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function stableShuffleKey(participantId: string, nameId: string): string {
  return createHash('sha256').update(`${participantId}:${nameId}`).digest('hex');
}
