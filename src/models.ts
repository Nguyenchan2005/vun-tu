export type EntityId = string

export type StudyDirection = 'en-vi' | 'vi-en' | 'random'

export type ReviewRating =
  | 'forgot'
  | 'remember'
  | 'again'
  | 'hard'
  | 'good'
  | 'easy'

export type ImportSource =
  | 'demo'
  | 'xlsx'
  | 'csv'
  | 'tsv'
  | 'txt'
  | 'docx'
  | 'markdown'
  | 'json'
  | 'html'
  | 'rtf'
  | 'google-sheets'
  | 'manual'

export interface Deck {
  id: EntityId
  name: string
  description?: string
  sourceName?: string
  sourceType: ImportSource
  preferredDirection: StudyDirection
  reminderEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface Card {
  id: EntityId
  deckId: EntityId
  /** English side of the card. */
  front: string
  /** Vietnamese side of the card. */
  back: string
  partOfSpeech?: string
  example?: string
  notes?: string
  extra?: Record<string, string>
  sourceRow?: number
  box: number
  correctCount: number
  incorrectCount: number
  reviewCount: number
  streak: number
  lastReviewedAt?: number
  nextReviewAt: number
  createdAt: number
  updatedAt: number
}

export interface StudyLog {
  id: EntityId
  cardId: EntityId
  deckId: EntityId
  sessionId?: EntityId
  rating: ReviewRating
  wasCorrect: boolean
  boxBefore: number
  boxAfter: number
  reviewedAt: number
  nextReviewAt: number
}

export interface AppSettings {
  id: 'app'
  preferredDirection: StudyDirection
  remindersEnabled: boolean
  /** Local-time values in 24-hour HH:mm format. */
  reminderTimes: string[]
  dailyGoal: number
  /**
   * Keys are `${YYYY-MM-DD}:${HH:mm}`. Keeping this in IndexedDB prevents a
   * notification from being shown twice after a refresh.
   */
  lastNotificationBySlot: Record<string, number>
  seededAt?: number
  updatedAt: number
}

export type SyncEntityType = 'deck' | 'card' | 'studyLog' | 'settings'

export type SyncOperation = 'upsert' | 'delete'

export type SyncOutboxStatus = 'pending' | 'failed'

export type SyncEntityPayload = Deck | Card | StudyLog | AppSettings

/**
 * A durable, coalescing local mutation. `id` is deterministic per entity while
 * `revision` changes for every mutation so a sync acknowledgement cannot erase
 * a newer write that happened while the network request was in flight.
 */
export interface SyncOutboxEntry {
  id: string
  revision: string
  entityType: SyncEntityType
  entityId: EntityId
  operation: SyncOperation
  payload?: SyncEntityPayload
  queuedAt: number
  /** Indexed timestamp at which this mutation is eligible for retry. */
  availableAt: number
  updatedAt: number
  status: SyncOutboxStatus
  attemptCount: number
  lastAttemptAt?: number
  nextAttemptAt?: number
  lastError?: string
}

/** Per-account cursors and timestamps; local entities remain account-agnostic. */
export interface SyncMeta {
  uid: string
  /** Exactly one uid may own the device's single local entity namespace. */
  ownsLocalData?: boolean
  /** Legacy aggregate cursor kept for compatibility with early sync builds. */
  remoteCursor?: number
  remoteCursorByEntity?: Partial<Record<SyncEntityType, number>>
  lastPulledAt?: number
  lastPushedAt?: number
  lastSuccessfulSyncAt?: number
  updatedAt: number
}

export interface DeckSummary extends Deck {
  cardCount: number
  dueCount: number
  newCount: number
}

export interface StudyStats {
  reviewCount: number
  correctCount: number
  incorrectCount: number
  /** A 0..1 ratio. */
  accuracy: number
  lastReviewedAt?: number
}

export interface NewDeckInput {
  name: string
  description?: string
  sourceName?: string
  sourceType?: ImportSource
  preferredDirection?: StudyDirection
  reminderEnabled?: boolean
}

export interface NewCardInput {
  id?: EntityId
  front: string
  back: string
  partOfSpeech?: string
  example?: string
  notes?: string
  extra?: Record<string, string>
  sourceRow?: number
  nextReviewAt?: number
}

export interface ReviewPersistenceInput {
  cardId: EntityId
  sessionId?: EntityId
  rating: ReviewRating
  wasCorrect: boolean
  boxAfter: number
  nextReviewAt: number
  reviewedAt?: number
}

export const APP_SETTINGS_ID = 'app' as const
