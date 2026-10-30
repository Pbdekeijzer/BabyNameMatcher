import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BootstrapPayload, SyncOperation } from '@baby-name-matcher/shared';

interface MatcherDatabase extends DBSchema {
  state: {
    key: string;
    value: unknown;
  };
  outbox: {
    key: string;
    value: SyncOperation;
    indexes: { sequence: number };
  };
}

let databasePromise: Promise<IDBPDatabase<MatcherDatabase>> | undefined;

function database(): Promise<IDBPDatabase<MatcherDatabase>> {
  databasePromise ??= openDB<MatcherDatabase>('baby-name-matcher', 1, {
    upgrade(db) {
      db.createObjectStore('state');
      const outbox = db.createObjectStore('outbox', { keyPath: 'operationId' });
      outbox.createIndex('sequence', 'sequence');
    },
  });
  return databasePromise;
}

export async function loadBootstrap(): Promise<BootstrapPayload | null> {
  return ((await (await database()).get('state', 'bootstrap')) as BootstrapPayload | undefined) ?? null;
}

export async function saveBootstrap(bootstrap: BootstrapPayload): Promise<void> {
  const transaction = (await database()).transaction('state', 'readwrite');
  const localSequence = (await transaction.store.get('sequence')) as number | undefined;
  await transaction.store.put(Math.max(localSequence ?? 0, bootstrap.lastSequence ?? 0), 'sequence');
  await transaction.store.put(bootstrap, 'bootstrap');
  await transaction.done;
}

export async function enqueueOperation(
  operation: Omit<SyncOperation, 'operationId' | 'sequence' | 'clientCreatedAt'>,
  participantId: string,
): Promise<SyncOperation> {
  const db = await database();
  const transaction = db.transaction(['state', 'outbox'], 'readwrite');
  const bootstrap = await transaction.objectStore('state').get('bootstrap') as BootstrapPayload | undefined;
  if (bootstrap?.participant.id !== participantId) {
    throw new Error('This browser is signed in as a different participant. Reload before making changes.');
  }
  const lastSequence = ((await transaction.objectStore('state').get('sequence')) as number | undefined) ?? 0;
  const complete = {
    ...operation,
    operationId: crypto.randomUUID(),
    sequence: lastSequence + 1,
    clientCreatedAt: new Date().toISOString(),
  } as SyncOperation;
  await transaction.objectStore('state').put(complete.sequence, 'sequence');
  await transaction.objectStore('outbox').put(complete);
  await transaction.done;
  void registerBackgroundSync().catch(() => undefined);
  return complete;
}

async function registerBackgroundSync(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const backgroundRegistration = registration as ServiceWorkerRegistration & {
    sync?: { register(tag: string): Promise<void> };
  };
  await backgroundRegistration.sync?.register('baby-name-matcher-sync');
}

export async function pendingOperations(): Promise<SyncOperation[]> {
  const operations = await (await database()).getAllFromIndex('outbox', 'sequence');
  return operations.sort((left, right) => left.sequence - right.sequence);
}

export async function removeOperations(operationIds: string[]): Promise<void> {
  if (operationIds.length === 0) return;
  const transaction = (await database()).transaction('outbox', 'readwrite');
  await Promise.all(operationIds.map((id) => transaction.store.delete(id)));
  await transaction.done;
}

export async function resetForNewRoom(): Promise<void> {
  const transaction = (await database()).transaction(['state', 'outbox'], 'readwrite');
  await transaction.objectStore('state').clear();
  await transaction.objectStore('outbox').clear();
  await transaction.done;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
