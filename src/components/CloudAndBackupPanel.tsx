import { useRef, useState, type ChangeEvent } from 'react'
import {
  CheckCircle2,
  Cloud,
  CloudOff,
  Download,
  FileJson,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react'

import type { CloudSyncState } from '../cloud/types'
import {
  BackupValidationError,
  downloadBackup,
  parseBackupText,
  restoreBackup,
  shareBackup,
} from '../lib/backup'

interface CloudAndBackupPanelProps {
  cloud: CloudSyncState
  onSyncNow: () => Promise<void>
  onSignOut: () => Promise<void>
  onDataRestored: () => Promise<void>
}

export function CloudAndBackupPanel({
  cloud,
  onSyncNow,
  onSignOut,
  onDataRestored,
}: CloudAndBackupPanelProps) {
  const restoreInput = useRef<HTMLInputElement>(null)
  const [busyAction, setBusyAction] = useState<
    'sync' | 'backup' | 'restore' | 'signout' | null
  >(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function run(
    action: Exclude<typeof busyAction, null>,
    task: () => Promise<void>,
  ) {
    setBusyAction(action)
    setNotice('')
    setError('')
    try {
      await task()
    } catch (caught) {
      if (
        caught instanceof DOMException &&
        caught.name === 'AbortError'
      ) {
        return
      }
      setError(readError(caught))
    } finally {
      setBusyAction(null)
    }
  }

  async function saveBackup() {
    await run('backup', async () => {
      const outcome = await shareBackup()
      setNotice(
        outcome === 'shared'
          ? 'Đã mở bảng chia sẻ. Hãy chọn “Lưu vào Tệp” rồi chọn iCloud Drive.'
          : 'Đã tải bản sao lưu JSON về thiết bị.',
      )
    })
  }

  async function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    await run('restore', async () => {
      const backup = parseBackupText(await file.text())
      const result = await restoreBackup(backup)
      await onDataRestored()
      const changed =
        result.decks + result.cards + result.studyLogs + result.settings
      setNotice(
        changed > 0
          ? `Đã khôi phục ${result.decks} bộ từ, ${result.cards} thẻ và ${result.studyLogs} lượt học. Dữ liệu mới hơn trên máy vẫn được giữ.`
          : 'Bản sao lưu này không có dữ liệu nào mới hơn dữ liệu hiện tại.',
      )
    })
  }

  async function signOut() {
    if (
      cloud.pendingCount > 0 &&
      !window.confirm(
        `Còn ${cloud.pendingCount} thay đổi chưa lên cloud. Chúng vẫn được giữ trên máy và sẽ đồng bộ khi bạn đăng nhập lại. Vẫn đăng xuất?`,
      )
    ) {
      return
    }
    await run('signout', onSignOut)
  }

  const disabled = busyAction !== null
  const status = getCloudStatus(cloud)

  return (
    <article
      className="paper-panel setting-section cloud-backup-panel"
      data-testid="cloud-backup-panel"
    >
      <div className="section-title-row">
        <div>
          <p className="eyebrow">DỮ LIỆU CỦA BẠN</p>
          <h2>Đồng bộ &amp; sao lưu</h2>
        </div>
        {cloud.online ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
      </div>

      <div className={`cloud-status-card is-${status.tone}`}>
        <span className="cloud-status-card__icon" aria-hidden="true">
          {status.tone === 'good' ? (
            <CheckCircle2 />
          ) : status.tone === 'offline' ? (
            <CloudOff />
          ) : (
            <Cloud />
          )}
        </span>
        <div className="cloud-status-card__copy">
          <strong>{status.title}</strong>
          <span>{status.detail}</span>
          {cloud.user?.email && <small>{cloud.user.email}</small>}
        </div>
        {cloud.configured && cloud.authPhase === 'signed-in' && (
          <button
            className="button button-secondary button-small"
            type="button"
            disabled={disabled || !cloud.online}
            onClick={() =>
              void run('sync', async () => {
                await onSyncNow()
                setNotice('Đã hoàn tất lượt kiểm tra và đồng bộ dữ liệu.')
              })
            }
          >
            {busyAction === 'sync' ? (
              <LoaderCircle className="spin" />
            ) : (
              <RefreshCw />
            )}
            Đồng bộ ngay
          </button>
        )}
      </div>

      {cloud.error && (
        <p className="cloud-panel-warning" role="alert">
          {cloud.error}
        </p>
      )}

      <div className="backup-actions">
        <div>
          <span className="backup-action-icon">
            <FileJson />
          </span>
          <div>
            <strong>Bản dự phòng trong iCloud Drive</strong>
            <p>
              Gói JSON gồm bộ từ, thẻ, tiến độ, lịch sử học và cài đặt.
              File này không mã hóa: chỉ lưu trong iCloud cá nhân và không
              chia sẻ. File gốc DOCX/TXT/XLSX vẫn được giữ riêng trong iCloud.
            </p>
          </div>
        </div>
        <div className="backup-action-buttons">
          <button
            className="button button-primary"
            type="button"
            disabled={disabled}
            onClick={() => void saveBackup()}
          >
            {busyAction === 'backup' ? (
              <LoaderCircle className="spin" />
            ) : (
              <Download />
            )}
            Lưu bản sao
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={disabled}
            onClick={() => restoreInput.current?.click()}
          >
            {busyAction === 'restore' ? (
              <LoaderCircle className="spin" />
            ) : (
              <Upload />
            )}
            Khôi phục
          </button>
          <input
            ref={restoreInput}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void restore(event)}
            tabIndex={-1}
          />
        </div>
      </div>

      {notice && (
        <p className="cloud-panel-notice" role="status">
          <CheckCircle2 />
          {notice}
        </p>
      )}
      {error && (
        <p className="cloud-panel-warning" role="alert">
          {error}
        </p>
      )}

      {cloud.configured && cloud.authPhase === 'signed-in' && (
        <div className="cloud-account-row">
          <div>
            <ShieldCheck />
            <span>
              <strong>Chỉ tài khoản này được đọc dữ liệu</strong>
              <small>
                GitHub chỉ giữ mã app; dữ liệu học nằm trong Firebase và bản offline.
              </small>
            </span>
          </div>
          <button
            className="text-danger-button"
            type="button"
            disabled={disabled}
            onClick={() => void signOut()}
          >
            {busyAction === 'signout' ? (
              <LoaderCircle className="spin" />
            ) : (
              <LogOut />
            )}
            Đăng xuất
          </button>
        </div>
      )}

      {!cloud.configured && (
        <div className="local-mode-note">
          <CloudOff />
          <p>
            <strong>Đang chạy chế độ chỉ trên máy này.</strong>
            <span>
              Hãy hoàn tất cấu hình Firebase trong hướng dẫn triển khai trước
              khi nhập dữ liệu thật nếu bạn muốn dùng chung ở mọi nơi.
            </span>
          </p>
          <button
            className="button button-secondary button-small"
            type="button"
            disabled={disabled}
            onClick={() =>
              void run('backup', async () => {
                const fileName = await downloadBackup()
                setNotice(`Đã tải ${fileName}.`)
              })
            }
          >
            <Download />
            Tải JSON
          </button>
        </div>
      )}
    </article>
  )
}

function getCloudStatus(cloud: CloudSyncState): {
  title: string
  detail: string
  tone: 'good' | 'busy' | 'offline' | 'warning'
} {
  if (!cloud.configured) {
    return {
      title: 'Chưa kết nối Firebase',
      detail: 'Dữ liệu hiện chỉ nằm trong trình duyệt này.',
      tone: 'warning',
    }
  }
  if (!cloud.online || cloud.syncPhase === 'offline') {
    return {
      title: 'Đang dùng bản offline',
      detail:
        cloud.pendingCount > 0
          ? `${cloud.pendingCount} thay đổi đang chờ có mạng.`
          : 'Bạn vẫn có thể học; app sẽ tự đồng bộ khi có mạng.',
      tone: 'offline',
    }
  }
  if (
    cloud.syncPhase === 'syncing' ||
    cloud.syncPhase === 'bootstrapping'
  ) {
    return {
      title:
        cloud.syncPhase === 'bootstrapping'
          ? 'Đang ghép dữ liệu lần đầu'
          : 'Đang đồng bộ',
      detail:
        cloud.pendingCount > 0
          ? `Còn ${cloud.pendingCount} thay đổi.`
          : 'Đang kiểm tra dữ liệu mới.',
      tone: 'busy',
    }
  }
  if (cloud.syncPhase === 'error') {
    return {
      title: 'Đồng bộ cần được thử lại',
      detail:
        cloud.pendingCount > 0
          ? `${cloud.pendingCount} thay đổi còn trong bộ nhớ offline của trình duyệt.`
          : 'Hãy thử lại và giữ thêm một bản dự phòng JSON.',
      tone: 'warning',
    }
  }

  return {
    title:
      cloud.pendingCount > 0
        ? `${cloud.pendingCount} thay đổi đang chờ`
        : 'Dữ liệu đã đồng bộ',
    detail: cloud.lastSyncedAt
      ? `Lần gần nhất: ${formatSyncTime(cloud.lastSyncedAt)}`
      : 'Sẵn sàng đồng bộ giữa các thiết bị.',
    tone: cloud.pendingCount > 0 ? 'busy' : 'good',
  }
}

function formatSyncTime(timestamp: number): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(timestamp)
}

function readError(error: unknown): string {
  if (error instanceof BackupValidationError) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Không thể hoàn tất thao tác. Hãy thử lại.'
}
