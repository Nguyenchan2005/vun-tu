import { liveQuery, type Table } from 'dexie'

import type {
  AppSettings,
  Card,
  Deck,
  StudyLog,
  SyncEntityType,
  SyncMeta,
  SyncOutboxEntry,
} from '../models'
import { db, initializeDatabase } from '../db/database'
import {
  buildSyncUpsert,
  createSyncOutboxId,
  putSyncOutboxEntries,
} from '../db/outbox-helpers'

export interface ListSyncOutboxOptions {
  /** Omit to return every pending and failed entry, including delayed retries. */
  readyAt?: number
  limit?: number
}

export interface SyncOutboxAttemptResult {
  error?: string
  nextAttemptAt?: number
}

export interface SyncOutboxAttempt extends SyncOutboxAttemptResult {
  id: string
  revision: string
}

export interface SyncOutboxAcknowledgement {
  id: string
  revision: string
}

export interface LocalSyncOwnershipClaim {
  claimed: boolean
  ownerUid: string
}

export interface RestoredSyncEntities {
  decks?: readonly Deck[]
  cards?: readonly Card[]
  studyLogs?: readonly StudyLog[]
  settings?: AppSettings
}

export type SyncMetaUpdate = Partial<
  Omit<SyncMeta, 'uid' | 'ownsLocalData' | 'updatedAt'>
>

export type SyncOutboxListener = (pendingCount: number) => void

export async function listSyncOutbox(
  options: ListSyncOutboxOptions = {},
): Promise<SyncOutboxEntry[]> {
  await initializeDatabase()
  const readyAt = options.readyAt
  const query =
    readyAt === undefined
      ? db.syncOutbox.orderBy('queuedAt')
      : db.syncOutbox.where('availableAt').belowOrEqual(readyAt)

  if (options.limit === undefined) {
    return query.toArray()
  }
  const limit = Math.max(0, Math.floor(options.limit))
  return query.limit(limit).toArray()
}

export async function countSyncOutbox(): Promise<number> {
  await initializeDatabase()
  return db.syncOutbox.count()
}

export async function getSyncOutboxEntry(
  entityType: SyncEntityType,
  entityId: string,
): Promise<SyncOutboxEntry | undefined> {
  return getSyncOutboxEntryById(
    createSyncOutboxId(entityType, entityId),
  )
}

export async function getSyncOutboxEntryById(
  id: string,
): Promise<SyncOutboxEntry | undefined> {
  await initializeDatabase()
  return db.syncOutbox.get(id)
}

/**
 * Removes an acknowledged mutation. Pass the revision returned by list/get so
 * an in-flight acknowledgement cannot remove a newer local mutation.
 */
export async function deleteSyncOutboxEntry(
  id: string,
  expectedRevision?: string,
): Promise<boolean> {
  await initializeDatabase()
  if (expectedRevision !== undefined) {
    return (
      (await deleteSyncOutboxEntries([
        { id, revision: expectedRevision },
      ])) === 1
    )
  }

  return db.transaction('rw', db.syncOutbox, async () => {
    const current = await db.syncOutbox.get(id)
    if (!current) {
      return false
    }

    await db.syncOutbox.delete(id)
    return true
  })
}

export async function deleteSyncOutboxEntries(
  acknowledgements: readonly SyncOutboxAcknowledgement[],
): Promise<number> {
  await initializeDatabase()
  const expectedById = new Map(
    acknowledgements.map(({ id, revision }) => [id, revision]),
  )
  if (expectedById.size === 0) {
    return 0
  }

  return db.transaction('rw', db.syncOutbox, async () => {
    const currentEntries = await db.syncOutbox.bulkGet([
      ...expectedById.keys(),
    ])
    const acknowledgedIds = currentEntries
      .filter(
        (entry): entry is SyncOutboxEntry =>
          entry !== undefined &&
          expectedById.get(entry.id) === entry.revision,
      )
      .map((entry) => entry.id)

    await db.syncOutbox.bulkDelete(acknowledgedIds)
    return acknowledgedIds.length
  })
}

