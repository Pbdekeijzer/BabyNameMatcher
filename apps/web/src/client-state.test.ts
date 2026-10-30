import { describe, expect, it } from 'vitest';
import type { BootstrapPayload, SyncOperation } from '@baby-name-matcher/shared';
import { applyPendingOperations } from './client-state';
import { SYNC_BATCH_SIZE, takeSyncBatch } from './sync-batches';

const canonical: BootstrapPayload = {
  catalogueVersion: 'test',
  revision: 4,
  lastSequence: 0,
  room: { publicCode: 'ROOM1234', partnerConnected: true },
  participant: { id: 'person-a', displayName: 'Alex', role: 'creator' },
  partnerName: 'Robin',
  names: [
    { id: 'one', displayName: 'Arthur' },
    { id: 'two', displayName: 'Robin' },
  ],
  queue: ['one', 'two'],
  decisions: [],
  matches: [],
  shortlist: [],
  addedByMe: [],
};

describe('offline client state', () => {
  it('caps each upload batch so large offline outboxes can drain safely', () => {
    const queued = Array.from({ length: 1000 }, (_, index) => index);
    expect(SYNC_BATCH_SIZE).toBe(200);
    expect(takeSyncBatch(queued)).toEqual(queued.slice(0, 200));
  });

  it('replays queued decisions in order without changing canonical state', () => {
    const operations: SyncOperation[] = [
      {
        operationId: '792328a6-bc8b-4bd0-ac4e-4315372bcd55',
        sequence: 1,
        clientCreatedAt: '2026-09-04T12:00:00.000Z',
        kind: 'decision.set',
        nameId: 'one',
        value: 'like',
      },
      {
        operationId: '26a873ac-e4db-4f15-8028-6368d66ec32d',
        sequence: 2,
        clientCreatedAt: '2026-09-04T12:01:00.000Z',
        kind: 'decision.set',
        nameId: 'two',
        value: 'pass',
      },
    ];

    const optimistic = applyPendingOperations(canonical, operations);
    expect(optimistic.queue).toEqual([]);
    expect(optimistic.decisions.map((decision) => decision.nameId)).toEqual(['two', 'one']);
    expect(canonical.queue).toEqual(['one', 'two']);
  });

  it('keeps custom-name authorship local and supports clearing a pending vote', () => {
    const customId = '2adc0cc9-da21-4889-9a75-de106af00733';
    const optimistic = applyPendingOperations(canonical, [
      {
        operationId: 'fc99da85-d1dc-43cb-953d-094a07f18cf1',
        sequence: 1,
        kind: 'customName.add',
        nameId: customId,
        displayName: 'Paxwren',
      },
      {
        operationId: '4a6818b1-7257-4881-a7fc-dfe51c942b55',
        sequence: 2,
        kind: 'decision.set',
        nameId: customId,
        value: 'like',
      },
      {
        operationId: '0edc7d48-68d7-42d6-9e88-1fd3957aa963',
        sequence: 3,
        kind: 'decision.clear',
        nameId: customId,
      },
    ]);

    expect(optimistic.addedByMe).toEqual([customId]);
    expect(optimistic.decisions).toEqual([]);
    expect(optimistic.queue[0]).toBe(customId);
  });
});
