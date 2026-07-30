import { db, initializeDatabase } from '../db/database'
import type {
  AppSettings,
  Card,
  Deck,
  StudyLog,
} from '../models'
import { queueRestoredEntitiesInTransaction } from '../sync/outbox'

export const BACKUP_FORMAT = 'vun-tu-backup' as const
export const BACKUP_VERSION = 1 as const

export interface VunTuBackup {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: string
  data: {
    decks: Deck[]
    cards: Card[]
    studyLogs: StudyLog[]
    settings: AppSettings
  }
}

export interface BackupRestoreResult {
  decks: number
  cards: number
  studyLogs: number
  settings: number
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupValidationError'
  }
}

export async function createBackup(): Promise<VunTuBackup> {
  await initializeDatabase()
  const data = await db.transaction(
    'r',
    db.decks,
    db.cards,
    db.studyLogs,
    db.settings,
    async () => {
      const [decks, cards, studyLogs, settings] = await Promise.all([
        db.decks.toArray(),
        db.cards.toArray(),
        db.studyLogs.toArray(),
        db.settings.get('app'),
      ])
      if (!settings) {
        throw new Error('Không thể đọc cài đặt để tạo bản sao lưu.')
      }
      return { decks, cards, studyLogs, settings }
    },
  )

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
}

export function serializeBackup(backup: VunTuBackup): string {
  return JSON.stringify(backup, null, 2)
}

export function parseBackupText(text: string): VunTuBackup {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupValidationError(
      'File không phải JSON hợp lệ.',
    )
  }

  if (!isRecord(parsed)) {
    throw new BackupValidationError('Cấu trúc file sao lưu không hợp lệ.')
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new BackupValidationError(
      'Đây không phải file sao lưu của Vun Từ.',
    )
  }
  if (parsed.version !== BACKUP_VERSION) {
    throw new BackupValidationError(
      `Phiên bản sao lưu ${String(parsed.version)} chưa được hỗ trợ.`,
    )
  }
  if (
    typeof parsed.exportedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.exportedAt))
  ) {
    throw new BackupValidationError('Thời điểm sao lưu không hợp lệ.')
  }
  if (!isRecord(parsed.data)) {
    throw new BackupValidationError('File sao lưu đang thiếu phần dữ liệu.')
  }

  const { decks, cards, studyLogs, settings } = parsed.data
  if (!Array.isArray(decks) || !decks.every(isDeck)) {
    throw new BackupValidationError('Danh sách bộ từ không hợp lệ.')
  }
  if (!Array.isArray(cards) || !cards.every(isCard)) {
    throw new BackupValidationError('Danh sách thẻ từ không hợp lệ.')
  }
  if (!Array.isArray(studyLogs) || !studyLogs.every(isStudyLog)) {
    throw new BackupValidationError('Lịch sử học không hợp lệ.')
  }
  if (!isAppSettings(settings)) {
    throw new BackupValidationError('Cài đặt trong bản sao lưu không hợp lệ.')
  }
  if (
    hasDuplicateIds(decks) ||
    hasDuplicateIds(cards) ||
    hasDuplicateIds(studyLogs)
  ) {
    throw new BackupValidationError(
      'File sao lưu có mã dữ liệu bị trùng.',
    )
  }

  const deckIds = new Set(decks.map((deck) => deck.id))
  const cardIds = new Set(cards.map((card) => card.id))
  if (cards.some((card) => !deckIds.has(card.deckId))) {
    throw new BackupValidationError(
      'File sao lưu có thẻ không thuộc bộ từ nào.',
    )
  }
  if (
    studyLogs.some(
      (log) => !deckIds.has(log.deckId) || !cardIds.has(log.cardId),
    )
  ) {
    throw new BackupValidationError(
      'File sao lưu có lịch sử học không khớp với thẻ từ.',
    )
  }

  return parsed as unknown as VunTuBackup
}

/**
 * Merges a backup without replacing newer local work. Entity IDs are stable,
 * so restoring the same file twice is harmless.
 */
export async function restoreBackup(
  backup: VunTuBackup,
): Promise<BackupRestoreResult> {
  await initializeDatabase()
  let result: BackupRestoreResult = {
    decks: 0,
    cards: 0,
    studyLogs: 0,
    settings: 0,
  }

  await db.transaction(
    'rw',
    db.decks,
    db.cards,
    db.studyLogs,
    db.settings,
    db.syncOutbox,
    async () => {
      const [localDecks, localCards, localLogs, localSettings] =
        await Promise.all([
          db.decks.toArray(),
          db.cards.toArray(),
          db.studyLogs.toArray(),
          db.settings.get('app'),
        ])
      if (!localSettings) {
        throw new Error('Không thể đọc cài đặt hiện tại.')
      }

      const decks = selectNewerEntities(
        localDecks,
        backup.data.decks,
      )
      const cards = selectNewerEntities(
        localCards,
        backup.data.cards,
      )
      const localLogIds = new Set(localLogs.map((log) => log.id))
      const studyLogs = backup.data.studyLogs.filter(
        (log) => !localLogIds.has(log.id),
      )
      const settings =
        backup.data.settings.updatedAt > localSettings.updatedAt
          ? backup.data.settings
          : undefined

      if (decks.length > 0) await db.decks.bulkPut(decks)
      if (cards.length > 0) await db.cards.bulkPut(cards)
      if (studyLogs.length > 0) await db.studyLogs.bulkPut(studyLogs)
      if (settings) await db.settings.put(settings)
      await queueRestoredEntitiesInTransaction(db.syncOutbox, {
        decks,
        cards,
        studyLogs,
        settings,
      })
      result = {
        decks: decks.length,
        cards: cards.length,
        studyLogs: studyLogs.length,
        settings: settings ? 1 : 0,
      }
    },
  )

  return result
}

