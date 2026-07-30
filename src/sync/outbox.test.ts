import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  claimLocalSyncOwnership,
  clearAllSyncMeta,
  clearStudyHistory,
  clearSyncOutbox,
  countSyncOutbox,
  createCard,
  createDeck,
  db,
  deleteCard,
  deleteDeck,
  deleteStudyLog,
  deleteSyncMeta,
  deleteSyncOutboxEntry,
  deleteSyncOutboxEntries,
  getLocalSyncOwnerUid,
  getSyncMeta,
  getSyncOutboxEntry,
  importCards,
  importCardsToNewDeck,
  initializeDatabase,
  listSyncOutbox,
  markSyncOutboxAttempt,
  persistReview,
  queueRestoredEntities,
  releaseLocalSyncOwnership,
  resetAppSettings,
  resetDeckProgress,
  subscribeToSyncOutbox,
  updateAppSettings,
  updateCard,
  updateDeck,
  updateSyncMeta,
} from '../db'
import type { AppSettings, Card, Deck, StudyLog } from '../models'

const DATABASE_STORES_V3 = {
  decks: '&id, name, createdAt, updatedAt',
  cards:
    '&id, deckId, nextReviewAt, [deckId+nextReviewAt], box, createdAt, updatedAt',
  studyLogs:
    '&id, cardId, deckId, reviewedAt, [deckId+reviewedAt], [cardId+reviewedAt]',
  settings: '&id',
  syncOutbox:
    '&id, revision, entityType, entityId, operation, status, queuedAt, nextAttemptAt, [entityType+entityId]',
  syncMeta: '&uid, updatedAt',
}

