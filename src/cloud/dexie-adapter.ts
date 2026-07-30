import type {
  AppSettings,
  Card,
  Deck,
  StudyLog,
  SyncOutboxEntry,
} from '../models'
import {
  claimLocalSyncOwnership,
  countSyncOutbox,
  db,
  deleteSyncOutboxEntries,
  getSyncMeta,
  initializeDatabase,
  listSyncOutbox,
  markSyncOutboxAttempts,
  queueRestoredEntitiesInTransaction,
  subscribeToSyncOutbox,
  updateSyncMeta,
} from '../db'
import type {
  CloudSyncMeta,
  LocalEntitySnapshot,
  LocalSyncAdapter,
  PendingMutationSnapshot,
  RemoteEntity,
} from './types'

export class DexieLocalSyncAdapter implements LocalSyncAdapter {
  async claimOwnership(uid: string): Promise<{
    claimed: boolean
    ownerUid: string
  }> {
    return claimLocalSyncOwnership(uid)
  }

  async listLocal(): Promise<LocalEntitySnapshot[]> {
    await initializeDatabase()
    const [decks, cards, studyLogs, settings] = await Promise.all([
      db.decks.toArray(),
      db.cards.toArray(),
      db.studyLogs.toArray(),
      db.settings.get('app'),
    ])

    return [
      ...decks.map((payload) => localSnapshot('deck', payload)),
      ...cards.map((payload) => localSnapshot('card', payload)),
      ...studyLogs.map((payload) => localSnapshot('studyLog', payload)),
      ...(settings ? [localSnapshot('settings', settings)] : []),
    ]
  }

  async listPending(options: {
    readyAt?: number
    limit?: number
  } = {}): Promise<PendingMutationSnapshot[]> {
    return (await listSyncOutbox(options)).map(toPendingSnapshot)
  }

  async countPending(): Promise<number> {
    return countSyncOutbox()
  }

  async applyRemote(
    changes: readonly RemoteEntity[],
  ): Promise<RemoteEntity[]> {
    if (changes.length === 0) {
      return []
    }
    await initializeDatabase()

    return db.transaction(
      'rw',
      db.decks,
      db.cards,
      db.studyLogs,
      db.settings,
      db.syncOutbox,
      async () => {
        const pending = await db.syncOutbox.bulkGet(
          changes.map(
            (change) => `${change.entityType}:${change.entityId}`,
          ),
        )
        const safeChanges = changes.filter(
          (_change, index) => pending[index] === undefined,
        )
        const grouped = groupRemoteChanges(safeChanges)
        await Promise.all([
          db.decks.bulkPut(grouped.deckUpserts),
          db.cards.bulkPut(grouped.cardUpserts),
          db.studyLogs.bulkPut(grouped.logUpserts),
          db.settings.bulkPut(grouped.settingsUpserts),
          db.decks.bulkDelete(grouped.deckDeletes),
          db.cards.bulkDelete(grouped.cardDeletes),
          db.studyLogs.bulkDelete(grouped.logDeletes),
          db.settings.bulkDelete(grouped.settingsDeletes),
        ])
        return safeChanges
      },
    )
  }

  async queueBootstrap(
    entities: readonly LocalEntitySnapshot[],
  ): Promise<void> {
    const decks: Deck[] = []
    const cards: Card[] = []
    const studyLogs: StudyLog[] = []
    let settings: AppSettings | undefined

    for (const entity of entities) {
      if (entity.entityType === 'deck') {
        decks.push(entity.payload as Deck)
      } else if (entity.entityType === 'card') {
        cards.push(entity.payload as Card)
      } else if (entity.entityType === 'studyLog') {
        studyLogs.push(entity.payload as StudyLog)
      } else {
        settings = entity.payload as AppSettings
      }
    }
    await initializeDatabase()
    await db.transaction('rw', db.syncOutbox, async () => {
      const candidates = [
        ...decks.map((payload) => localSnapshot('deck', payload)),
        ...cards.map((payload) => localSnapshot('card', payload)),
        ...studyLogs.map((payload) =>
          localSnapshot('studyLog', payload),
        ),
        ...(settings ? [localSnapshot('settings', settings)] : []),
      ]
      const existing = await db.syncOutbox.bulkGet(
        candidates.map(
          (entity) => `${entity.entityType}:${entity.entityId}`,
        ),
      )
      const safe = candidates.filter(
        (_entity, index) => existing[index] === undefined,
      )
      const safeDecks = safe
        .filter((entity) => entity.entityType === 'deck')
        .map((entity) => entity.payload as Deck)
      const safeCards = safe
        .filter((entity) => entity.entityType === 'card')
        .map((entity) => entity.payload as Card)
      const safeLogs = safe
        .filter((entity) => entity.entityType === 'studyLog')
        .map((entity) => entity.payload as StudyLog)
      const safeSettings = safe.find(
        (entity) => entity.entityType === 'settings',
      )?.payload as AppSettings | undefined

      await queueRestoredEntitiesInTransaction(
        db.syncOutbox,
        {
          decks: safeDecks,
          cards: safeCards,
          studyLogs: safeLogs,
          settings: safeSettings,
        },
      )
    })
  }