export async function downloadBackup(): Promise<string> {
  const file = await createBackupFile()
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return file.name
}

export async function shareBackup(): Promise<'shared' | 'downloaded'> {
  const file = await createBackupFile()
  const shareData: ShareData = {
    files: [file],
    title: 'Bản sao lưu Vun Từ',
    text: 'Lưu file này vào iCloud Drive để có thêm một bản dự phòng.',
  }

  if (
    typeof navigator.share === 'function' &&
    (typeof navigator.canShare !== 'function' ||
      navigator.canShare(shareData))
  ) {
    await navigator.share(shareData)
    return 'shared'
  }

  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return 'downloaded'
}

export function selectNewerEntities<T extends { id: string; updatedAt: number }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const localById = new Map(local.map((entity) => [entity.id, entity]))
  return incoming.filter((entity) => {
    const current = localById.get(entity.id)
    return !current || entity.updatedAt > current.updatedAt
  })
}

async function createBackupFile(): Promise<File> {
  const backup = await createBackup()
  const date = backup.exportedAt.slice(0, 10)
  return new File(
    [serializeBackup(backup)],
    `vun-tu-backup-${date}.json`,
    { type: 'application/json' },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasValidEntityBase(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.id) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt)
  )
}

function isDeck(value: unknown): value is Deck {
  if (!isRecord(value) || !hasValidEntityBase(value)) return false
  return (
    isNonEmptyString(value.name) &&
    isImportSource(value.sourceType) &&
    isStudyDirection(value.preferredDirection) &&
    typeof value.reminderEnabled === 'boolean'
  )
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value) || !hasValidEntityBase(value)) return false
  return (
    isNonEmptyString(value.deckId) &&
    isNonEmptyString(value.front) &&
    isNonEmptyString(value.back) &&
    isFiniteNumber(value.box) &&
    isFiniteNumber(value.correctCount) &&
    isFiniteNumber(value.incorrectCount) &&
    isFiniteNumber(value.reviewCount) &&
    isFiniteNumber(value.streak) &&
    isFiniteNumber(value.nextReviewAt)
  )
}

function isStudyLog(value: unknown): value is StudyLog {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.cardId) &&
    isNonEmptyString(value.deckId) &&
    isReviewRating(value.rating) &&
    typeof value.wasCorrect === 'boolean' &&
    isFiniteNumber(value.boxBefore) &&
    isFiniteNumber(value.boxAfter) &&
    isFiniteNumber(value.reviewedAt) &&
    isFiniteNumber(value.nextReviewAt)
  )
}

function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) return false
  return (
    value.id === 'app' &&
    isStudyDirection(value.preferredDirection) &&
    typeof value.remindersEnabled === 'boolean' &&
    Array.isArray(value.reminderTimes) &&
    value.reminderTimes.every(
      (time) =>
        typeof time === 'string' &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) &&
    isFiniteNumber(value.dailyGoal) &&
    isRecord(value.lastNotificationBySlot) &&
    Object.values(value.lastNotificationBySlot).every(isFiniteNumber) &&
    isFiniteNumber(value.updatedAt)
  )
}

function isStudyDirection(value: unknown): boolean {
  return value === 'en-vi' || value === 'vi-en' || value === 'random'
}

function isImportSource(value: unknown): boolean {
  return (
    value === 'demo' ||
    value === 'xlsx' ||
    value === 'csv' ||
    value === 'tsv' ||
    value === 'txt' ||
    value === 'docx' ||
    value === 'markdown' ||
    value === 'json' ||
    value === 'html' ||
    value === 'rtf' ||
    value === 'google-sheets' ||
    value === 'manual'
  )
}

function isReviewRating(value: unknown): boolean {
  return (
    value === 'forgot' ||
    value === 'remember' ||
    value === 'again' ||
    value === 'hard' ||
    value === 'good' ||
    value === 'easy'
  )
}

function hasDuplicateIds(
  entities: readonly { id: string }[],
): boolean {
  return new Set(entities.map((entity) => entity.id)).size !== entities.length
}
