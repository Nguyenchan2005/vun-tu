import {
  type Deck,
  type DeckSummary,
  type NewDeckInput,
} from '../models'
import { createEntityId, db, initializeDatabase } from './database'
import {
  buildSyncDelete,
  buildSyncUpsert,
  putSyncOutboxEntries,
} from './outbox-helpers'

export type DeckUpdate = Partial<
  Omit<Deck, 'id' | 'createdAt' | 'updatedAt'>
>

export async function createDeck(
  input: NewDeckInput,
  now = Date.now(),
): Promise<Deck> {
  await initializeDatabase()
  const deck = buildDeckRecord(input, now)
  await db.transaction('rw', db.decks, db.syncOutbox, async () => {
    await db.decks.add(deck)
    await putSyncOutboxEntries(db.syncOutbox, [
      buildSyncUpsert('deck', deck, now),
    ])
  })
  return deck
}

export function buildDeckRecord(
  input: NewDeckInput,
  now = Date.now(),
  id = createEntityId('deck'),
): Deck {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Tên bộ thẻ không được để trống.')
  }

  return {
    id,
    name,
    description: cleanOptionalText(input.description),
    sourceName: cleanOptionalText(input.sourceName),
    sourceType: input.sourceType ?? 'manual',
    preferredDirection: input.preferredDirection ?? 'en-vi',
    reminderEnabled: input.reminderEnabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
}

export async function getDeck(id: string): Promise<Deck | undefined> {
  await initializeDatabase()
  return db.decks.get(id)
}

export async function listDecks(): Promise<Deck[]> {
  await initializeDatabase()
  const decks = await db.decks.toArray()
  return decks.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function listDeckSummaries(
  now = Date.now(),
): Promise<DeckSummary[]> {
  await initializeDatabase()
  const [decks, cards] = await Promise.all([
    db.decks.toArray(),
    db.cards.toArray(),
  ])
  const stats = new Map<
    string,
    { cardCount: number; dueCount: number; newCount: number }
  >()

  for (const card of cards) {
    const current = stats.get(card.deckId) ?? {
      cardCount: 0,
      dueCount: 0,
      newCount: 0,
    }
    current.cardCount += 1
    current.dueCount += card.nextReviewAt <= now ? 1 : 0
    current.newCount += card.reviewCount === 0 ? 1 : 0
    stats.set(card.deckId, current)
  }

  return decks
    .map((deck) => ({
      ...deck,
      ...(stats.get(deck.id) ?? {
        cardCount: 0,
        dueCount: 0,
        newCount: 0,
      }),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function updateDeck(
  id: string,
  patch: DeckUpdate,
  now = Date.now(),
): Promise<Deck> {
  await initializeDatabase()
  const existing = await db.decks.get(id)
  if (!existing) {
    throw new Error('Không tìm thấy bộ thẻ.')
  }

  const nextName = patch.name?.trim()
  if (patch.name !== undefined && !nextName) {
    throw new Error('Tên bộ thẻ không được để trống.')
  }

  const updated: Deck = {
    ...existing,
    ...patch,
    name: nextName ?? existing.name,
    description:
      patch.description === undefined
        ? existing.description
        : cleanOptionalText(patch.description),
    sourceName:
      patch.sourceName === undefined
        ? existing.sourceName
        : cleanOptionalText(patch.sourceName),
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now,
  }

  await db.transaction('rw', db.decks, db.syncOutbox, async () => {
    await db.decks.put(updated)
    await putSyncOutboxEntries(db.syncOutbox, [
      buildSyncUpsert('deck', updated, now),
    ])
  })
  return updated
}

export async function setDeckReminderEnabled(
  id: string,
  enabled: boolean,
): Promise<Deck> {
  return updateDeck(id, { reminderEnabled: enabled })
}

export async function deleteDeck(id: string): Promise<boolean> {
  await initializeDatabase()
  const existing = await db.decks.get(id)
  if (!existing) {
    return false
  }

  await db.transaction(
    'rw',
    db.decks,
    db.cards,
    db.studyLogs,
    db.syncOutbox,
    async () => {
      const [cards, logs] = await Promise.all([
        db.cards.where('deckId').equals(id).toArray(),
        db.studyLogs.where('deckId').equals(id).toArray(),
      ])
      await db.studyLogs.where('deckId').equals(id).delete()
      await db.cards.where('deckId').equals(id).delete()
      await db.decks.delete(id)
      const deletedAt = Date.now()
      await putSyncOutboxEntries(db.syncOutbox, [
        ...logs.map((log) =>
          buildSyncDelete('studyLog', log.id, deletedAt),
        ),
        ...cards.map((card) =>
          buildSyncDelete('card', card.id, deletedAt),
        ),
        buildSyncDelete('deck', id, deletedAt),
      ])
    },
  )

  return true
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned ? cleaned : undefined
}
