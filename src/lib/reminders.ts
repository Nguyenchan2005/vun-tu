import {
  db,
  getAppSettings,
  initializeDatabase,
  markNotificationSlotTriggered,
  setRemindersEnabled,
} from '../db'

export type NotificationPermissionState =
  | NotificationPermission
  | 'unsupported'

export interface DueReminderDeck {
  id: string
  name: string
  dueCount: number
}

export interface DueReminderSummary {
  remindersEnabled: boolean
  checkedAt: number
  dueCount: number
  decks: DueReminderDeck[]
}

export type ReminderBannerReason =
  | 'disabled'
  | 'nothing-due'
  | 'notifications-available'
  | 'unsupported'
  | 'permission-default'
  | 'permission-denied'

export interface ReminderBannerState extends DueReminderSummary {
  visible: boolean
  reason: ReminderBannerReason
  permission: NotificationPermissionState
  message: string
}

export type ReminderCheckStatus =
  | 'disabled'
  | 'not-scheduled-now'
  | 'already-triggered'
  | 'permission-required'
  | 'nothing-due'
  | 'notified'
  | 'notification-failed'

export interface ReminderCheckResult {
  status: ReminderCheckStatus
  checkedAt: number
  slotKeys: string[]
  summary?: DueReminderSummary
}

export interface ReminderSchedulerOptions {
  pollIntervalMs?: number
  catchUpWindowMinutes?: number
  onCheck?: (result: ReminderCheckResult) => void
  onError?: (error: unknown) => void
}

export interface ReminderScheduler {
  checkNow: (now?: Date) => Promise<ReminderCheckResult>
  stop: () => void
}

export function supportsWebNotifications(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.Notification !== 'undefined'
  )
}

export function getNotificationPermission(): NotificationPermissionState {
  return supportsWebNotifications()
    ? window.Notification.permission
    : 'unsupported'
}

/**
 * Call this directly from a click/tap handler. Browsers may reject permission
 * prompts that are not initiated by a user gesture.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!supportsWebNotifications()) {
    return 'unsupported'
  }

  if (window.Notification.permission !== 'default') {
    return window.Notification.permission
  }

  try {
    return await window.Notification.requestPermission()
  } catch {
    return window.Notification.permission
  }
}

export async function enableStudyReminders(): Promise<NotificationPermissionState> {
  await setRemindersEnabled(true)
  return requestNotificationPermission()
}

export async function disableStudyReminders(): Promise<void> {
  await setRemindersEnabled(false)
}

export async function getDueReminderSummary(
  now = Date.now(),
): Promise<DueReminderSummary> {
  await initializeDatabase()
  const [settings, decks] = await Promise.all([
    getAppSettings(),
    db.decks.toArray(),
  ])

  if (!settings.remindersEnabled) {
    return {
      remindersEnabled: false,
      checkedAt: now,
      dueCount: 0,
      decks: [],
    }
  }

  const enabledDecks = decks.filter((deck) => deck.reminderEnabled)
  const enabledDeckIds = new Set(enabledDecks.map((deck) => deck.id))
  if (enabledDeckIds.size === 0) {
    return {
      remindersEnabled: true,
      checkedAt: now,
      dueCount: 0,
      decks: [],
    }
  }

  const dueCards = await db.cards
    .where('nextReviewAt')
    .belowOrEqual(now)
    .toArray()
  const countByDeck = new Map<string, number>()

  for (const card of dueCards) {
    if (enabledDeckIds.has(card.deckId)) {
      countByDeck.set(card.deckId, (countByDeck.get(card.deckId) ?? 0) + 1)
    }
  }

  const dueDecks = enabledDecks
    .map((deck) => ({
      id: deck.id,
      name: deck.name,
      dueCount: countByDeck.get(deck.id) ?? 0,
    }))
    .filter((deck) => deck.dueCount > 0)
    .sort((left, right) => right.dueCount - left.dueCount)

  return {
    remindersEnabled: true,
    checkedAt: now,
    dueCount: dueDecks.reduce((total, deck) => total + deck.dueCount, 0),
    decks: dueDecks,
  }
}

/**
 * Banner is the fallback when Web Notifications is unavailable or not granted.
 */
export async function getReminderBannerState(
  now = Date.now(),
): Promise<ReminderBannerState> {
  const [summary, permission] = await Promise.all([
    getDueReminderSummary(now),
    Promise.resolve(getNotificationPermission()),
  ])

  if (!summary.remindersEnabled) {
    return makeBannerState(summary, permission, false, 'disabled', '')
  }
  if (summary.dueCount === 0) {
    return makeBannerState(summary, permission, false, 'nothing-due', '')
  }
  if (permission === 'granted') {
    return makeBannerState(
      summary,
      permission,
      false,
      'notifications-available',
      makeDueMessage(summary),
    )
  }

  const reason =
    permission === 'unsupported'
      ? 'unsupported'
      : permission === 'denied'
        ? 'permission-denied'
        : 'permission-default'

  return makeBannerState(
    summary,
    permission,
    true,
    reason,
    makeDueMessage(summary),
  )
}