export async function markSyncOutboxAttempt(
  id: string,
  expectedRevision: string,
  result: SyncOutboxAttemptResult,
  attemptedAt = Date.now(),
): Promise<boolean> {
  return (
    (await markSyncOutboxAttempts(
      [{ id, revision: expectedRevision, ...result }],
      attemptedAt,
    )) === 1
  )
}

export async function markSyncOutboxAttempts(
  attempts: readonly SyncOutboxAttempt[],
  attemptedAt = Date.now(),
): Promise<number> {
  await initializeDatabase()
  const attemptById = new Map(
    attempts.map((attempt) => [attempt.id, attempt]),
  )
  if (attemptById.size === 0) {
    return 0
  }

  return db.transaction('rw', db.syncOutbox, async () => {
    const currentEntries = await db.syncOutbox.bulkGet([
      ...attemptById.keys(),
    ])
    const updatedEntries = currentEntries.flatMap((current) => {
      if (!current) {
        return []
      }
      const attempt = attemptById.get(current.id)
      if (!attempt || current.revision !== attempt.revision) {
        return []
      }

      const error = cleanOptionalText(attempt.error)
      return [
        {
          ...current,
          status: error ? 'failed' : 'pending',
          attemptCount: current.attemptCount + 1,
          lastAttemptAt: attemptedAt,
          nextAttemptAt: attempt.nextAttemptAt,
          availableAt: attempt.nextAttemptAt ?? attemptedAt,
          lastError: error,
          updatedAt: attemptedAt,
        } satisfies SyncOutboxEntry,
      ]
    })

    if (updatedEntries.length > 0) {
      await db.syncOutbox.bulkPut(updatedEntries)
    }
    return updatedEntries.length
  })
}

export async function clearSyncOutbox(): Promise<number> {
  await initializeDatabase()
  return db.transaction('rw', db.syncOutbox, async () => {
    const count = await db.syncOutbox.count()
    await db.syncOutbox.clear()
    return count
  })
}

/**
 * Enqueues the current state after a backup restore. The restore itself remains
 * responsible for writing entity tables; this only creates durable upserts.
 */
export async function queueRestoredEntities(
  entities: RestoredSyncEntities,
  queuedAt = Date.now(),
): Promise<number> {
  await initializeDatabase()
  return db.transaction('rw', db.syncOutbox, () =>
    queueRestoredEntitiesInTransaction(
      db.syncOutbox,
      entities,
      queuedAt,
    ),
  )
}

/**
 * Variant for restore code that already owns a transaction containing the
 * entity tables and `syncOutbox`.
 */
export async function queueRestoredEntitiesInTransaction(
  table: Table<SyncOutboxEntry, string>,
  entities: RestoredSyncEntities,
  queuedAt = Date.now(),
): Promise<number> {
  const entries = [
    ...(entities.decks ?? []).map((deck) =>
      buildSyncUpsert('deck', deck, queuedAt),
    ),
    ...(entities.cards ?? []).map((card) =>
      buildSyncUpsert('card', card, queuedAt),
    ),
    ...(entities.studyLogs ?? []).map((log) =>
      buildSyncUpsert('studyLog', log, queuedAt),
    ),
    ...(entities.settings
      ? [buildSyncUpsert('settings', entities.settings, queuedAt)]
      : []),
  ]

  await putSyncOutboxEntries(table, entries)
  return new Set(entries.map((entry) => entry.id)).size
}

export function subscribeToSyncOutbox(
  listener: SyncOutboxListener,
  onError?: (error: unknown) => void,
): () => void {
  const subscription = liveQuery(() =>
    db.syncOutbox.count(),
  ).subscribe({
    next: listener,
    error: (error: unknown) => onError?.(error),
  })

  return () => subscription.unsubscribe()
}

export async function getSyncMeta(
  uid: string,
): Promise<SyncMeta | undefined> {
  await initializeDatabase()
  return db.syncMeta.get(normalizeUid(uid))
}

