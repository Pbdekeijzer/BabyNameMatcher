import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogue, type SyncOperation } from '@baby-name-matcher/shared';
import { AppDatabase } from './database.js';
import { AppStore } from './domain.js';

describe('baby name matching domain', () => {
  let database: AppDatabase;
  let store: AppStore;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    store = new AppStore(database);
  });

  afterEach(() => {
    database.close();
  });

  function createCouple() {
    const created = store.createRoom('Alex');
    const creator = store.authenticate(created.sessionToken);
    expect(creator).not.toBeNull();
    const joined = store.joinRoom(created.inviteToken, created.pin, 'Robin');
    const partner = store.authenticate(joined.sessionToken);
    expect(partner).not.toBeNull();
    return {
      created,
      joined,
      creator: creator!,
      partner: partner!,
    };
  }

  function decision(
    sequence: number,
    nameId: string,
    value: 'like' | 'pass',
  ): SyncOperation {
    return {
      operationId: randomUUID(),
      sequence,
      kind: 'decision.set',
      nameId,
      value,
    };
  }

  it('ships the requested catalogue shape', () => {
    expect(catalogue).toHaveLength(2849);
    expect(catalogue.filter((name) => name.category === 'male')).toHaveLength(2699);
    expect(catalogue.filter((name) => name.category === 'neutral')).toHaveLength(150);
    expect(new Set(catalogue.map((name) => name.displayName.toLocaleLowerCase())).size).toBe(2849);
    expect(catalogue.map((name) => name.displayName)).toEqual(
      expect.arrayContaining([
        'Léo',
        'Maël',
        'Gabin',
        'Marceau',
        'Gaspard',
        'Augustin',
        'Antoine',
        'Roméo',
        'Edoardo',
        'Cesare',
        'Alvaro',
        'Iker',
        'Biel',
        'Carter',
        'Darragh',
        'Hudson',
        'Oisín',
        'Tadhg',
        'Beauden',
      ]),
    );
    expect(catalogue.map((name) => name.displayName)).not.toContain('Total');
  });

  it('creates exactly two private participant seats', () => {
    const couple = createCouple();
    const creatorState = store.getBootstrap(couple.creator);
    const partnerState = store.getBootstrap(couple.partner);

    expect(creatorState.room.partnerConnected).toBe(true);
    expect(creatorState.partnerName).toBe('Robin');
    expect(partnerState.partnerName).toBe('Alex');
    expect(() =>
      store.joinRoom(couple.created.inviteToken, couple.created.pin, 'Third'),
    ).toThrow(/already has two/i);
  });

  it('keeps a participant queue unchanged when their partner reviews a name', () => {
    const couple = createCouple();
    const partnerQueueBefore = store.getBootstrap(couple.partner).queue;
    const candidate = store
      .getBootstrap(couple.creator)
      .queue.find((nameId) => nameId !== partnerQueueBefore[0])!;
    store.sync(couple.creator, [decision(1, candidate, 'pass')]);

    const partnerState = store.getBootstrap(couple.partner);
    expect(partnerState.queue).toEqual(partnerQueueBefore);
    expect(partnerState.decisions).toEqual([]);
    expect(partnerState.matches).toEqual([]);
  });

  it('reveals mutual likes and removes invalidated matches and shortlist entries', () => {
    const couple = createCouple();
    const candidate = store.getBootstrap(couple.creator).queue[0]!;
    store.sync(couple.creator, [decision(1, candidate, 'like')]);
    store.sync(couple.partner, [decision(1, candidate, 'like')]);
    expect(store.getBootstrap(couple.creator).matches.map((match) => match.nameId)).toContain(
      candidate,
    );

    store.sync(couple.creator, [
      {
        operationId: randomUUID(),
        sequence: 2,
        kind: 'shortlist.set',
        nameId: candidate,
        shortlisted: true,
      },
    ]);
    expect(store.getBootstrap(couple.partner).shortlist).toContain(candidate);

    store.sync(couple.partner, [decision(2, candidate, 'pass')]);
    expect(store.getBootstrap(couple.creator).matches).toEqual([]);
    expect(store.getBootstrap(couple.creator).shortlist).toEqual([]);
  });

  it('adds a private-attribution custom name and rejects normalized duplicates idempotently', () => {
    const couple = createCouple();
    const customId = randomUUID();
    const operation: SyncOperation = {
      operationId: randomUUID(),
      sequence: 1,
      kind: 'customName.add',
      nameId: customId,
      displayName: '  Paxwren  ',
    };
    const first = store.sync(couple.creator, [operation]);
    const repeated = store.sync(couple.creator, [operation]);

    expect(first.acknowledged).toEqual([operation.operationId]);
    expect(repeated.acknowledged).toEqual([operation.operationId]);
    expect(store.getBootstrap(couple.creator).addedByMe).toContain(customId);
    expect(store.getBootstrap(couple.partner).names).toContainEqual({
      id: customId,
      displayName: 'Paxwren',
    });

    const duplicate = store.sync(couple.partner, [
      {
        operationId: randomUUID(),
        sequence: 1,
        kind: 'customName.add',
        nameId: randomUUID(),
        displayName: 'paxwren',
      },
    ]);
    expect(duplicate.rejected[0]?.message).toBe('That name already exists in the list.');
  });

  it('uses decision tombstones so late operations cannot resurrect old votes', () => {
    const couple = createCouple();
    const candidate = store.getBootstrap(couple.creator).queue[0]!;
    const lateLike = decision(1, candidate, 'like');
    store.sync(couple.creator, [
      {
        operationId: randomUUID(),
        sequence: 2,
        kind: 'decision.clear',
        nameId: candidate,
      },
    ]);
    store.sync(couple.creator, [lateLike]);
    expect(store.getBootstrap(couple.creator).decisions).toEqual([]);
  });

  it('invalidates an old session during recovery', () => {
    const couple = createCouple();
    const roomCode = store.getBootstrap(couple.partner).room.publicCode;
    const recovered = store.recover(roomCode, couple.joined.recoveryCode);

    expect(store.authenticate(couple.joined.sessionToken)).toBeNull();
    expect(store.authenticate(recovered.sessionToken)?.participantId).toBe(
      couple.partner.participantId,
    );
  });

  it('supplies a recovery sequence floor including cleared decision tombstones', () => {
    const couple = createCouple();
    const candidate = store.getBootstrap(couple.creator).queue[0]!;
    store.sync(couple.creator, [decision(20, candidate, 'like')]);
    store.sync(couple.creator, [{ operationId: randomUUID(), sequence: 21, kind: 'decision.clear', nameId: candidate }]);
    const recovered = store.recover(store.getBootstrap(couple.creator).room.publicCode, couple.created.recoveryCode);
    const context = store.authenticate(recovered.sessionToken)!;
    const bootstrap = store.getBootstrap(context);
    expect(bootstrap.lastSequence).toBe(21);
    expect(bootstrap.decisions).toEqual([]);
    const result = store.sync(context, [decision(bootstrap.lastSequence + 1, candidate, 'pass')]);
    expect(result.rejected).toEqual([]);
    expect(store.getBootstrap(context).decisions[0]?.value).toBe('pass');
  });

  it('rejects access to custom names from other rooms', () => {
    const couple = createCouple();
    const other = store.createRoom('Other');
    const customId = randomUUID();
    const context = store.authenticate(other.sessionToken)!;
    store.sync(context, [{ operationId: randomUUID(), sequence: 1, kind: 'customName.add', nameId: customId, displayName: 'Paxwren' }]);
    expect(store.getBootstrap(couple.creator).names.some((name) => name.id === customId)).toBe(false);
    expect(store.sync(couple.creator, [decision(1, customId, 'like')]).rejected).toHaveLength(1);
    expect(store.getBootstrap(couple.creator).decisions).toEqual([]);
  });
});
