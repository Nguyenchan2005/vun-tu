import { describe, expect, it } from 'vitest'

import type { Card, Deck } from '../models'
import {
  filterUnprotectedRemote,
  planReconciliation,
  syncEntityKey,
} from './merge'
import type {
  LocalEntitySnapshot,
  PendingMutationSnapshot,
  RemoteEntity,
} from './types'

const NOW = 1_800_000_000_000

describe('cloud reconciliation', () => {
  it('uses deterministic keys across entity collections', () => {
    expect(syncEntityKey('card', 'same-id')).toBe('card:same-id')
    expect(syncEntityKey('deck', 'same-id')).toBe('deck:same-id')
  })

  it('applies remote upserts and tombstones when no local mutation is pending', () => {
    const remote = [
      remoteUpsert('deck', 'remote-deck', makeDeck('remote-deck')),
      remoteDelete('card', 'deleted-card'),
    ]

    const plan = planReconciliation([], remote, [])

    expect(plan.applyRemote).toEqual(remote)
    expect(plan.protectedRemote).toEqual([])
  })

  it('keeps a pending local upsert over a newer remote value', () => {
    const remote = remoteUpsert(
      'deck',
      'deck-1',
      makeDeck('deck-1', 'Remote name'),
      NOW + 50_000,
    )
    const pending = pendingUpsert(
      'deck',
      'deck-1',
      makeDeck('deck-1', 'Local name'),
    )

    const plan = planReconciliation([], [remote], [pending])

    expect(plan.applyRemote).toEqual([])
    expect(plan.protectedRemote).toEqual([remote])
  })

  it('keeps a pending local delete over a remote document', () => {
    const remote = remoteUpsert('card', 'card-1', makeCard('card-1'))
    const pending: PendingMutationSnapshot = {
      id: 'card:card-1',
      revision: 'revision-delete',
      entityType: 'card',
      entityId: 'card-1',
      operation: 'delete',
      queuedAt: NOW,
    }

    expect(filterUnprotectedRemote([remote], [pending])).toEqual([])
  })

  it('uploads legacy local records missing from an empty remote account', () => {
    const local = [
      localEntity('deck', 'legacy-deck', makeDeck('legacy-deck')),
      localEntity('card', 'legacy-card', makeCard('legacy-card')),
    ]

    const plan = planReconciliation(local, [], [])

    expect(plan.uploadLocal).toEqual(local)
  })

  it('pulls remote records on a new device without uploading duplicates', () => {
    const remote = [
      remoteUpsert('deck', 'remote-deck', makeDeck('remote-deck')),
      remoteUpsert('card', 'remote-card', makeCard('remote-card')),
    ]

    const plan = planReconciliation([], remote, [])

    expect(plan.applyRemote).toEqual(remote)
    expect(plan.uploadLocal).toEqual([])
  })

  it('does not bootstrap-upload an entity already represented by a tombstone', () => {
    const local = [
      localEntity('card', 'deleted-card', makeCard('deleted-card')),
    ]
    const tombstone = remoteDelete('card', 'deleted-card')

    const plan = planReconciliation(local, [tombstone], [])

    expect(plan.applyRemote).toEqual([tombstone])
    expect(plan.uploadLocal).toEqual([])
  })

  it('does not duplicate bootstrap work already present in the outbox', () => {
    const localDeck = makeDeck('deck-1')
    const local = [localEntity('deck', 'deck-1', localDeck)]
    const pending = pendingUpsert('deck', 'deck-1', localDeck)

    expect(planReconciliation(local, [], [pending]).uploadLocal).toEqual([])
  })
})

function localEntity<Type extends 'deck' | 'card'>(
  entityType: Type,
  entityId: string,
  payload: Type extends 'deck' ? Deck : Card,
): LocalEntitySnapshot {
  return { entityType, entityId, payload } as LocalEntitySnapshot
}

function remoteUpsert<Type extends 'deck' | 'card'>(
  entityType: Type,
  entityId: string,
  payload: Type extends 'deck' ? Deck : Card,
  modifiedAt = NOW,
): RemoteEntity {
  return {
    entityType,
    entityId,
    operation: 'upsert',
    payload,
    modifiedAt,
  } as RemoteEntity
}

function remoteDelete(
  entityType: 'deck' | 'card',
  entityId: string,
): RemoteEntity {
  return {
    entityType,
    entityId,
    operation: 'delete',
    modifiedAt: NOW,
  }
}

function pendingUpsert<Type extends 'deck' | 'card'>(
  entityType: Type,
  entityId: string,
  payload: Type extends 'deck' ? Deck : Card,
): PendingMutationSnapshot {
  return {
    id: `${entityType}:${entityId}`,
    revision: `revision-${entityId}`,
    entityType,
    entityId,
    operation: 'upsert',
    payload,
    queuedAt: NOW,
  } as PendingMutationSnapshot
}

function makeDeck(id: string, name = 'Deck'): Deck {
  return {
    id,
    name,
    sourceType: 'manual',
    preferredDirection: 'en-vi',
    reminderEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }
}
function makeCard(id: string): Card {
  return {
    id,
    deckId: 'legacy-deck',
    front: 'word',
    back: 'nghĩa',
    box: 0,
    correctCount: 0,
    incorrectCount: 0,
    reviewCount: 0,
    streak: 0,
    nextReviewAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }
}
