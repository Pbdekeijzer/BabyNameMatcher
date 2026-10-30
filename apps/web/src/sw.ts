/// <reference lib="WebWorker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { openDB } from 'idb';
import type { BootstrapPayload, SyncOperation, SyncResponse } from '@baby-name-matcher/shared';
import { takeSyncBatch } from './sync-batches';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('sync', (event: Event) => {
  const syncEvent = event as SyncEvent;
  if (syncEvent.tag === 'baby-name-matcher-sync') syncEvent.waitUntil(syncOutbox());
});

async function syncOutbox(): Promise<void> {
  const db = await openDB('baby-name-matcher', 1);
  let bootstrap = (await db.get('state', 'bootstrap')) as BootstrapPayload | undefined;
  if (!bootstrap) return;

  let operations = takeSyncBatch(
    (await db.getAllFromIndex('outbox', 'sequence')) as SyncOperation[],
  );
  while (operations.length > 0) {
    const response = await fetch('/api/sync', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId: bootstrap.participant.id, revision: bootstrap.revision, operations }),
    });
    if (!response.ok) throw new Error(`Background sync failed with ${response.status}`);
    const body = (await response.json()) as SyncResponse;
    const finishedIds = [
      ...body.acknowledged,
      ...body.rejected.map((item) => item.operationId),
    ];
    if (finishedIds.length === 0) {
      throw new Error('The server did not acknowledge the background synchronization batch.');
    }

    const transaction = db.transaction(['state', 'outbox'], 'readwrite');
    await transaction.objectStore('state').put(body.bootstrap, 'bootstrap');
    for (const operationId of finishedIds) {
      await transaction.objectStore('outbox').delete(operationId);
    }
    await transaction.done;
    bootstrap = body.bootstrap;
    operations = takeSyncBatch(
      (await db.getAllFromIndex('outbox', 'sequence')) as SyncOperation[],
    );
  }

  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'SYNC_COMPLETE' });
}

clientsClaim();
