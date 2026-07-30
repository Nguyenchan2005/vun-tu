import { Timestamp } from 'firebase/firestore'
import { describe, expect, it } from 'vitest'

import {
  decodeRemoteData,
  encodeRemoteDocument,
  estimateFirestoreDocumentUtf8Bytes,
  FIRESTORE_MAX_BATCH_BYTES,
  FIRESTORE_MAX_DOCUMENT_BYTES,
  FirestoreDocumentTooLargeError,
  prepareFirestoreWriteBatches,
} from './firestore'
import type { PendingMutationSnapshot } from './types'

const NOW = 1_800_000_000_000

describe('Firestore sync documents', () => {
  it('encodes flattened upserts and removes undefined recursively', () => {
    const entry: PendingMutationSnapshot = {
      id: 'card:card-1',
      revision: 'revision-1',
      entityType: 'card',
      entityId: 'card-1',
      operation: 'upsert',
      queuedAt: NOW,
      payload: {
        id: 'card-1',
        deckId: 'deck-1',
        front: 'focus',
        back: 'tập trung',
        notes: undefined,
        extra: {
          level: 'B1',
          unused: undefined,
        } as unknown as Record<string, string>,
        box: 0,
        correctCount: 0,
        incorrectCount: 0,
        reviewCount: 0,
        streak: 0,
        nextReviewAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }

    const encoded = encodeRemoteDocument(entry)

    expect(encoded).toMatchObject({
      id: 'card-1',
      front: 'focus',
      extra: { level: 'B1' },
      _sync: {
        deleted: false,
        modifiedAt: NOW,
        revision: 'revision-1',
        schemaVersion: 1,
      },
    })
    expect(encoded).not.toHaveProperty('notes')
    expect(encoded.extra).not.toHaveProperty('unused')
  })

  it('encodes deletes as durable tombstones without stale payload', () => {
    const encoded = encodeRemoteDocument({
      id: 'deck:deck-1',
      revision: 'revision-delete',
      entityType: 'deck',
      entityId: 'deck-1',
      operation: 'delete',
      queuedAt: NOW,
    })

    expect(encoded).toMatchObject({
      id: 'deck-1',
      _sync: {
        deleted: true,
        revision: 'revision-delete',
      },
    })
    expect(encoded).not.toHaveProperty('name')
  })

  it('decodes server timestamps into per-entity cursors', () => {
    const decoded = decodeRemoteData('deck', 'deck-1', {
      id: 'wrong-id',
      name: 'Remote deck',
      sourceType: 'manual',
      preferredDirection: 'en-vi',
      reminderEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      _sync: {
        deleted: false,
        modifiedAt: NOW,
        revision: 'remote-revision',
        schemaVersion: 1,
        serverModifiedAt: Timestamp.fromMillis(NOW + 123),
      },
    })

    expect(decoded).toMatchObject({
      entityType: 'deck',
      entityId: 'deck-1',
      operation: 'upsert',
      modifiedAt: NOW,
      revision: 'remote-revision',
      remoteCursor: NOW + 123,
      payload: {
        id: 'deck-1',
        name: 'Remote deck',
      },
    })
    expect(decoded.payload).not.toHaveProperty('_sync')
  })

  it('measures encoded UTF-8 bytes rather than JavaScript string length', () => {
    const data = { text: 'ừ' }

    expect(estimateFirestoreDocumentUtf8Bytes(data)).toBe(
      new TextEncoder().encode(JSON.stringify(data)).byteLength,
    )
    expect(estimateFirestoreDocumentUtf8Bytes(data)).toBeGreaterThan(
      JSON.stringify(data).length,
    )
  })

  it('rejects a document above the conservative 900 KiB limit', () => {
    const oversized = pendingDeck(
      'oversized',
      'ừ'.repeat(Math.ceil(FIRESTORE_MAX_DOCUMENT_BYTES / 3)),
    )

    expect(() => prepareFirestoreWriteBatches([oversized])).toThrowError(
      FirestoreDocumentTooLargeError,
    )
    try {
      prepareFirestoreWriteBatches([oversized])
    } catch (error) {
      expect(error).toMatchObject({
        retryable: false,
        affectedMutationIds: [oversized.id],
        entityType: 'deck',
        entityId: 'oversized',
      })
      expect((error as Error).message).toContain('900 KiB')
      expect((error as Error).message).toContain('rút gọn')
    }
  })

  it('splits valid writes before the conservative 8 MiB commit limit', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      pendingDeck(
        `large-${index}`,
        'a'.repeat(850 * 1_024),
      ),
    )

    const batches = prepareFirestoreWriteBatches(entries)

    expect(batches.map((batch) => batch.length)).toEqual([9, 1])
    for (const batch of batches) {
      expect(
        batch.reduce(
          (total, write) => total + write.estimatedCommitBytes,
          0,
        ),
      ).toBeLessThanOrEqual(FIRESTORE_MAX_BATCH_BYTES)
    }
  })

  it('also caps a commit at 400 documents', () => {
    const entries = Array.from({ length: 401 }, (_, index) =>
      pendingDeck(`deck-${index}`, 'small'),
    )

    expect(
      prepareFirestoreWriteBatches(entries).map((batch) => batch.length),
    ).toEqual([400, 1])
  })
})

function pendingDeck(
  id: string,
  name: string,
): PendingMutationSnapshot {
  return {
    id: `deck:${id}`,
    revision: `revision-${id}`,
    entityType: 'deck',
    entityId: id,
    operation: 'upsert',
    queuedAt: NOW,
    payload: {
      id,
      name,
      sourceType: 'manual',
      preferredDirection: 'en-vi',
      reminderEnabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  }
}