describe('offline sync outbox', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await initializeDatabase()
  })

  afterAll(async () => {
    db.close()
    await db.delete()
  })

  it('leaves system defaults out of the outbox on a fresh database', async () => {
    expect(db.verno).toBe(4)
    expect(await countSyncOutbox()).toBe(0)
    expect(
      await getSyncOutboxEntry('settings', 'app'),
    ).toBeUndefined()
  })

  it('backfills indexed retry availability when upgrading a v3 outbox', async () => {
    db.close()
    await db.delete()
    const legacyDatabase = new Dexie(db.name)
    legacyDatabase.version(3).stores(DATABASE_STORES_V3)
    await legacyDatabase.open()
    const outbox =
      legacyDatabase.table<Record<string, unknown>, string>(
        'syncOutbox',
      )
    await outbox.bulkPut([
      {
        id: 'deck:pending',
        revision: 'pending-revision',
        entityType: 'deck',
        entityId: 'pending',
        operation: 'delete',
        queuedAt: 1_000,
        updatedAt: 1_000,
        status: 'pending',
        attemptCount: 0,
      },
      {
        id: 'deck:delayed',
        revision: 'delayed-revision',
        entityType: 'deck',
        entityId: 'delayed',
        operation: 'delete',
        queuedAt: 2_000,
        updatedAt: 3_000,
        status: 'failed',
        attemptCount: 1,
        nextAttemptAt: 5_000,
      },
    ])
    legacyDatabase.close()

    await initializeDatabase()

    expect(db.verno).toBe(4)
    expect(await getSyncOutboxEntry('deck', 'pending')).toMatchObject({
      availableAt: 1_000,
    })
    expect(await getSyncOutboxEntry('deck', 'delayed')).toMatchObject({
      availableAt: 5_000,
    })
  })

  it('coalesces local mutations and emits cascade tombstones', async () => {
    await clearSyncOutbox()
    const deck = await createDeck(
      { name: 'Local deck', sourceType: 'manual' },
      1_000,
    )
    const created = await getSyncOutboxEntry('deck', deck.id)
    expect(created?.operation).toBe('upsert')

    await updateDeck(deck.id, { description: 'Changed' }, 2_000)
    const updated = await getSyncOutboxEntry('deck', deck.id)
    expect(updated?.revision).not.toBe(created?.revision)
    expect(updated?.payload).toMatchObject({
      id: deck.id,
      description: 'Changed',
      updatedAt: 2_000,
    })
    expect(await countSyncOutbox()).toBe(1)

    const card = await createCard(
      deck.id,
      { front: 'offline', back: 'ngoại tuyến' },
      3_000,
    )
    await updateCard(card.id, { notes: 'edited' }, 4_000)
    const review = await persistReview({
      cardId: card.id,
      rating: 'good',
      wasCorrect: true,
      boxAfter: 1,
      nextReviewAt: 10_000,
      reviewedAt: 5_000,
    })

    expect(await getSyncOutboxEntry('card', card.id)).toMatchObject({
      operation: 'upsert',
      payload: { reviewCount: 1, notes: 'edited' },
    })
    expect(
      await getSyncOutboxEntry('studyLog', review.log.id),
    ).toMatchObject({ operation: 'upsert' })

    await deleteCard(card.id)
    const cardTombstone = await getSyncOutboxEntry('card', card.id)
    expect(cardTombstone?.operation).toBe('delete')
    expect(cardTombstone).not.toHaveProperty('payload')
    expect(
      await getSyncOutboxEntry('studyLog', review.log.id),
    ).toMatchObject({ operation: 'delete' })

    await deleteDeck(deck.id)
    expect(await getSyncOutboxEntry('deck', deck.id)).toMatchObject({
      operation: 'delete',
    })
  })

  it('queues replace-import deletes and reset progress in their write transactions', async () => {
    const imported = await importCardsToNewDeck(
      { name: 'Import deck', sourceType: 'json' },
      [{ id: 'old-card', front: 'old', back: 'cũ' }],
    )
    const review = await persistReview({
      cardId: 'old-card',
      rating: 'remember',
      wasCorrect: true,
      boxAfter: 2,
      nextReviewAt: 20_000,
      reviewedAt: 10_000,
    })
    await clearSyncOutbox()

    await importCards({
      target: { kind: 'existing', deckId: imported.deck.id },
      mode: 'replace',
      cards: [{ id: 'new-card', front: 'new', back: 'mới' }],
      importedAt: 11_000,
    })

    expect(await getSyncOutboxEntry('card', 'old-card')).toMatchObject({
      operation: 'delete',
    })
    expect(
      await getSyncOutboxEntry('studyLog', review.log.id),
    ).toMatchObject({ operation: 'delete' })
    expect(await getSyncOutboxEntry('card', 'new-card')).toMatchObject({
      operation: 'upsert',
    })

    const secondReview = await persistReview({
      cardId: 'new-card',
      rating: 'good',
      wasCorrect: true,
      boxAfter: 3,
      nextReviewAt: 30_000,
      reviewedAt: 12_000,
    })
    await clearSyncOutbox()
    await resetDeckProgress(imported.deck.id, 13_000)

    expect(await getSyncOutboxEntry('card', 'new-card')).toMatchObject({
      operation: 'upsert',
      payload: { box: 0, reviewCount: 0, updatedAt: 13_000 },
    })
    expect(
      await getSyncOutboxEntry('studyLog', secondReview.log.id),
    ).toMatchObject({ operation: 'delete' })
    expect(
      await getSyncOutboxEntry('deck', imported.deck.id),
    ).toMatchObject({ operation: 'upsert' })
  })

  it('queues standalone study-log deletes and history clears', async () => {
    const imported = await importCardsToNewDeck(
      { name: 'History deck' },
      [{ id: 'history-card', front: 'history', back: 'lịch sử' }],
    )
    const first = await persistReview({
      cardId: 'history-card',
      rating: 'good',
      wasCorrect: true,
      boxAfter: 1,
      nextReviewAt: 20_000,
      reviewedAt: 10_000,
    })
    await clearSyncOutbox()

    expect(await deleteStudyLog(first.log.id)).toBe(true)
    expect(
      await getSyncOutboxEntry('studyLog', first.log.id),
    ).toMatchObject({ operation: 'delete' })

    const second = await persistReview({
      cardId: 'history-card',
      rating: 'hard',
      wasCorrect: true,
      boxAfter: 1,
      nextReviewAt: 30_000,
      reviewedAt: 11_000,
    })
    await clearSyncOutbox()

    expect(await clearStudyHistory(imported.deck.id)).toBe(1)
    expect(
      await getSyncOutboxEntry('studyLog', second.log.id),
    ).toMatchObject({ operation: 'delete' })
  })

  it('rolls back the entity write and outbox together on failure', async () => {
    const deck = await createDeck({ name: 'Atomic deck' }, 1_000)
    const card = await createCard(
      deck.id,
      { id: 'same-card', front: 'one', back: 'một' },
      2_000,
    )
    await clearSyncOutbox()
    const beforeDeck = await db.decks.get(deck.id)

    await expect(
      createCard(
        deck.id,
        { id: card.id, front: 'duplicate', back: 'trùng' },
        3_000,
      ),
    ).rejects.toBeTruthy()

    expect(await countSyncOutbox()).toBe(0)
    expect(await db.cards.get(card.id)).toEqual(card)
    expect(await db.decks.get(deck.id)).toEqual(beforeDeck)
  })

  it('keeps a newer revision when an older network request is acknowledged', async () => {
    await clearSyncOutbox()
    const deck = await createDeck({ name: 'Race safe' }, 1_000)
    const first = (await getSyncOutboxEntry('deck', deck.id))!

    await updateDeck(deck.id, { description: 'newer' }, 2_000)
    const newer = (await getSyncOutboxEntry('deck', deck.id))!

    expect(
      await deleteSyncOutboxEntry(first.id, first.revision),
    ).toBe(false)
    expect(await getSyncOutboxEntry('deck', deck.id)).toEqual(newer)
    expect(
      await deleteSyncOutboxEntry(newer.id, newer.revision),
    ).toBe(true)
  })

  it('bulk-acknowledges only unchanged revisions in one operation', async () => {
    await clearSyncOutbox()
    const deck = await createDeck({ name: 'Bulk ack' }, 1_000)
    const card = await createCard(
      deck.id,
      { front: 'batch', back: 'lô' },
      2_000,
    )
    const pushedBatch = await listSyncOutbox()

    await updateDeck(deck.id, { description: 'new revision' }, 3_000)
    expect(
      await deleteSyncOutboxEntries(
        pushedBatch.map((entry) => ({
          id: entry.id,
          revision: entry.revision,
        })),
      ),
    ).toBe(1)

    expect(await getSyncOutboxEntry('card', card.id)).toBeUndefined()
    expect(await getSyncOutboxEntry('deck', deck.id)).toMatchObject({
      operation: 'upsert',
      payload: { description: 'new revision' },
    })
  })

  it('tracks failed retries while all-entry and ready-only queries stay distinct', async () => {
    await clearSyncOutbox()
    const deck = await createDeck({ name: 'Retry deck' }, 1_000)
    const entry = (await getSyncOutboxEntry('deck', deck.id))!

    expect(
      await markSyncOutboxAttempt(
        entry.id,
        entry.revision,
        { error: ' offline ', nextAttemptAt: 5_000 },
        2_000,
      ),
    ).toBe(true)

    expect(await listSyncOutbox()).toHaveLength(1)
    expect(await listSyncOutbox({ readyAt: 4_999 })).toEqual([])
    expect(await listSyncOutbox({ readyAt: 5_000 })).toMatchObject([
      {
        status: 'failed',
        attemptCount: 1,
        lastError: 'offline',
      },
    ])
  })

  it('does not enqueue direct remote writes', async () => {
    await clearSyncOutbox()
    const remoteDeck = makeDeck('remote-deck', 7_000)
    const remoteCard = makeCard('remote-card', remoteDeck.id, 7_000)
    const remoteLog = makeLog(
      'remote-log',
      remoteCard.id,
      remoteDeck.id,
      7_000,
    )
    const remoteSettings = makeSettings(7_000)

    await db.transaction(
      'rw',
      db.decks,
      db.cards,
      db.studyLogs,
      db.settings,
      async () => {
        await db.decks.put(remoteDeck)
        await db.cards.put(remoteCard)
        await db.studyLogs.put(remoteLog)
        await db.settings.put(remoteSettings)
      },
    )

    expect(await countSyncOutbox()).toBe(0)
  })

  it('queues restored entities and stores independent metadata per uid', async () => {
    await clearSyncOutbox()
    const deck = makeDeck('restored-deck', 9_000)
    const card = makeCard('restored-card', deck.id, 9_000)
    const log = makeLog('restored-log', card.id, deck.id, 9_000)
    const settings = makeSettings(9_000)

    expect(
      await queueRestoredEntities(
        {
          decks: [deck],
          cards: [card],
          studyLogs: [log],
          settings,
        },
        10_000,
      ),
    ).toBe(4)
    expect(await countSyncOutbox()).toBe(4)

    await updateSyncMeta(
      ' user-a ',
      {
        remoteCursor: 100,
        remoteCursorByEntity: { deck: 101 },
        lastPulledAt: 11_000,
      },
      11_000,
    )
    await updateSyncMeta(
      'user-a',
      {
        remoteCursorByEntity: { card: 102 },
        lastPushedAt: 12_000,
        lastSuccessfulSyncAt: 12_000,
      },
      12_000,
    )
    await updateSyncMeta('user-b', { remoteCursor: 200 }, 13_000)

    expect(await getSyncMeta('user-a')).toEqual({
      uid: 'user-a',
      remoteCursor: 100,
      remoteCursorByEntity: { deck: 101, card: 102 },
      lastPulledAt: 11_000,
      lastPushedAt: 12_000,
      lastSuccessfulSyncAt: 12_000,
      updatedAt: 12_000,
    })
    expect(await deleteSyncMeta('user-a')).toBe(true)
    expect(await getSyncMeta('user-a')).toBeUndefined()
    expect(await clearAllSyncMeta()).toBe(1)
  })

  it('binds the whole local dataset to one uid until explicit release', async () => {
    expect(await getLocalSyncOwnerUid()).toBeUndefined()
    expect(await claimLocalSyncOwnership(' user-a ', 1_000)).toEqual({
      claimed: true,
      ownerUid: 'user-a',
    })
    expect(await getLocalSyncOwnerUid()).toBe('user-a')
    expect(await claimLocalSyncOwnership('user-a', 2_000)).toEqual({
      claimed: true,
      ownerUid: 'user-a',
    })
    await updateSyncMeta('user-a', { remoteCursor: 99 }, 2_500)
    expect(await deleteSyncMeta('user-a')).toBe(true)
    expect(await getLocalSyncOwnerUid()).toBe('user-a')
    expect(await getSyncMeta('user-a')).not.toHaveProperty(
      'remoteCursor',
    )
    expect(await clearAllSyncMeta()).toBe(1)
    expect(await getLocalSyncOwnerUid()).toBe('user-a')

    expect(await claimLocalSyncOwnership('user-b', 3_000)).toEqual({
      claimed: false,
      ownerUid: 'user-a',
    })
    expect(await releaseLocalSyncOwnership('user-b', 4_000)).toBe(
      false,
    )
    expect(await getLocalSyncOwnerUid()).toBe('user-a')

    expect(await releaseLocalSyncOwnership('user-a', 5_000)).toBe(
      true,
    )
    expect(await getLocalSyncOwnerUid()).toBeUndefined()
    expect(await claimLocalSyncOwnership('user-b', 6_000)).toEqual({
      claimed: true,
      ownerUid: 'user-b',
    })
  })

  it('notifies subscribers when a local mutation enters the outbox', async () => {
    await clearSyncOutbox()
    let unsubscribe: () => void = () => undefined
    const observed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Outbox subscription timed out.')),
        1_000,
      )
      unsubscribe = subscribeToSyncOutbox(
        (pendingCount) => {
          if (pendingCount > 0) {
            clearTimeout(timeout)
            resolve()
          }
        },
        reject,
      )
    })

    const deck = makeDeck('subscribed-deck', 15_000)
    await db.transaction('rw', db.decks, async () => {
      await db.decks.put(deck)
    })
    await queueRestoredEntities({ decks: [deck] }, 15_000)
    await observed
    unsubscribe()
  })

  it('queues settings changes as coalesced upserts', async () => {
    await clearSyncOutbox()
    await updateAppSettings({ dailyGoal: 25 }, 20_000)
    const first = (await getSyncOutboxEntry('settings', 'app'))!
    await updateAppSettings({ remindersEnabled: false }, 21_000)
    const second = (await getSyncOutboxEntry('settings', 'app'))!

    expect(await countSyncOutbox()).toBe(1)
    expect(second.revision).not.toBe(first.revision)
    expect(second.payload).toMatchObject({
      id: 'app',
      dailyGoal: 25,
      remindersEnabled: false,
      updatedAt: 21_000,
    })

    await resetAppSettings()
    const reset = (await getSyncOutboxEntry('settings', 'app'))!
    expect(await countSyncOutbox()).toBe(1)
    expect(reset.revision).not.toBe(second.revision)
    expect(reset.payload).toMatchObject({
      id: 'app',
      dailyGoal: 15,
      remindersEnabled: true,
    })
  })
})

function makeDeck(id: string, now: number): Deck {
  return {
    id,
    name: id,
    sourceType: 'manual',
    preferredDirection: 'en-vi',
    reminderEnabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

function makeCard(id: string, deckId: string, now: number): Card {
  return {
    id,
    deckId,
    front: id,
    back: id,
    box: 0,
    correctCount: 0,
    incorrectCount: 0,
    reviewCount: 0,
    streak: 0,
    nextReviewAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

function makeLog(
  id: string,
  cardId: string,
  deckId: string,
  now: number,
): StudyLog {
  return {
    id,
    cardId,
    deckId,
    rating: 'good',
    wasCorrect: true,
    boxBefore: 0,
    boxAfter: 1,
    reviewedAt: now,
    nextReviewAt: now,
  }
}

function makeSettings(now: number): AppSettings {
  return {
    id: 'app',
    preferredDirection: 'en-vi',
    remindersEnabled: true,
    reminderTimes: ['08:00'],
    dailyGoal: 10,
    lastNotificationBySlot: {},
    updatedAt: now,
  }
}
