import type { Table } from 'dexie'

import type {
  SyncEntityPayload,
  SyncEntityType,
  SyncOutboxEntry,
} from '../models'

export function createSyncOutboxId(
  entityType: SyncEntityType,
  entityId: string,
): string {
  return `${entityType}:${entityId}`
}

export function buildSyncUpsert(
  entityType: SyncEntityType,
  payload: SyncEntityPayload,
  queuedAt = Date.now(),
): SyncOutboxEntry {
  return {
    id: createSyncOutboxId(entityType, payload.id),
    revision: createSyncRevision(queuedAt),
    entityType,
    entityId: payload.id,
    operation: 'upsert',
    payload,
    queuedAt,
    availableAt: queuedAt,
    updatedAt: queuedAt,
    status: 'pending',
    attemptCount: 0,
  }
}

export function buildSyncDelete(
  entityType: SyncEntityType,
  entityId: string,
  queuedAt = Date.now(),
): SyncOutboxEntry {
  return {
    id: createSyncOutboxId(entityType, entityId),
    revision: createSyncRevision(queuedAt),
    entityType,
    entityId,
    operation: 'delete',
    queuedAt,
    availableAt: queuedAt,
    updatedAt: queuedAt,
    status: 'pending',
    attemptCount: 0,
  }
}

export async function putSyncOutboxEntries(
  table: Table<SyncOutboxEntry, string>,
  entries: readonly SyncOutboxEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return
  }

  const coalesced = new Map<string, SyncOutboxEntry>()
  for (const entry of entries) {
    coalesced.set(entry.id, entry)
  }
  await table.bulkPut([...coalesced.values()])
}

function createSyncRevision(now: number): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${now.toString(36)}-${Math.random().toString(36).slice(2)}`

  return `mutation-${randomPart}`
}
