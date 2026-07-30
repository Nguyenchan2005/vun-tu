import {
  APP_SETTINGS_ID,
  type AppSettings,
  type StudyDirection,
} from '../models'
import {
  createDefaultSettings,
  db,
  initializeDatabase,
} from './database'
import {
  buildSyncUpsert,
  putSyncOutboxEntries,
} from './outbox-helpers'

export type AppSettingsUpdate = Partial<
  Omit<AppSettings, 'id' | 'updatedAt'>
>

export async function getAppSettings(): Promise<AppSettings> {
  await initializeDatabase()
  const settings = await db.settings.get(APP_SETTINGS_ID)
  if (settings) {
    return settings
  }

  const defaults = createDefaultSettings()
  await putLocalSettings(defaults)
  return defaults
}

export async function updateAppSettings(
  patch: AppSettingsUpdate,
  now = Date.now(),
): Promise<AppSettings> {
  const current = await getAppSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    id: APP_SETTINGS_ID,
    reminderTimes:
      patch.reminderTimes === undefined
        ? current.reminderTimes
        : normalizeReminderTimes(patch.reminderTimes),
    dailyGoal:
      patch.dailyGoal === undefined
        ? current.dailyGoal
        : normalizeDailyGoal(patch.dailyGoal),
    updatedAt: now,
  }

  await putLocalSettings(next, now)
  return next
}

export async function setRemindersEnabled(
  enabled: boolean,
): Promise<AppSettings> {
  return updateAppSettings({ remindersEnabled: enabled })
}

export async function setReminderTimes(
  reminderTimes: string[],
): Promise<AppSettings> {
  return updateAppSettings({ reminderTimes })
}

export async function setPreferredDirection(
  preferredDirection: StudyDirection,
): Promise<AppSettings> {
  return updateAppSettings({ preferredDirection })
}

export async function markNotificationSlotTriggered(
  slotKey: string,
  triggeredAt = Date.now(),
): Promise<AppSettings> {
  const current = await getAppSettings()
  const retentionStart = triggeredAt - 45 * 24 * 60 * 60 * 1_000
  const recentSlots = Object.fromEntries(
    Object.entries(current.lastNotificationBySlot).filter(
      ([, timestamp]) => timestamp >= retentionStart,
    ),
  )

  return updateAppSettings(
    {
      lastNotificationBySlot: {
        ...recentSlots,
        [slotKey]: triggeredAt,
      },
    },
    triggeredAt,
  )
}

export async function resetAppSettings(): Promise<AppSettings> {
  const defaults = createDefaultSettings()
  await initializeDatabase()
  await putLocalSettings(defaults, defaults.updatedAt)
  return defaults
}

export function normalizeReminderTimes(values: string[]): string[] {
  const times = new Set<string>()

  for (const value of values) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match) {
      throw new Error(`Giờ nhắc "${value}" không đúng định dạng HH:mm.`)
    }

    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) {
      throw new Error(`Giờ nhắc "${value}" không hợp lệ.`)
    }
    times.add(
      `${hour.toString().padStart(2, '0')}:${minute
        .toString()
        .padStart(2, '0')}`,
    )
  }

  return [...times].sort()
}

function normalizeDailyGoal(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Mục tiêu học mỗi ngày không hợp lệ.')
  }
  return Math.max(1, Math.round(value))
}

async function putLocalSettings(
  settings: AppSettings,
  queuedAt = Date.now(),
): Promise<void> {
  await db.transaction(
    'rw',
    db.settings,
    db.syncOutbox,
    async () => {
      await db.settings.put(settings)
      await putSyncOutboxEntries(db.syncOutbox, [
        buildSyncUpsert('settings', settings, queuedAt),
      ])
    },
  )
}
