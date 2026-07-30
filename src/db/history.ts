import {
  type ReviewPersistenceInput,
  type StudyLog,
  type StudyStats,
} from '../models'
import { createEntityId, db, initializeDatabase } from './database'
import {
  buildSyncDelete,
  buildSyncUpsert,
  putSyncOutboxEntries,
} from './outbox-helpers'

export interface StudyHistoryQuery {
  deckId?: string
  cardId?: string
  from?: number
  to?: number
  limit?: number
}

/**
 * Persists the scheduling result and its immutable history row atomically.
 * The scheduling algorithm stays independent; it only needs to provide the
 * resulting box and next-review timestamp.
 */
export async function persistReview(
  input: ReviewPersistenceInput,
): Promise<{ log: StudyLog; cardUpdated: true }> {
  await initializeDatabase()
  const card = await db.cards.get(input.cardId)
  if (!card) {
    throw new Error('Không tìm thấy thẻ để lưu kết quả học.')
  }

  const deck = await db.decks.get(card.deckId)
  if (!deck) {
    throw new Error('Không tìm thấy bộ thẻ của thẻ.')
  }

  const reviewedAt = input.reviewedAt ?? Date.now()
  const log: StudyLog = {
    id: createEntityId('review'),
    cardId: card.id,
    deckId: card.deckId,
    sessionId: input.sessionId,
    rating: input.rating,
    wasCorrect: input.wasCorrect,
    boxBefore: card.box,
    boxAfter: input.boxAfter,
    reviewedAt,
    nextReviewAt: input.nextReviewAt,
  }
  const updatedCard = {
    ...card,
    box: input.boxAfter,
    correctCount: card.correctCount + (input.wasCorrect ? 1 : 0),
    incorrectCount: card.incorrectCount + (input.wasCorrect ? 0 : 1),
    reviewCount: card.reviewCount + 1,
    streak: input.wasCorrect ? card.streak + 1 : 0,
    lastReviewedAt: reviewedAt,
    nextReviewAt: input.nextReviewAt,
    updatedAt: reviewedAt,
  }
  const updatedDeck = { ...deck, updatedAt: reviewedAt }

  await db.transaction(
    'rw',
    db.cards,
    db.decks,
    db.studyLogs,
    db.syncOutbox,
    async () => {
      await db.cards.put(updatedCard)
      await db.studyLogs.add(log)
      await db.decks.put(updatedDeck)
      await putSyncOutboxEntries(db.syncOutbox, [
        buildSyncUpsert('card', updatedCard, reviewedAt),
        buildSyncUpsert('studyLog', log, reviewedAt),
        buildSyncUpsert('deck', updatedDeck, reviewedAt),
      ])
    },
  )

  return { log, cardUpdated: true }
}

export async function getStudyLog(
  id: string,
): Promise<StudyLog | undefined> {
  await initializeDatabase()
  return db.studyLogs.get(id)
}

export async function listStudyHistory(
  query: StudyHistoryQuery = {},
): Promise<StudyLog[]> {
  await initializeDatabase()
  let logs: StudyLog[]

  if (query.cardId) {
    logs = await db.studyLogs.where('cardId').equals(query.cardId).toArray()
  } else if (query.deckId) {
    logs = await db.studyLogs.where('deckId').equals(query.deckId).toArray()
  } else {
    logs = await db.studyLogs.toArray()
  }

  const filtered = logs
    .filter((log) => query.from === undefined || log.reviewedAt >= query.from)
    .filter((log) => query.to === undefined || log.reviewedAt <= query.to)
    .sort((left, right) => right.reviewedAt - left.reviewedAt)

  return query.limit === undefined ? filtered : filtered.slice(0, query.limit)
}

export async function getStudyStats(
  query: Omit<StudyHistoryQuery, 'limit'> = {},
): Promise<StudyStats> {
  const logs = await listStudyHistory(query)
  const correctCount = logs.reduce(
    (total, log) => total + (log.wasCorrect ? 1 : 0),
    0,
  )
  const reviewCount = logs.length

  return {
    reviewCount,
    correctCount,
    incorrectCount: reviewCount - correctCount,
    accuracy: reviewCount === 0 ? 0 : correctCount / reviewCount,
    lastReviewedAt: logs[0]?.reviewedAt,
  }
}

export async function deleteStudyLog(id: string): Promise<boolean> {
  await initializeDatabase()
  const existing = await db.studyLogs.get(id)
  if (!existing) {
    return false
  }

  const deletedAt = Date.now()
  await db.transaction(
    'rw',
    db.studyLogs,
    db.syncOutbox,
    async () => {
      await db.studyLogs.delete(id)
      await putSyncOutboxEntries(db.syncOutbox, [
        buildSyncDelete('studyLog', id, deletedAt),
      ])
    },
  )
  return true
}

export async function clearStudyHistory(deckId?: string): Promise<number> {
  await initializeDatabase()
  const logs = deckId
    ? await db.studyLogs.where('deckId').equals(deckId).toArray()
    : await db.studyLogs.toArray()
  if (logs.length === 0) {
    return 0
  }

  const deletedAt = Date.now()
  await db.transaction(
    'rw',
    db.studyLogs,
    db.syncOutbox,
    async () => {
      await db.studyLogs.bulkDelete(logs.map((log) => log.id))
      await putSyncOutboxEntries(
        db.syncOutbox,
        logs.map((log) =>
          buildSyncDelete('studyLog', log.id, deletedAt),
        ),
      )
    },
  )
  return logs.length
}

export async function resetDeckProgress(
  deckId: string,
  now = Date.now(),
): Promise<number> {
  await initializeDatabase()
  const [cards, deck] = await Promise.all([
    db.cards.where('deckId').equals(deckId).toArray(),
    db.decks.get(deckId),
  ])
  if (!deck) {
    throw new Error('Không tìm thấy bộ thẻ.')
  }
  const resetCards = cards.map((card) => ({
    ...card,
    box: 0,
    correctCount: 0,
    incorrectCount: 0,
    reviewCount: 0,
    streak: 0,
    lastReviewedAt: undefined,
    nextReviewAt: now,
    updatedAt: now,
  }))
  const updatedDeck = { ...deck, updatedAt: now }

  await db.transaction(
    'rw',
    db.cards,
    db.decks,
    db.studyLogs,
    db.syncOutbox,
    async () => {
      const logs = await db.studyLogs
        .where('deckId')
        .equals(deckId)
        .toArray()
      await db.cards.bulkPut(resetCards)
      await db.studyLogs.bulkDelete(logs.map((log) => log.id))
      await db.decks.put(updatedDeck)
      await putSyncOutboxEntries(db.syncOutbox, [
        ...resetCards.map((card) =>
          buildSyncUpsert('card', card, now),
        ),
        ...logs.map((log) =>
          buildSyncDelete('studyLog', log.id, now),
        ),
        buildSyncUpsert('deck', updatedDeck, now),
      ])
    },
  )

  return cards.length
}
