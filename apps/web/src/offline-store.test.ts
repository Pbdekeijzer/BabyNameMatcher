import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BootstrapPayload } from '@baby-name-matcher/shared';
import {
  enqueueOperation,
  loadBootstrap,
  pendingOperations,
  resetForNewRoom,
  saveBootstrap,
} from './offline-store';

function bootstrap(participantId = 'person-a', lastSequence = 0): BootstrapPayload {
  return {
    catalogueVersion: 'test',
    revision: 1,
    lastSequence,
    room: { publicCode: 'ROOM1234', partnerConnected: false },
    participant: { id: participantId, displayName: 'Alex', role: 'creator' },
    partnerName: null,
    names: [{ id: 'one', displayName: 'Arthur' }],
    queue: ['one'],
    decisions: [],
    matches: [],
    shortlist: [],
    addedByMe: [],
  };
}

describe('offline operation persistence', () => {
  beforeEach(async () => {
    await resetForNewRoom();
  });

  it('continues above the server sequence after recovery in a fresh browser', async () => {
    await saveBootstrap(bootstrap('person-a', 20));

    const operation = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-a',
    );

    expect(operation.sequence).toBe(21);
    expect(await pendingOperations()).toEqual([operation]);
  });

  it('does not rewind the local counter when a lower server snapshot arrives', async () => {
    await saveBootstrap(bootstrap('person-a', 20));
    await enqueueOperation({ kind: 'decision.clear', nameId: 'one' }, 'person-a');
    await saveBootstrap(bootstrap('person-a', 5));

    const next = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-a',
    );

    expect(next.sequence).toBe(22);
  });

  it('starts a new room at sequence one after resetting the old room', async () => {
    await saveBootstrap(bootstrap('person-a', 20));
    await enqueueOperation({ kind: 'decision.clear', nameId: 'one' }, 'person-a');

    await resetForNewRoom();
    await saveBootstrap(bootstrap('person-b'));
    const operation = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-b',
    );

    expect(operation.sequence).toBe(1);
    expect(await pendingOperations()).toEqual([operation]);
  });

  it('rejects a stale participant without writing their operation into another account', async () => {
    await saveBootstrap(bootstrap('person-b'));

    await expect(
      enqueueOperation({ kind: 'decision.clear', nameId: 'one' }, 'person-a'),
    ).rejects.toThrow();

    expect(await pendingOperations()).toEqual([]);
    expect((await loadBootstrap())?.participant.id).toBe('person-b');
    const valid = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-b',
    );
    expect(valid.sequence).toBe(1);
  });

  it('preserves pending operations when saving a newer server snapshot', async () => {
    await saveBootstrap(bootstrap());
    const operation = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-a',
    );
    const updated = { ...bootstrap('person-a', 10), revision: 2 };

    await saveBootstrap(updated);

    expect(await pendingOperations()).toEqual([operation]);
    expect(await loadBootstrap()).toEqual(updated);
    const next = await enqueueOperation(
      { kind: 'decision.clear', nameId: 'one' },
      'person-a',
    );
    expect(next.sequence).toBe(11);
  });
});
