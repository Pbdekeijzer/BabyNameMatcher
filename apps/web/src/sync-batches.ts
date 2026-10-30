export const SYNC_BATCH_SIZE = 200;

export function takeSyncBatch<T>(items: readonly T[]): T[] {
  return items.slice(0, SYNC_BATCH_SIZE);
}