export async function updateSyncMeta(
  uid: string,
  patch: SyncMetaUpdate,
  now = Date.now(),
): Promise<SyncMeta> {
  await initializeDatabase()
  const normalizedUid = normalizeUid(uid)
  return db.transaction('rw', db.syncMeta, async () => {
    const current = await db.syncMeta.get(normalizedUid)
    const next: SyncMeta = {
      ...current,
      ...patch,
      remoteCursorByEntity:
        patch.remoteCursorByEntity === undefined
          ? current?.remoteCursorByEntity
          : {
              ...current?.remoteCursorByEntity,
              ...patch.remoteCursorByEntity,
            },
      uid: normalizedUid,
      updatedAt: now,
    }
    await db.syncMeta.put(next)
    return next
  })
}

export async function deleteSyncMeta(uid: string): Promise<boolean> {
  await initializeDatabase()
  const normalizedUid = normalizeUid(uid)
  return db.transaction('rw', db.syncMeta, async () => {
    const existing = await db.syncMeta.get(normalizedUid)
    if (!existing) {
      return false
    }
    if (existing.ownsLocalData) {
      await db.syncMeta.put({
        uid: normalizedUid,
        ownsLocalData: true,
        updatedAt: Date.now(),
      })
    } else {
      await db.syncMeta.delete(normalizedUid)
    }
    return true
  })
}

export async function getLocalSyncOwnerUid(): Promise<string | undefined> {
  await initializeDatabase()
  const records = await db.syncMeta.toArray()
  return records.find((record) => record.ownsLocalData)?.uid
}

/**
 * Atomically claims the single local entity namespace. A different uid must
 * never sync until the user explicitly clears or migrates the local dataset.
 */
export async function claimLocalSyncOwnership(
  uid: string,
  now = Date.now(),
): Promise<LocalSyncOwnershipClaim> {
  await initializeDatabase()
  const normalizedUid = normalizeUid(uid)
  return db.transaction('rw', db.syncMeta, async () => {
    const records = await db.syncMeta.toArray()
    const owners = records.filter(
      (record) => record.ownsLocalData,
    )
    const conflictingOwner = owners.find(
      (owner) => owner.uid !== normalizedUid,
    )
    if (conflictingOwner) {
      return { claimed: false, ownerUid: conflictingOwner.uid }
    }
    if (owners.length > 0) {
      return { claimed: true, ownerUid: normalizedUid }
    }

    const current = await db.syncMeta.get(normalizedUid)
    await db.syncMeta.put({
      ...current,
      uid: normalizedUid,
      ownsLocalData: true,
      updatedAt: now,
    })
    return { claimed: true, ownerUid: normalizedUid }
  })
}

/**
 * Releases ownership only after an explicit local reset/migration. Signing out
 * alone must not call this or another account could inherit pending data.
 */
export async function releaseLocalSyncOwnership(
  expectedUid?: string,
  now = Date.now(),
): Promise<boolean> {
  await initializeDatabase()
  const normalizedExpectedUid =
    expectedUid === undefined ? undefined : normalizeUid(expectedUid)

  return db.transaction('rw', db.syncMeta, async () => {
    const records = await db.syncMeta.toArray()
    const owners = records.filter((record) => record.ownsLocalData)
    if (
      owners.length === 0 ||
      (normalizedExpectedUid !== undefined &&
        owners.some(
          (owner) => owner.uid !== normalizedExpectedUid,
        ))
    ) {
      return false
    }

    await db.syncMeta.bulkPut(
      owners.map((owner) => {
        const next = { ...owner, updatedAt: now }
        delete next.ownsLocalData
        return next
      }),
    )
    return true
  })
}

export async function clearAllSyncMeta(): Promise<number> {
  await initializeDatabase()
  return db.transaction('rw', db.syncMeta, async () => {
    const records = await db.syncMeta.toArray()
    const ownerMarkers = records
      .filter((record) => record.ownsLocalData)
      .map((record) => ({
        uid: record.uid,
        ownsLocalData: true,
        updatedAt: Date.now(),
      }))
    await db.syncMeta.clear()
    await db.syncMeta.bulkPut(ownerMarkers)
    return records.length
  })
}

function normalizeUid(uid: string): string {
  const normalized = uid.trim()
  if (!normalized) {
    throw new Error('Firebase uid must not be empty.')
  }
  return normalized
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}
