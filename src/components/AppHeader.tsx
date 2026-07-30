import {
  Bell,
  Cloud,
  CloudOff,
  Library,
  Plus,
  RefreshCw,
} from 'lucide-react'

import type { CloudSyncState } from '../cloud/types'
import type { AppSettings } from '../models'
import type { AppScreen } from '../navigation'

export interface AppHeaderProps {
  currentScreen: AppScreen
  onNavigate: (screen: AppScreen) => void
  settings?: Pick<AppSettings, 'remindersEnabled' | 'reminderTimes'> | null
  cloud: CloudSyncState
}

const primaryNavigation: ReadonlyArray<{
  screen: AppScreen
  label: string
}> = [
  { screen: 'today', label: 'Hôm nay' },
  { screen: 'decks', label: 'Bộ từ' },
  { screen: 'reminders', label: 'Cài đặt' },
]

function getReminderLabel(
  settings: AppHeaderProps['settings'],
): string {
  if (!settings?.remindersEnabled) {
    return 'Mở cài đặt nhắc học, hiện đang tắt'
  }

  const timeCount = settings.reminderTimes.length
  if (timeCount === 0) {
    return 'Mở cài đặt nhắc học, chưa có giờ nhắc'
  }

  return `Mở cài đặt nhắc học, đang bật ${timeCount} khung giờ`
}

export function AppHeader({
  currentScreen,
  onNavigate,
  settings = null,
  cloud,
}: AppHeaderProps) {
  const remindersActive =
    settings?.remindersEnabled && settings.reminderTimes.length > 0

  return (
    <header className="app-header" data-testid="app-header">
      <div className="app-header__inner">
        <button
          className="brand-button"
          type="button"
          onClick={() => onNavigate('today')}
          aria-label="Về trang Hôm nay"
          data-testid="header-brand"
        >
          <span className="brand-mark" aria-hidden="true">
            <span className="brand-sprout">
              <i className="brand-sprout__stem" />
              <i className="brand-sprout__leaf brand-sprout__leaf-left" />
              <i className="brand-sprout__leaf brand-sprout__leaf-right" />
            </span>
          </span>
          <span className="brand-copy">
            <span className="brand-wordmark">Vun Từ</span>
            <span className="brand-tagline">Sổ học từ vựng</span>
          </span>
        </button>

        <nav
          className="desktop-navigation"
          aria-label="Điều hướng chính"
        >
          {primaryNavigation.map((item) => {
            const active = currentScreen === item.screen

            return (
              <button
                className={`navigation-link${active ? ' is-active' : ''}`}
                type="button"
                key={item.screen}
                onClick={() => onNavigate(item.screen)}
                aria-current={active ? 'page' : undefined}
                data-testid={`header-nav-${item.screen}`}
              >
                {item.screen === 'decks' && (
                  <Library aria-hidden="true" />
                )}
                {item.screen === 'reminders' && (
                  <Bell aria-hidden="true" />
                )}
                {item.label}
                {item.screen === 'reminders' && remindersActive && (
                  <span
                    className="navigation-status-dot"
                    aria-label="Nhắc học đang bật"
                  />
                )}
              </button>
            )
          })}
        </nav>

        <div className="app-header__actions">
          <CloudShortcut
            cloud={cloud}
            onOpenSettings={() => onNavigate('reminders')}
          />

          <button
            className={`reminder-shortcut${
              currentScreen === 'reminders' ? ' is-active' : ''
            }`}
            type="button"
            onClick={() => onNavigate('reminders')}
            aria-label={getReminderLabel(settings)}
            aria-current={
              currentScreen === 'reminders' ? 'page' : undefined
            }
            data-testid="header-reminders"
          >
            <Bell aria-hidden="true" />
            {remindersActive && (
              <span className="reminder-shortcut__dot" aria-hidden="true" />
            )}
          </button>

          <button
            className={`button button-primary header-import-button${
              currentScreen === 'import' ? ' is-active' : ''
            }`}
            type="button"
            onClick={() => onNavigate('import')}
            aria-current={currentScreen === 'import' ? 'page' : undefined}
            data-testid="header-import"
          >
            <Plus aria-hidden="true" />
            <span>Nhập bộ từ</span>
          </button>
        </div>
      </div>
    </header>
  )
}

function CloudShortcut({
  cloud,
  onOpenSettings,
}: {
  cloud: CloudSyncState
  onOpenSettings: () => void
}) {
  const syncing =
    cloud.syncPhase === 'syncing' ||
    cloud.syncPhase === 'bootstrapping'
  const tone = !cloud.configured
    ? 'local'
    : !cloud.online || cloud.syncPhase === 'offline'
      ? 'offline'
      : cloud.syncPhase === 'error'
        ? 'warning'
        : syncing || cloud.pendingCount > 0
          ? 'busy'
          : 'synced'
  const label =
    tone === 'local'
      ? 'Chỉ trên máy'
      : tone === 'offline'
        ? 'Đang offline'
        : tone === 'warning'
          ? 'Lỗi đồng bộ'
          : tone === 'busy'
            ? cloud.pendingCount > 0
              ? `Chờ ${cloud.pendingCount}`
              : 'Đang đồng bộ'
            : 'Đã đồng bộ'
  const detail =
    tone === 'local'
      ? 'Chưa kết nối Firebase; dữ liệu chỉ ở thiết bị này'
      : `${label}. Mở cài đặt đồng bộ`

  return (
    <button
      className={`cloud-shortcut is-${tone}`}
      type="button"
      onClick={onOpenSettings}
      aria-label={detail}
      title={detail}
      data-testid="cloud-status-shortcut"
    >
      {syncing ? (
        <RefreshCw className="spin" aria-hidden="true" />
      ) : tone === 'offline' || tone === 'local' ? (
        <CloudOff aria-hidden="true" />
      ) : (
        <Cloud aria-hidden="true" />
      )}
      <span>{label}</span>
      {(tone === 'warning' || tone === 'busy') && (
        <i aria-hidden="true" />
      )}
    </button>
  )
}
