export { db, initializeDatabase } from './database'
export type {
  StudyStats,
  SyncEntityPayload,
  SyncEntityType,
  SyncMeta,
  SyncOperation,
  SyncOutboxEntry,
  SyncOutboxStatus,
} from '../models'

export {
  createDeck,
  deleteDeck,
  getDeck,
  listDecks,
  listDeckSummaries,
  setDeckReminderEnabled,
  updateDeck,
  type DeckUpdate,
} from './decks'

export {
  createCard,
  createCards,
  deleteCard,
  deleteCards,
  getCard,
  listCards,
  listDueCards,
  updateCard,
  type CardUpdate,
} from './cards'

export {
  appendCardsToDeck,
  importCards,
  importCardsToNewDeck,
  type ImportCardsOptions,
  type ImportCardsResult,
  type ImportMode,
  type ImportTarget,
} from './imports'

export {
  clearStudyHistory,
  deleteStudyLog,
  getStudyLog,
  getStudyStats,
  listStudyHistory,
  persistReview,
  resetDeckProgress,
  type StudyHistoryQuery,
} from './history'

export {
  getAppSettings,
  markNotificationSlotTriggered,
  normalizeReminderTimes,
  resetAppSettings,
  setPreferredDirection,
  setReminderTimes,
  setRemindersEnabled,
  updateAppSettings,
  type AppSettingsUpdate,
} from './settings'

export {
  claimLocalSyncOwnership,
  clearAllSyncMeta,
  clearSyncOutbox,
  countSyncOutbox,
  deleteSyncMeta,
  deleteSyncOutboxEntry,
  deleteSyncOutboxEntries,
  getLocalSyncOwnerUid,
  getSyncMeta,
  getSyncOutboxEntry,
  getSyncOutboxEntryById,
  listSyncOutbox,
  markSyncOutboxAttempt,
  markSyncOutboxAttempts,
  queueRestoredEntities,
  queueRestoredEntitiesInTransaction,
  releaseLocalSyncOwnership,
  subscribeToSyncOutbox,
  updateSyncMeta,
  type ListSyncOutboxOptions,
  type LocalSyncOwnershipClaim,
  type RestoredSyncEntities,
  type SyncMetaUpdate,
  type SyncOutboxAttemptResult,
  type SyncOutboxAttempt,
  type SyncOutboxAcknowledgement,
  type SyncOutboxListener,
} from '../sync/outbox'
