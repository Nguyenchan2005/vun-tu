import Dexie from 'dexie'

import { type Card, type NewCardInput } from '../models'
import { createEntityId, db, initializeDatabase } from './database'
import {
  buildSyncDelete,
  buildSyncUpsert,
  putSyncOutboxEntries,
} from './outbox-helpers'

export type CardUpdate = Partial<
  Omit<Card, 'id' | 'deckId' | 'createdAt' | 'updatedAt'>
>

export async function createCard(
  deckId: string,
  input: NewCardInput,
  now = Date.now(),
): Promise<Card> {
  const [card] = await createCards(deckId, [input], now)
  return card
}

export async function createCards(
  deckId: string,
  inputs: NewCardInput[],
  now = Date.now(),
): Promise<Card[]> {
  await initializeDatabase()
  if (inputs.length === 0) {
    return []
  }

  const deck = await db.decks.get(deckId)
  if (!deck) {
    throw new Error('Không tìm thấy bộ thẻ để thêm từ.')
  }

  const cards = inputs.map((input) => buildCardRecord(deckId, input, now))
  const updatedDeck = { ...deck, updatedAt: now }
  await db.transaction(
    'rw',
    db.cards,
    db.decks,
    db.syncOutbox,
    async () => {
      await db.cards.bulkAdd(cards)
      await db.decks.put(updatedDeck)
      await putSyncOutboxEntries(db.syncOutbox, [
        ...cards.map((card) => buildSyncUpsert('card', card, now)),
        buildSyncUpsert('deck', updatedDeck, now),
      ])
    },
  )

  return cards
}

export async function getCard(id: string): Promise<Card | undefined> {
  await initializeDatabase()
  return db.cards.get(id)
}

export async function listCards(deckId?: string): Promise<Card[]> {
  await initializeDatabase()
  const cards = deckId
    ? await db.cards.where('deckId').equals(deckId).toArray()
    : await db.cards.toArray()

  return cards.sort((left, right) => left.createdAt - right.createdAt)
}

export async function listDueCards(
  now = Date.now(),
  deckId?: string,
): Promise<Card[]> {
  await initializeDatabase()
  const cards = deckId
    ? await db.cards
        .where('[deckId+nextReviewAt]')
        .between([deckId, Dexie.minKey], [deckId, now], true, true)
        .toArray()
    : await db.cards.where('nextReviewAt').belowOrEqual(now).toArray()

  return cards.sort((left, right) => left.nextReviewAt - right.nextReviewAt)
}

export async function updateCard(
  id: string,
  patch: CardUpdate,
  now = Date.now(),
): Promise<Card> {
  await initializeDatabase()
  const existing = await db.cards.get(id)
  if (!existing) {
    throw new Error('Không tìm thấy thẻ.')
  }

  const deck = await db.decks.get(existing.deckId)
  if (!deck) {
    throw new Error('Không tìm thấy bộ thẻ của thẻ.')
  }

  const front = patch.front?.trim()
  const back = patch.back?.trim()
  if (patch.front !== undefined && !front) {
    throw new Error('Mặt tiếng Anh không được để trống.')
  }
  if (patch.back !== undefined && !back) {
    throw new Error('Mặt tiếng Việt không được để trống.')
  }

  const updated: Card = {
    ...existing,
    ...patch,
    front: front ?? existing.front,
    back: back ?? existing.back,
    partOfSpeech:
      patch.partOfSpeech === undefined
        ? existing.partOfSpeech
        : cleanOptionalText(patch.partOfSpeech),
    example:
      patch.example === undefined
        ? existing.example
        : cleanOptionalText(patch.example),
    notes:
      patch.notes === undefined
        ? existing.notes
        : cleanOptionalText(patch.notes),
    id: existing.id,
    deckId: existing.deckId,
    createdAt: existing.createdAt,
    updatedAt: now,
  }
  const updatedDeck = { ...deck, updatedAt: now }

  await db.transaction(
    'rw',
    db.cards,
    db.decks,
    db.syncOutbox,
    async () => {
      await db.cards.put(updated)
      await db.decks.put(updatedDeck)
      await putSyncOutboxEntries(db.syncOutbox, [
        buildSyncUpsert('card', updated, now),
        buildSyncUpsert('deck', updatedDeck, now),
      ])
    },
  )

  return updated
}

export async function deleteCard(id: string): Promise<boolean> {
  const deleted = await deleteCards([id])
  return deleted > 0
}

export async function deleteCards(ids: string[]): Promise<number> {
  await initializeDatabase()
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    return 0
  }

  const cards = await db.cards.bulkGet(uniqueIds)
  const existingCards = cards.filter(
    (card): card is Card => card !== undefined,
  )
  if (existingCards.length === 0) {
    return 0
  }

  const deckIds = [...new Set(existingCards.map((card) => card.deckId))]
  const existingIds = existingCards.map((card) => card.id)
  const now = Date.now()

  await db.transaction(
    'rw',
    db.cards,
    db.decks,
    db.studyLogs,
    db.syncOutbox,
    async () => {
      const [logs, decks] = await Promise.all([
        db.studyLogs.where('cardId').anyOf(existingIds).toArray(),
        db.decks.bulkGet(deckIds),
      ])
      const updatedDecks = decks
        .filter((deck) => deck !== undefined)
        .map((deck) => ({ ...deck, updatedAt: now }))

      await db.studyLogs.where('cardId').anyOf(existingIds).delete()
      await db.cards.bulkDelete(existingIds)
      await db.decks.bulkPut(updatedDecks)
      await putSyncOutboxEntries(db.syncOutbox, [
        ...logs.map((log) =>
          buildSyncDelete('studyLog', log.id, now),
        ),
        ...existingIds.map((id) => buildSyncDelete('card', id, now)),
        ...updatedDecks.map((deck) =>
          buildSyncUpsert('deck', deck, now),
        ),
      ])
    },
  )

  return existingCards.length
}

export function buildCardRecord(
  deckId: string,
  input: NewCardInput,
  now: number,
): Card {
  const front = input.front.trim()
  const back = input.back.trim()
  if (!front || !back) {
    throw new Error('Mỗi thẻ cần có cả mặt tiếng Anh và mặt tiếng Việt.')
  }

  return {
    id: input.id ?? createEntityId('card'),
    deckId,
    front,
    back,
    partOfSpeech: cleanOptionalText(input.partOfSpeech),
    example: cleanOptionalText(input.example),
    notes: cleanOptionalText(input.notes),
    extra: input.extra,
    sourceRow: input.sourceRow,
    box: 0,
    correctCount: 0,
    incorrectCount: 0,
    reviewCount: 0,
    streak: 0,
    nextReviewAt: input.nextReviewAt ?? now,
    createdAt: now,
    updatedAt: now,
  }
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned ? cleaned : undefined
}
