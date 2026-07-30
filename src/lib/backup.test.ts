import { describe, expect, it } from 'vitest'

import type { Card, Deck } from '../models'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupValidationError,
  parseBackupText,
  selectNewerEntities,
  serializeBackup,
  type VunTuBackup,
} from './backup'

const deck: Deck = {
  id: 'deck-1',
  name: 'Travel',
  sourceType: 'txt',
  preferredDirection: 'en-vi',
  reminderEnabled: true,
  createdAt: 10,
  updatedAt: 20,
}

const card: Card = {
  id: 'card-1',
  deckId: deck.id,
  front: 'journey',
  back: 'hành trình',
  box: 0,
  correctCount: 0,
  incorrectCount: 0,
  reviewCount: 0,
  streak: 0,
  nextReviewAt: 10,
  createdAt: 10,
  updatedAt: 20,
}

const validBackup: VunTuBackup = {
  format: BACKUP_FORMAT,
  version: BACKUP_VERSION,
  exportedAt: '2026-07-30T00:00:00.000Z',
  data: {
    decks: [deck],
    cards: [card],
    studyLogs: [],
    settings: {
      id: 'app',
      preferredDirection: 'en-vi',
      remindersEnabled: true,
      reminderTimes: ['08:00'],
      dailyGoal: 15,
      lastNotificationBySlot: {},
      updatedAt: 20,
    },
  },
}

describe('backup validation', () => {
  it('round-trips a valid backup', () => {
    expect(parseBackupText(serializeBackup(validBackup))).toEqual(
      validBackup,
    )
  })

  it('rejects arbitrary JSON', () => {
    expect(() => parseBackupText('{"hello":"world"}')).toThrow(
      BackupValidationError,
    )
  })

  it('rejects cards that reference a missing deck', () => {
    const invalid = structuredClone(validBackup)
    invalid.data.decks = []
    expect(() => parseBackupText(JSON.stringify(invalid))).toThrow(
      'thẻ không thuộc bộ từ',
    )
  })
})

describe('backup merge selection', () => {
  it('keeps newer local work and adds missing entities', () => {
    const olderIncoming = { ...deck, updatedAt: 19 }
    const missingIncoming = {
      ...deck,
      id: 'deck-2',
      updatedAt: 5,
    }

    expect(
      selectNewerEntities(
        [deck],
        [olderIncoming, missingIncoming],
      ),
    ).toEqual([missingIncoming])
  })

  it('selects a newer incoming copy', () => {
    const newerIncoming = { ...deck, updatedAt: 21 }
    expect(selectNewerEntities([deck], [newerIncoming])).toEqual([
      newerIncoming,
    ])
  })
})
