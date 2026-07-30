import { useMemo, useState } from 'react'
import {
  Bell,
  BellOff,
  Check,
  Clock3,
  Info,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'

import type { CloudSyncState } from '../cloud/types'
import { CloudAndBackupPanel } from '../components/CloudAndBackupPanel'
import type { AppSettings, DeckSummary } from '../models'

type NotificationState = NotificationPermission | 'unsupported'

interface SettingsScreenProps {
  settings: AppSettings
  decks: DeckSummary[]
  onToggleReminders: (enabled: boolean) => Promise<void>
  onChangeTimes: (times: string[]) => Promise<void>
  onToggleDeck: (deckId: string, enabled: boolean) => Promise<void>
  cloud: CloudSyncState
  onSyncNow: () => Promise<void>
  onSignOut: () => Promise<void>
  onDataRestored: () => Promise<void>
}

function readNotificationState(): NotificationState {
  return 'Notification' in window ? Notification.permission : 'unsupported'
}

export function SettingsScreen({
  settings,
  decks,
  onToggleReminders,
  onChangeTimes,
  onToggleDeck,
  cloud,
  onSyncNow,
  onSignOut,
  onDataRestored,
}: SettingsScreenProps) {
  const [newTime, setNewTime] = useState('19:30')
  const [permission, setPermission] = useState<NotificationState>(
    readNotificationState,
  )
  const [saving, setSaving] = useState(false)
  const sortedTimes = useMemo(
    () => [...settings.reminderTimes].sort(),
    [settings.reminderTimes],
  )

  async function runSaving(action: () => Promise<void>) {
    setSaving(true)
    try {
      await action()
    } finally {
      setSaving(false)
    }
  }

  async function requestPermission() {
    if (!('Notification' in window)) return
    const result = await Notification.requestPermission()
    setPermission(result)
  }

  async function addTime() {
    if (!newTime || sortedTimes.includes(newTime)) return
    await runSaving(() => onChangeTimes([...sortedTimes, newTime]))
  }

  return (
    <section className="page settings-page" data-testid="settings-screen">
      <div className="page-heading settings-heading">
        <div>
          <p className="eyebrow">NHỊP HỌC CỦA BẠN</p>
          <h1>Nhắc nhẹ, đúng lúc.</h1>
          <p>
            Chọn những khung giờ vừa vặn để việc ôn từ trở thành một nhịp quen.
          </p>
        </div>
        <div className="heading-illustration" aria-hidden="true">
          <Bell />
          <span />
          <i />
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-main">
          <CloudAndBackupPanel
            cloud={cloud}
            onSyncNow={onSyncNow}
            onSignOut={onSignOut}
            onDataRestored={onDataRestored}
          />

          <article className="paper-panel setting-section">
            <div className="setting-row setting-row-primary">
              <div className="setting-icon">
                {settings.remindersEnabled ? <Bell /> : <BellOff />}
              </div>
              <div className="setting-copy">
                <h2>Nhắc mình học mỗi ngày</h2>
                <p>Thông báo chỉ áp dụng trên thiết bị và trình duyệt này.</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.remindersEnabled}
                  disabled={saving}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    if (enabled && permission === 'default') {
                      void requestPermission()
                    }
                    void runSaving(() => onToggleReminders(enabled))
                  }}
                  aria-label="Nhắc mình học mỗi ngày"
                />
                <span className="switch-track" />
              </label>
            </div>

            <NotificationCallout
              permission={permission}
              onRequest={() => void requestPermission()}
            />
          </article>

          <article
            className={`paper-panel setting-section ${
              settings.remindersEnabled ? '' : 'is-dimmed'
            }`}
          >
            <div className="section-title-row">
              <div>
                <p className="eyebrow">THỜI GIAN</p>
                <h2>Giờ nhắc trong ngày</h2>
              </div>
              <Clock3 aria-hidden="true" />
            </div>

            <div className="reminder-times">
              {sortedTimes.map((time) => (
                <div className="time-row" key={time}>
                  <time>{time}</time>
                  <span>mỗi ngày</span>
                  <button
                    className="icon-button"
                    type="button"
                    disabled={!settings.remindersEnabled || saving}
                    onClick={() =>
                      void runSaving(() =>
                        onChangeTimes(
                          sortedTimes.filter((item) => item !== time),
                        ),
                      )
                    }
                    aria-label={`Xóa giờ nhắc ${time}`}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>

            <div className="add-time-row">
              <label>
                <span>Thêm một khung giờ</span>
                <input
                  type="time"
                  value={newTime}
                  disabled={!settings.remindersEnabled || saving}
                  onChange={(event) => setNewTime(event.target.value)}
                />
              </label>
              <button
                className="button button-secondary"
                type="button"
                disabled={
                  !settings.remindersEnabled ||
                  saving ||
                  !newTime ||
                  sortedTimes.includes(newTime)
                }
                onClick={() => void addTime()}
              >
                <Plus />
                Thêm giờ
              </button>
            </div>
            {settings.remindersEnabled && sortedTimes.length === 0 && (
              <p className="inline-warning">
                Thêm ít nhất một giờ để nhận lời nhắc.
              </p>
            )}
          </article>

          <article
            className={`paper-panel setting-section ${
              settings.remindersEnabled ? '' : 'is-dimmed'
            }`}
          >
            <div className="section-title-row">
              <div>
                <p className="eyebrow">TỪNG BỘ THẺ</p>
                <h2>Nhắc theo bộ từ</h2>
              </div>
            </div>
            <div className="deck-setting-list">
              {decks.map((deck) => (
                <div className="deck-setting-row" key={deck.id}>
                  <div>
                    <strong>{deck.name}</strong>
                    <span>
                      {deck.dueCount > 0
                        ? `${deck.dueCount} thẻ đến hạn`
                        : 'Chưa có thẻ cần ôn'}
                    </span>
                  </div>
                  <label className="switch switch-small">
                    <input
                      type="checkbox"
                      checked={deck.reminderEnabled}
                      disabled={!settings.remindersEnabled || saving}
                      onChange={(event) =>
                        void runSaving(() =>
                          onToggleDeck(deck.id, event.target.checked),
                        )
                      }
                      aria-label={`Nhắc học bộ ${deck.name}`}
                    />
                    <span className="switch-track" />
                  </label>
                </div>
              ))}
              {decks.length === 0 && (
                <p className="setting-empty">
                  Chưa có bộ từ nào để bật lời nhắc riêng.
                </p>
              )}
            </div>
          </article>
        </div>

        <aside className="settings-note paper-note">
          <Info />
          <h3>Một lưu ý nhỏ</h3>
          <p>
            Thông báo web có thể đến muộn khi trình duyệt bị đóng. Khi bạn mở
            lại Vun Từ, lời nhắc còn thiếu vẫn sẽ hiện trong app.
          </p>
          <div className="privacy-line">
            <ShieldCheck />
            <span>
              {cloud.configured
                ? 'Dữ liệu học được mã hóa khi truyền và chỉ tài khoản của bạn truy cập được.'
                : 'Chưa có Firebase: dữ liệu hiện chỉ được lưu trên thiết bị này.'}
            </span>
          </div>
        </aside>
      </div>
    </section>
  )
}

function NotificationCallout({
  permission,
  onRequest,
}: {
  permission: NotificationState
  onRequest: () => void
}) {
  if (permission === 'granted') {
    return (
      <div className="permission-callout permission-granted">
        <Check />
        <div>
          <strong>Đã được phép gửi thông báo</strong>
          <span>Vun Từ sẽ dùng các giờ bạn chọn bên dưới.</span>
        </div>
      </div>
    )
  }

  if (permission === 'denied') {
    return (
      <div className="permission-callout permission-denied">
        <BellOff />
        <div>
          <strong>Trình duyệt đang chặn thông báo</strong>
          <span>Bạn vẫn sẽ thấy lời nhắc trong app khi mở lại.</span>
        </div>
      </div>
    )
  }

  if (permission === 'unsupported') {
    return (
      <div className="permission-callout">
        <Info />
        <div>
          <strong>Thiết bị chưa hỗ trợ thông báo web</strong>
          <span>Nhắc trong app vẫn hoạt động bình thường.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="permission-callout">
      <Bell />
      <div>
        <strong>Cho phép thông báo trên thiết bị</strong>
        <span>Bạn chỉ được hỏi quyền sau khi bấm nút này.</span>
      </div>
      <button className="button button-small" type="button" onClick={onRequest}>
        Cho phép
      </button>
    </div>
  )
}