  async acknowledgeMany(
    entries: readonly { id: string; revision: string }[],
  ): Promise<void> {
    await deleteSyncOutboxEntries(entries)
  }

  async markFailedMany(
    entries: readonly {
      id: string
      revision: string
      error: string
      nextAttemptAt: number
    }[],
  ): Promise<void> {
    await markSyncOutboxAttempts(entries)
  }

  async getMeta(uid: string): Promise<CloudSyncMeta | undefined> {
    return getSyncMeta(uid)
  }

  async updateMeta(
    uid: string,
    patch: Partial<Omit<CloudSyncMeta, 'uid'>>,
  ): Promise<void> {
    await updateSyncMeta(uid, patch)
  }

  subscribeToPending(listener: () => void): () => void {
    return subscribeToSyncOutbox(() => listener())
  }
}

interface GroupedRemoteChanges {
  deckUpserts: Deck[]
  cardUpserts: Card[]
  logUpserts: StudyLog[]
  settingsUpserts: AppSettings[]
  deckDeletes: string[]
  cardDeletes: string[]
  logDeletes: string[]
  settingsDeletes: string[]
}

function groupRemoteChanges(
  changes: readonly RemoteEntity[],
): GroupedRemoteChanges {
  const grouped: GroupedRemoteChanges = {
    deckUpserts: [],
    cardUpserts: [],
    logUpserts: [],
    settingsUpserts: [],
    deckDeletes: [],
    cardDeletes: [],
    logDeletes: [],
    settingsDeletes: [],
  }

  for (const change of changes) {
    const deleteTarget =
      change.operation === 'delete'
        ? {
            deck: grouped.deckDeletes,
            card: grouped.cardDeletes,
            studyLog: grouped.logDeletes,
            settings: grouped.settingsDeletes,
          }[change.entityType]
        : null
    if (deleteTarget) {
      deleteTarget.push(change.entityId)
    } else if (change.payload && change.entityType === 'deck') {
      grouped.deckUpserts.push(change.payload as Deck)
    } else if (change.payload && change.entityType === 'card') {
      grouped.cardUpserts.push(change.payload as Card)
    } else if (change.payload && change.entityType === 'studyLog') {
      grouped.logUpserts.push(change.payload as StudyLog)
    } else if (
      change.payload &&
      change.entityType === 'settings' &&
      change.entityId === 'app'
    ) {
      grouped.settingsUpserts.push(change.payload as AppSettings)
    }
  }
  return grouped
}

function localSnapshot(
  entityType: 'deck',
  payload: Deck,
): LocalEntitySnapshot
function localSnapshot(
  entityType: 'card',
  payload: Card,
): LocalEntitySnapshot
function localSnapshot(
  entityType: 'studyLog',
  payload: StudyLog,
): LocalEntitySnapshot
function localSnapshot(
  entityType: 'settings',
  payload: AppSettings,
): LocalEntitySnapshot
function localSnapshot(
  entityType: LocalEntitySnapshot['entityType'],
  payload: LocalEntitySnapshot['payload'],
): LocalEntitySnapshot {
  return {
    entityType,
    entityId: payload.id,
    payload,
  } as LocalEntitySnapshot
}

function toPendingSnapshot(
  entry: SyncOutboxEntry,
): PendingMutationSnapshot {
  return {
    id: entry.id,
    revision: entry.revision,
    entityType: entry.entityType,
    entityId: entry.entityId,
    operation: entry.operation,
    payload: entry.payload,
    queuedAt: entry.queuedAt,
    attemptCount: entry.attemptCount,
    nextAttemptAt: entry.nextAttemptAt,
    lastError: entry.lastError,
  }
}
