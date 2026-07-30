import {
  type Card,
  type Deck,
  type NewCardInput,
  type NewDeckInput,
} from '../models'
import {
  FirestoreDocumentTooLargeError,
  prepareFirestoreWriteBatches,
} from '../cloud/firestore'
import { buildCardRecord } from './cards'
import { db, initializeDatabase } from './database'
import { buildDeckRecord } from './decks'
import {
  buildSyncDelete,
  buildSyncUpsert,
  putSyncOutboxEntries,
} from './outbox-helpers'

export type ImportMode = 'append' | 'replace'

export type ImportTarget =
  | { kind: 'new'; deck: NewDeckInput }
  | { kind: 'existing'; deckId: string }

export interface ImportCardsOptions {
  target: ImportTarget
  cards: NewCardInput[]
  mode?: ImportMode
  skipDuplicates?: boolean
  importedAt?: number
}

export interface ImportCardsResult {
  deck: Deck
  cards: Card[]
  importedCount: number
  skippedCount: number
}

/**
 * Saves a parsed import in one IndexedDB transaction. Imports can create a new
 * deck or append to/replace an existing deck.
 */
export async function importCards(
  options: ImportCardsOptions,
): Promise<ImportCardsResult> {
  await initializeDatabase()
  const importedAt = options.importedAt ?? Date.now()
  const mode = options.mode ?? 'append'
  const deck =
    options.target.kind === 'new'
      ? buildDeckRecord(options.target.deck, importedAt)
      : await db.decks.get(options.target.deckId)

  if (!deck) {
    throw new Error('Không tìm thấy bộ thẻ để nhập dữ liệu.')
  }
  if (options.cards.length === 0) {
    throw new Error('Không có dòng từ vựng hợp lệ để lưu.')
  }

  const existingCards =
    options.target.kind === 'existing'
      ? await db.cards.where('deckId').equals(deck.id).toArray()
      : []
  const knownPairs = new Set(
    (mode === 'append' ? existingCards : []).map((card) =>
      makePairKey(card.front, card.back),
    ),
  )
  const inputs: NewCardInput[] = []
  let skippedCount = 0

  for (const input of options.cards) {
    const pairKey = makePairKey(input.front, input.back)
    if (options.skipDuplicates && knownPairs.has(pairKey)) {
      skippedCount += 1
      continue
    }
    knownPairs.add(pairKey)
    inputs.push(input)
  }

  const cards = inputs.map((input) =>
    buildCardRecord(deck.id, input, importedAt),
  )
  const updatedDeck = { ...deck, updatedAt: importedAt }
  const syncUpserts = [
    ...cards.map((card) =>
      buildSyncUpsert('card', card, importedAt),
    ),
    buildSyncUpsert('deck', updatedDeck, importedAt),
  ]
  validateImportSyncWrites(syncUpserts, cards)

  await db.transaction(
    'rw',
    db.decks,
    db.cards,
    db.studyLogs,
    db.syncOutbox,
    async () => {
      const replacedLogs =
        options.target.kind === 'existing' && mode === 'replace'
          ? await db.studyLogs
              .where('deckId')
              .equals(deck.id)
              .toArray()
          : []

      if (options.target.kind === 'new') {
        await db.decks.add(deck)
      } else if (mode === 'replace') {
        await db.studyLogs.where('deckId').equals(deck.id).delete()
        await db.cards.where('deckId').equals(deck.id).delete()
      }

      if (cards.length > 0) {
        await db.cards.bulkAdd(cards)
      }
      await db.decks.put(updatedDeck)
      await putSyncOutboxEntries(db.syncOutbox, [
        ...replacedLogs.map((log) =>
          buildSyncDelete('studyLog', log.id, importedAt),
        ),
        ...(mode === 'replace'
          ? existingCards.map((card) =>
              buildSyncDelete('card', card.id, importedAt),
            )
          : []),
        ...syncUpserts,
      ])
    },
  )

  return {
    deck: updatedDeck,
    cards,
    importedCount: cards.length,
    skippedCount,
  }
}

export async function importCardsToNewDeck(
  deck: NewDeckInput,
  cards: NewCardInput[],
): Promise<ImportCardsResult> {
  return importCards({
    target: { kind: 'new', deck },
    cards,
  })
}

export async function appendCardsToDeck(
  deckId: string,
  cards: NewCardInput[],
  skipDuplicates = false,
): Promise<ImportCardsResult> {
  return importCards({
    target: { kind: 'existing', deckId },
    cards,
    mode: 'append',
    skipDuplicates,
  })
}

function makePairKey(front: string, back: string): string {
  return `${front.trim().toLocaleLowerCase('en')}\u0000${back
    .trim()
    .toLocaleLowerCase('vi')}`
}

function validateImportSyncWrites(
  syncUpserts: ReturnType<typeof buildSyncUpsert>[],
  cards: readonly Card[],
): void {
  try {
    prepareFirestoreWriteBatches(syncUpserts)
  } catch (error) {
    if (!(error instanceof FirestoreDocumentTooLargeError)) {
      throw error
    }

    const card = cards.find(
      (candidate) => candidate.id === error.entityId,
    )
    if (!card) {
      throw new Error(
        'Tên hoặc mô tả bộ từ quá lớn để đồng bộ. Hãy rút gọn nội dung rồi nhập lại; chưa có dữ liệu nào được lưu.',
        { cause: error },
      )
    }

    const sourceRow = card.sourceRow ?? 'không xác định'
    throw new Error(
      `Thẻ tại sourceRow: ${sourceRow} vượt giới hạn an toàn 900 KiB để đồng bộ. Hãy rút gọn nghĩa, ví dụ hoặc ghi chú ở dòng này rồi nhập lại; chưa có dữ liệu nào được lưu.`,
      { cause: error },
    )
  }
}