export function makeReminderSlotKey(time: string, now = new Date()): string {
  const year = now.getFullYear()
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const day = now.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}:${time}`
}

export async function runScheduledReminderCheck(
  now = new Date(),
  catchUpWindowMinutes = 15,
): Promise<ReminderCheckResult> {
  const settings = await getAppSettings()
  const checkedAt = now.getTime()
  if (!settings.remindersEnabled) {
    return {
      status: 'disabled',
      checkedAt,
      slotKeys: [],
    }
  }

  const inWindow = settings.reminderTimes.filter((time) =>
    isTimeInCatchUpWindow(time, now, catchUpWindowMinutes),
  )
  if (inWindow.length === 0) {
    return {
      status: 'not-scheduled-now',
      checkedAt,
      slotKeys: [],
    }
  }

  const pendingSlots = inWindow
    .map((time) => makeReminderSlotKey(time, now))
    .filter((slotKey) => !settings.lastNotificationBySlot[slotKey])
  if (pendingSlots.length === 0) {
    return {
      status: 'already-triggered',
      checkedAt,
      slotKeys: [],
    }
  }

  if (getNotificationPermission() !== 'granted') {
    return {
      status: 'permission-required',
      checkedAt,
      slotKeys: pendingSlots,
      summary: await getDueReminderSummary(checkedAt),
    }
  }

  const summary = await getDueReminderSummary(checkedAt)
  if (summary.dueCount === 0) {
    await markSlotsTriggered(pendingSlots, checkedAt)
    return {
      status: 'nothing-due',
      checkedAt,
      slotKeys: pendingSlots,
      summary,
    }
  }

  const notified = showDueNotification(summary)
  await markSlotsTriggered(pendingSlots, checkedAt)

  return {
    status: notified ? 'notified' : 'notification-failed',
    checkedAt,
    slotKeys: pendingSlots,
    summary,
  }
}

/**
 * Polls while this web page is alive. The visibility hook catches a reminder
 * shortly after a throttled/background tab becomes active again.
 */
export function startReminderScheduler(
  options: ReminderSchedulerOptions = {},
): ReminderScheduler {
  const pollIntervalMs = options.pollIntervalMs ?? 30_000
  const catchUpWindowMinutes = options.catchUpWindowMinutes ?? 15
  let stopped = false
  let runningCheck: Promise<ReminderCheckResult> | undefined

  const checkNow = (now = new Date()): Promise<ReminderCheckResult> => {
    if (runningCheck) {
      return runningCheck
    }

    runningCheck = runScheduledReminderCheck(now, catchUpWindowMinutes)
      .then((result) => {
        options.onCheck?.(result)
        return result
      })
      .finally(() => {
        runningCheck = undefined
      })

    return runningCheck
  }

  const triggerCheck = (): void => {
    if (!stopped) {
      void checkNow().catch((error: unknown) => options.onError?.(error))
    }
  }
  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      triggerCheck()
    }
  }

  const intervalId =
    typeof window === 'undefined'
      ? undefined
      : window.setInterval(triggerCheck, pollIntervalMs)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  triggerCheck()

  return {
    checkNow,
    stop: () => {
      stopped = true
      if (intervalId !== undefined) {
        window.clearInterval(intervalId)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange,
        )
      }
    },
  }
}

function showDueNotification(summary: DueReminderSummary): boolean {
  if (!supportsWebNotifications() || getNotificationPermission() !== 'granted') {
    return false
  }

  try {
    const notification = new window.Notification('Đến giờ ôn từ vựng', {
      body: makeDueMessage(summary),
      icon: '/favicon.svg',
      tag: 'vocab-study-reminder',
    })
    notification.addEventListener('click', () => {
      window.focus()
      notification.close()
    })
    return true
  } catch {
    return false
  }
}

function isTimeInCatchUpWindow(
  time: string,
  now: Date,
  catchUpWindowMinutes: number,
): boolean {
  const [hours, minutes] = time.split(':').map(Number)
  const scheduledAt = new Date(now)
  scheduledAt.setHours(hours, minutes, 0, 0)
  const elapsed = now.getTime() - scheduledAt.getTime()
  const windowMs = Math.max(1, catchUpWindowMinutes) * 60 * 1_000
  return elapsed >= 0 && elapsed <= windowMs
}

async function markSlotsTriggered(
  slotKeys: string[],
  triggeredAt: number,
): Promise<void> {
  for (const slotKey of slotKeys) {
    await markNotificationSlotTriggered(slotKey, triggeredAt)
  }
}

function makeDueMessage(summary: DueReminderSummary): string {
  const deckNames = summary.decks
    .slice(0, 2)
    .map((deck) => deck.name)
    .join(', ')
  const suffix = summary.decks.length > 2 ? '…' : ''
  return `Bạn có ${summary.dueCount} thẻ cần ôn${
    deckNames ? ` trong ${deckNames}${suffix}` : ''
  }.`
}

function makeBannerState(
  summary: DueReminderSummary,
  permission: NotificationPermissionState,
  visible: boolean,
  reason: ReminderBannerReason,
  message: string,
): ReminderBannerState {
  return {
    ...summary,
    permission,
    visible,
    reason,
    message,
  }
}
