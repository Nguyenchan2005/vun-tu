import Dexie, { type Table, type Transaction } from 'dexie'

import {
  APP_SETTINGS_ID,
  type AppSettings,
  type Card,
  type Deck,
  type SyncMeta,
  type SyncOutboxEntry,
  type StudyLog,
} from '../models'

const DATABASE_NAME = 'tu-vung-moi-ngay'
const LEGACY_DATABASE_STORES = {
  decks: '&id, name, createdAt, updatedAt',
  cards:
    '&id, deckId, nextReviewAt, [deckId+nextReviewAt], box, createdAt, updatedAt',
  studyLogs:
    '&id, cardId, deckId, reviewedAt, [deckId+reviewedAt], [cardId+reviewedAt]',
  settings: '&id',
}
const DATABASE_STORES_V3 = {
  ...LEGACY_DATABASE_STORES,
  syncOutbox:
    '&id, revision, entityType, entityId, operation, status, queuedAt, nextAttemptAt, [entityType+entityId]',
  syncMeta: '&uid, updatedAt',
}
const DATABASE_STORES = {
  ...DATABASE_STORES_V3,
  syncOutbox:
    '&id, revision, entityType, entityId, operation, status, queuedAt, availableAt, nextAttemptAt, [entityType+entityId]',
}

export function createEntityId(prefix: string): string {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  return `${prefix}-${randomPart}`
}

export function createDefaultSettings(now = Date.now()): AppSettings {
  return {
    id: APP_SETTINGS_ID,
    preferredDirection: 'en-vi',
    remindersEnabled: true,
    reminderTimes: ['08:00', '20:30'],
    dailyGoal: 15,
    lastNotificationBySlot: {},
    updatedAt: now,
  }
}

export class VocabularyDatabase extends Dexie {
  decks!: Table<Deck, string>
  cards!: Table<Card, string>
  studyLogs!: Table<StudyLog, string>
  settings!: Table<AppSettings, string>
  syncOutbox!: Table<SyncOutboxEntry, string>
  syncMeta!: Table<SyncMeta, string>

  constructor() {
    super(DATABASE_NAME)

    this.version(1).stores(LEGACY_DATABASE_STORES)
    this.version(2)
      .stores(LEGACY_DATABASE_STORES)
      .upgrade((transaction) => removeLegacyDemoData(transaction))
    this.version(3).stores(DATABASE_STORES_V3)
    this.version(4)
      .stores(DATABASE_STORES)
      .upgrade((transaction) => backfillOutboxAvailability(transaction))

    this.on('populate', (transaction) => populateDatabase(transaction))
  }
}

export const db = new VocabularyDatabase()

export async function initializeDatabase(): Promise<VocabularyDatabase> {
  if (!db.isOpen()) {
    await db.open()
  }

  const settings = await db.settings.get(APP_SETTINGS_ID)
  if (!settings) {
    await db.settings.put(createDefaultSettings())
  }

  return db
}

async function populateDatabase(transaction: Transaction): Promise<void> {
  await transaction
    .table<AppSettings, string>('settings')
    .put(createDefaultSettings())
}

async function removeLegacyDemoData(
  transaction: Transaction,
): Promise<void> {
  const decks = transaction.table<Deck, string>('decks')
  const cards = transaction.table<Card, string>('cards')
  const studyLogs = transaction.table<StudyLog, string>('studyLogs')

  const demoDeckIds = new Set(
    (await decks.toArray())
      .filter(
        (deck) => deck.sourceType === 'demo' || isDemoId(deck.id),
      )
      .map((deck) => deck.id),
  )
  const demoCardIds = new Set(
    (await cards.toArray())
      .filter(
        (card) => demoDeckIds.has(card.deckId) || isDemoId(card.id),
      )
      .map((card) => card.id),
  )
  const demoLogIds = (await studyLogs.toArray())
    .filter(
      (log) =>
        isDemoId(log.id) ||
        isDemoId(log.cardId) ||
        isDemoId(log.deckId) ||
        demoDeckIds.has(log.deckId) ||
        demoCardIds.has(log.cardId),
    )
    .map((log) => log.id)

  await studyLogs.bulkDelete(demoLogIds)
  await cards.bulkDelete([...demoCardIds])
  await decks.bulkDelete([...demoDeckIds])
}

async function backfillOutboxAvailability(
  transaction: Transaction,
): Promise<void> {
  await transaction
    .table<SyncOutboxEntry, string>('syncOutbox')
    .toCollection()
    .modify((entry) => {
      entry.availableAt = entry.nextAttemptAt ?? entry.queuedAt
    })
}

function isDemoId(id: string): boolean {
  return id.startsWith('demo-')
}
