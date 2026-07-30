import { useState, type FormEvent } from 'react'
import {
  Cloud,
  CloudOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sprout,
} from 'lucide-react'

interface CloudLoginScreenProps {
  busy: boolean
  online: boolean
  error?: string
  onSignIn: (email: string, password: string) => Promise<void>
  onResetPassword: (email: string) => Promise<void>
}

export function CloudLoginScreen({
  busy,
  online,
  error,
  onSignIn,
  onResetPassword,
}: CloudLoginScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [localError, setLocalError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setLocalError('')
    try {
      await onSignIn(email.trim(), password)
    } catch (caught) {
      setLocalError(readError(caught))
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setLocalError('Hãy nhập email trước khi yêu cầu đặt lại mật khẩu.')
      return
    }
    setMessage('')
    setLocalError('')
    try {
      await onResetPassword(email.trim())
      setMessage('Đã gửi email đặt lại mật khẩu. Hãy kiểm tra hộp thư.')
    } catch (caught) {
      setLocalError(readError(caught))
    }
  }

  return (
    <main className="cloud-login-page" data-testid="cloud-login-screen">
      <section className="cloud-login-story" aria-label="Giới thiệu Vun Từ">
        <div className="cloud-login-brand">
          <span className="cloud-login-brand__mark" aria-hidden="true">
            <Sprout />
          </span>
          <span>
            <strong>Vun Từ</strong>
            <small>Sổ học từ vựng của riêng bạn</small>
          </span>
        </div>

        <div className="cloud-login-story__copy">
          <p className="eyebrow">MỘT TÀI KHOẢN · MỌI THIẾT BỊ</p>
          <h1>Học tiếp đúng nơi bạn đã dừng.</h1>
          <p>
            Bộ từ, tiến độ và lịch sử học được đồng bộ giữa máy tính,
            iPhone và mọi trình duyệt bạn đăng nhập.
          </p>
        </div>

        <div className="cloud-login-flow" aria-label="Cách dữ liệu được lưu">
          <div>
            <Cloud />
            <span>
              <strong>Firebase</strong>
              <small>Dữ liệu chung</small>
            </span>
          </div>
          <i aria-hidden="true" />
          <div>
            <ShieldCheck />
            <span>
              <strong>Riêng tư</strong>
              <small>Chỉ tài khoản của bạn</small>
            </span>
          </div>
          <i aria-hidden="true" />
          <div>
            <CloudOff />
            <span>
              <strong>Offline</strong>
              <small>Tự đồng bộ lại</small>
            </span>
          </div>
        </div>
      </section>

      <section className="cloud-login-panel">
        <form className="cloud-login-card" onSubmit={(event) => void submit(event)}>
          <div className="cloud-login-card__icon" aria-hidden="true">
            <LockKeyhole />
          </div>
          <div>
            <p className="eyebrow">KHÔNG GIAN RIÊNG</p>
            <h2>Đăng nhập để mở sổ học</h2>
            <p className="cloud-login-card__intro">
              Dùng tài khoản duy nhất bạn sẽ tạo trong Firebase.
            </p>
          </div>

          {!online && (
            <div className="cloud-login-offline" role="status">
              <CloudOff />
              Cần có mạng cho lần đăng nhập này.
            </div>
          )}

          <label className="cloud-login-field">
            <span>Email</span>
            <div>
              <Mail aria-hidden="true" />
              <input
                type="email"
                inputMode="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="ten-cua-ban@example.com"
                required
                disabled={busy}
              />
            </div>
          </label>

          <label className="cloud-login-field">
            <span>Mật khẩu</span>
            <div>
              <KeyRound aria-hidden="true" />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Nhập mật khẩu"
                required
                minLength={6}
                disabled={busy}
              />
            </div>
          </label>

          {(localError || error) && (
            <p className="cloud-login-error" role="alert">
              {localError || error}
            </p>
          )}
          {message && (
            <p className="cloud-login-success" role="status">
              {message}
            </p>
          )}

          <button
            className="button button-primary cloud-login-submit"
            type="submit"
            disabled={busy || !online}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" />
                Đang đăng nhập…
              </>
            ) : (
              <>
                <LockKeyhole />
                Mở sổ học của tôi
              </>
            )}
          </button>

          <button
            className="cloud-login-reset"
            type="button"
            disabled={busy || !online}
            onClick={() => void resetPassword()}
          >
            Quên mật khẩu?
          </button>

          <p className="cloud-login-help">
            App không cho đăng ký công khai. Tài khoản được tạo một lần
            trong Firebase Console theo hướng dẫn triển khai.
          </p>
        </form>
      </section>
    </main>
  )
}

function readError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Không thể hoàn tất. Hãy kiểm tra mạng và thử lại.'
}
