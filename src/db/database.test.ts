import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  db,
  getAppSettings,
  getStudyStats,
  importCardsToNewDeck,
  initializeDatabase,
  persistReview,
  setDeckReminderEnabled,
} from '.'
import { getDueReminderSummary } from '../lib/reminders'
import type { AppSettings, Card, Deck, StudyLog } from '../models'

const LEGACY_DATABASE_STORES = {
  decks: '&id, name, createdAt, updatedAt',
  cards:
    '&id, deckId, nextReviewAt, [deckId+nextReviewAt], box, createdAt, updatedAt',
  studyLogs:
    '&id, cardId, deckId, reviewedAt, [deckId+reviewedAt], [cardId+reviewedAt]',
  settings: '&id',
}

describe('IndexedDB repositories', () => {
  beforeEach(async () => {
    db.close()
    await db.delete()
    await initializeDatabase()
  })

  afterAll(async () => {
    db.close()
    await db.delete()
  })

  it('creates an empty library with app settings and stays empty after reopen', async () => {
    expect(await db.decks.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.studyLogs.count()).toBe(0)

    const settings = await getAppSettings()
    expect(settings).toMatchObject({
      id: 'app',
      preferredDirection: 'en-vi',
      remindersEnabled: true,
      dailyGoal: 15,
    })
    expect(settings).not.toHaveProperty('seededAt')

    db.close()
    await initializeDatabase()

    expect(await db.decks.count()).toBe(0)
    expect(await db.cards.count()).toBe(0)
    expect(await db.settings.count()).toBe(1)
  })

  it('migrates only legacy demo records and preserves user data and settings', async () => {
    db.close()
    await db.delete()

    const now = 1_800_000_000_000
    const legacyDatabase = new Dexie(db.name)
    legacyDatabase.version(1).stores(LEGACY_DATABASE_STORES)
    await legacyDatabase.open()

    const decks = legacyDatabase.table<Deck, string>('decks')
    const cards = legacyDatabase.table<Card, string>('cards')
    const studyLogs =
      legacyDatabase.table<StudyLog, string>('studyLogs')
    const settings =
      legacyDatabase.table<AppSettings, string>('settings')

    const demoBySource = makeDeck(
      'legacy-sample',
      'Demo marked by source',
      'demo',
      now,
    )
    const demoById = makeDeck(
      'demo-legacy-deck',
      'Demo marked by id',
      'manual',
      now,
    )
    const userDeck = makeDeck(
      'user-deck',
      'Giao tiếp hằng ngày',
      'csv',
      now,
    )
    const legacySettings: AppSettings = {
      id: 'app',
      preferredDirection: 'random',
      remindersEnabled: false,
      reminderTimes: ['09:15'],
      dailyGoal: 42,
      lastNotificationBySlot: { '2026-07-29:09:15': now },
      seededAt: now - 1_000,
      updatedAt: now,
    }
    const legacyCards = [
      makeCard('source-demo-card', demoBySource.id, now),
      makeCard('id-demo-card', demoById.id, now),
      makeCard('demo-prefixed-card', userDeck.id, now),
      makeCard('user-card', userDeck.id, now),
      makeCard('card-demo-safe', userDeck.id, now),
    ]
    const legacyLogs = [
      makeLog(
        'review-source-demo',
        legacyCards[0].id,
        demoBySource.id,
        now,
      ),
      makeLog(
        'review-id-demo',
        legacyCards[1].id,
        demoById.id,
        now,
      ),
      makeLog(
        'review-prefixed-card',
        legacyCards[2].id,
        userDeck.id,
        now,
      ),
      makeLog('review-user', legacyCards[3].id, userDeck.id, now),
      makeLog(
        'review-card-demo-safe',
        legacyCards[4].id,
        userDeck.id,
        now,
      ),
      makeLog('demo-prefixed-log', legacyCards[3].id, userDeck.id, now),
      makeLog('review-orphan-demo', 'demo-missing-card', userDeck.id, now),
    ]

    await legacyDatabase.transaction(
      'rw',
      decks,
      cards,
      studyLogs,
      settings,
      async () => {
        await decks.bulkAdd([demoBySource, demoById, userDeck])
        await cards.bulkAdd(legacyCards)
        await studyLogs.bulkAdd(legacyLogs)
        await settings.put(legacySettings)
      },
    )
    legacyDatabase.close()

    await initializeDatabase()

    expect(db.verno).toBe(4)
    expect((await db.decks.toArray()).map((deck) => deck.id)).toEqual([
      userDeck.id,
    ])
    expect(
      (await db.cards.toArray()).map((card) => card.id).sort(),
    ).toEqual(['card-demo-safe', 'user-card'])
    expect(
      (await db.studyLogs.toArray()).map((log) => log.id).sort(),
    ).toEqual(['review-card-demo-safe', 'review-user'])
    expect(await db.settings.get('app')).toEqual(legacySettings)
  })

  it('imports cards and atomically persists a review result', async () => {
    const imported = await importCardsToNewDeck(
      {
        name: 'Bộ test',
        sourceType: 'csv',
        sourceName: 'test.csv',
      },
      [
        { front: 'thoughtful', back: 'chu đáo', sourceRow: 2 },
        { front: 'improve', back: 'cải thiện', sourceRow: 3 },
      ],
    )
    const card = imported.cards[0]

    await persistReview({
      cardId: card.id,
      rating: 'remember',
      wasCorrect: true,
      boxAfter: 2,
      nextReviewAt: Date.now() + 24 * 60 * 60 * 1_000,
    })

    const saved = await db.cards.get(card.id)
    const stats = await getStudyStats({ deckId: imported.deck.id })
    expect(imported.importedCount).toBe(2)
    expect(saved).toMatchObject({
      box: 2,
      correctCount: 1,
      reviewCount: 1,
      streak: 1,
    })
    expect(stats).toMatchObject({
      reviewCount: 1,
      correctCount: 1,
      accuracy: 1,
    })
  })

  it('rejects an oversized import before changing local data or outbox', async () => {
    await importCardsToNewDeck(
      {
        name: 'Bộ đang có',
        sourceType: 'txt',
        sourceName: 'existing.txt',
      },
      [{ front: 'existing', back: 'đang có', sourceRow: 1 }],
    )
    const before = await Promise.all([
      db.decks.toArray(),
      db.cards.toArray(),
      db.studyLogs.toArray(),
      db.settings.toArray(),
      db.syncOutbox.toArray(),
    ])

    await expect(
      importCardsToNewDeck(
        {
          name: 'Bộ quá lớn',
          sourceType: 'docx',
          sourceName: 'oversized.docx',
        },
        [
          {
            front: 'oversized',
            back: 'quá lớn',
            notes: 'x'.repeat(910 * 1_024),
            sourceRow: 42,
          },
        ],
      ),
    ).rejects.toThrow(
      /sourceRow: 42.*chưa có dữ liệu nào được lưu/,
    )

    const after = await Promise.all([
      db.decks.toArray(),
      db.cards.toArray(),
      db.studyLogs.toArray(),
      db.settings.toArray(),
      db.syncOutbox.toArray(),
    ])
    expect(after).toEqual(before)
  })

  it('only counts due cards from reminder-enabled decks', async () => {
    const imported = await importCardsToNewDeck(
      {
        name: 'Bộ cần ôn',
        sourceType: 'txt',
        reminderEnabled: true,
      },
      [
        {
          front: 'review',
          back: 'ôn tập',
          nextReviewAt: Date.now() - 1,
        },
      ],
    )

    const before = await getDueReminderSummary()
    await setDeckReminderEnabled(imported.deck.id, false)
    const after = await getDueReminderSummary()

    expect(before.dueCount).toBe(1)
    expect(before.decks.map((deck) => deck.id)).toContain(imported.deck.id)
    expect(after.dueCount).toBe(0)
    expect(after.decks).toEqual([])
  })
})

function makeDeck(
  id: string,
  name: string,
  sourceType: Deck['sourceType'],
  now: number,
): Deck {
  return {
    id,
    name,
    sourceType,
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
