import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from 'react'
import {
  Bell,
  BookOpen,
  Cloud,
  CloudOff,
  LoaderCircle,
  X,
} from 'lucide-react'

import './App.css'
import {
  cloudAvailable,
  cloudClientResult,
  cloudConfigured,
  firebaseAuthErrorMessage,
  getCloudSyncState,
  loginCloud,
  logoutCloud,
  resetCloudPassword,
  signOutCloudSync,
  syncCloudNow,
  startCloudSyncForUser,
  subscribeCloudAuth,
  subscribeCloudSync,
} from './cloud'
import { AppHeader } from './components/AppHeader'
import { MobileNav } from './components/MobileNav'
import {
  getAppSettings,
  getDeck,
  getStudyStats,
  importCards,
  initializeDatabase,
  listDeckSummaries,
  setDeckReminderEnabled,
  setReminderTimes,
  setRemindersEnabled,
  updateDeck,
  type StudyStats,
} from './db'
import {
  getReminderBannerState,
  startReminderScheduler,
  type ReminderBannerState,
} from './lib/reminders'
import type {
  AppSettings,
  Deck,
  DeckSummary,
  StudyDirection,
} from './models'
import type { AppScreen } from './navigation'
import { CloudLoginScreen } from './screens/CloudLoginScreen'
import { DashboardScreen } from './screens/DashboardScreen'
import { DeckLibraryScreen } from './screens/DeckLibraryScreen'
import type { ImportSavePayload } from './screens/ImportScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { StudyScreen } from './screens/StudyScreen'

const EMPTY_STATS: StudyStats = {
  reviewCount: 0,
  correctCount: 0,
  incorrectCount: 0,
  accuracy: 0,
}

const ImportScreen = lazy(async () => {
  const module = await import('./screens/ImportScreen')
  return { default: module.ImportScreen }
})

function App() {
  const [screen, setScreen] = useState<AppScreen>('today')
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [stats, setStats] = useState<StudyStats>(EMPTY_STATS)
  const [studyDeck, setStudyDeck] = useState<Deck | null>(null)
  const [loading, setLoading] = useState(true)
  const [appError, setAppError] = useState('')
  const [banner, setBanner] = useState<ReminderBannerState | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [cloud, setCloud] = useState(getCloudSyncState)
  const [authResolved, setAuthResolved] = useState(!cloudAvailable)
  const [authBusy, setAuthBusy] = useState(false)
  const [browserOnline, setBrowserOnline] = useState(
    () => navigator.onLine,
  )

  const refreshBanner = useCallback(async () => {
    try {
      setBanner(await getReminderBannerState())
    } catch {
      setBanner(null)
    }
  }, [])

  const refreshData = useCallback(async () => {
    const [nextDecks, nextSettings, nextStats] = await Promise.all([
      listDeckSummaries(),
      getAppSettings(),
      getStudyStats(),
    ])
    setDecks(nextDecks)
    setSettings(nextSettings)
    setStats(nextStats)
  }, [])

  useEffect(() => {
    const online = () => setBrowserOnline(true)
    const offline = () => setBrowserOnline(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  useEffect(() => {
    let active = true
    async function openApp() {
      try {
        await initializeDatabase()
        if (!active) return
        await Promise.all([refreshData(), refreshBanner()])
      } catch {
        if (active) {
          setAppError(
            'Không thể lưu dữ liệu trên trình duyệt này. Hãy kiểm tra quyền lưu trữ của thiết bị.',
          )
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void openApp()
    return () => {
      active = false
    }
  }, [refreshBanner, refreshData])

  useEffect(() => {
    if (cloudAvailable && cloud.authPhase !== 'signed-in') {
      return
    }

    const reminderScheduler = startReminderScheduler({
      onCheck: () => void refreshBanner(),
    })
    return () => reminderScheduler.stop()
  }, [cloud.authPhase, refreshBanner])

  useEffect(() => {
    let active = true
    let previousChangeVersion = getCloudSyncState().changeVersion
    const stopState = subscribeCloudSync((nextState) => {
      if (!active) return
      setCloud(nextState)
      if (nextState.changeVersion !== previousChangeVersion) {
        previousChangeVersion = nextState.changeVersion
        void Promise.all([refreshData(), refreshBanner()])
      }
    })

    if (!cloudAvailable) {
      setAuthResolved(true)
      return () => {
        active = false
        stopState()
      }
    }

    const stopAuth = subscribeCloudAuth((user) => {
      if (!active) return
      setAuthResolved(true)
      if (user) {
        void startCloudSyncForUser(user.uid, user.email).catch(() => {
          // The engine exposes bootstrap errors through CloudSyncState.
        })
      } else {
        signOutCloudSync()
      }
    })

    return () => {
      active = false
      stopAuth()
      stopState()
    }
  }, [refreshBanner, refreshData])

  function navigate(nextScreen: AppScreen) {
    setScreen(nextScreen)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function startStudy(deckId: string) {
    void getDeck(deckId).then((deck) => {
      if (deck) setStudyDeck(deck)
    })
  }

  async function saveImport(payload: ImportSavePayload) {
    const saved = await importCards({
      target:
        payload.target.kind === 'new'
          ? {
              kind: 'new',
              deck: {
                name: payload.target.name,
                sourceName: payload.target.sourceName,
                sourceType: payload.target.sourceType,
                preferredDirection: payload.target.preferredDirection,
              },
            }
          : { kind: 'existing', deckId: payload.target.deckId },
      cards: payload.cards,
      mode: 'append',
      skipDuplicates: true,
    })
    await Promise.all([refreshData(), refreshBanner()])
    return {
      deckId: saved.deck.id,
      deckName: saved.deck.name,
      importedCount: saved.importedCount,
      skippedCount: saved.skippedCount,
    }
  }

  async function toggleReminders(enabled: boolean) {
    const nextSettings = await setRemindersEnabled(enabled)
    setSettings(nextSettings)
    setBannerDismissed(false)
    await refreshBanner()
  }

  async function changeTimes(times: string[]) {
    setSettings(await setReminderTimes(times))
  }

  async function toggleDeckReminder(deckId: string, enabled: boolean) {
    await setDeckReminderEnabled(deckId, enabled)
    await Promise.all([refreshData(), refreshBanner()])
  }

  async function changeDeckDirection(
    deckId: string,
    direction: StudyDirection,
  ) {
    await updateDeck(deckId, { preferredDirection: direction })
    await refreshData()
  }

  async function signIn(email: string, password: string) {
    setAuthBusy(true)
    try {
      await loginCloud(email, password)
    } catch (error) {
      throw new Error(firebaseAuthErrorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function resetPassword(email: string) {
    setAuthBusy(true)
    try {
      await resetCloudPassword(email)
    } catch (error) {
      throw new Error(firebaseAuthErrorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }

  async function signOut() {
    setAuthBusy(true)
    try {
      setStudyDeck(null)
      await logoutCloud()
    } finally {
      setAuthBusy(false)
    }
  }

  async function refreshAfterRestore() {
    await Promise.all([refreshData(), refreshBanner()])
  }

  if (cloudConfigured && !cloudAvailable) {
    const detail =
      !cloudClientResult.available && cloudClientResult.error
        ? cloudClientResult.error
        : 'Firebase Web config không hợp lệ.'
    return (
      <main className="cloud-setup-error" data-testid="cloud-setup-error">
        <span aria-hidden="true">
          <CloudOff />
        </span>
        <p className="eyebrow">CẤU HÌNH CLOUD CẦN ĐƯỢC SỬA</p>
        <h1>Vun Từ chưa thể kết nối Firebase.</h1>
        <p>{detail}</p>
        <small>
          Kiểm tra các biến VITE_FIREBASE_* rồi build/deploy lại. App dừng
          tại đây để tránh bạn vô tình tạo dữ liệu chỉ nằm trên một máy.
        </small>
      </main>
    )
  }

  if (
    cloudAvailable &&
    (!authResolved || cloud.authPhase === 'checking')
  ) {
    return (
      <main className="cloud-session-loading" data-testid="cloud-session-loading">
        <span aria-hidden="true">
          <Cloud />
          <LoaderCircle className="spin" />
        </span>
        <p>Đang mở dữ liệu của bạn…</p>
      </main>
    )
  }

  if (cloudAvailable && cloud.authPhase !== 'signed-in') {
    return (
      <CloudLoginScreen
        busy={authBusy}
        online={browserOnline}
        error={cloud.error}
        onSignIn={signIn}
        onResetPassword={resetPassword}
      />
    )
  }

  if (studyDeck) {
    return (
      <StudyScreen
        deck={studyDeck}
        onExit={() => {
          setStudyDeck(null)
          if (screen === 'import') setScreen('today')
          void Promise.all([refreshData(), refreshBanner()])
        }}
        onSavedReview={() => void refreshData()}
      />
    )
  }

  return (
    <div className="app-shell">
      <a className="sr-only-focusable skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>
      <AppHeader
        currentScreen={screen}
        onNavigate={navigate}
        settings={settings}
        cloud={cloud}
      />

      {banner?.visible && !bannerDismissed && (
        <aside className="reminder-banner" data-testid="reminder-banner">
          <div>
            <Bell />
            <p>
              <strong>Đến nhịp ôn rồi.</strong>
              <span>{banner.message}</span>
            </p>
          </div>
          <div>
            {banner.decks[0] && (
              <button
                className="button button-small"
                type="button"
                onClick={() => startStudy(banner.decks[0].id)}
              >
                <BookOpen />
                Ôn ngay
              </button>
            )}
            <button
              className="icon-button"
              type="button"
              onClick={() => setBannerDismissed(true)}
              aria-label="Ẩn lời nhắc"
            >
              <X />
            </button>
          </div>
        </aside>
      )}

      {appError && (
        <div className="app-error" role="alert">
          {appError}
        </div>
      )}

      <main id="main-content">
        {screen === 'today' && (
          <DashboardScreen
            decks={decks}
            stats={stats}
            onNavigate={navigate}
            onStartStudy={startStudy}
            loading={loading}
          />
        )}
        {screen === 'decks' && (
          <DeckLibraryScreen
            decks={decks}
            onStartStudy={startStudy}
            onImport={() => navigate('import')}
            onChangeDirection={changeDeckDirection}
          />
        )}
        {screen === 'import' && (
          <Suspense
            fallback={
              <div className="page simple-loading">Đang mở trình nhập file…</div>
            }
          >
            <ImportScreen
              decks={decks}
              onSave={saveImport}
              onStudy={startStudy}
              onHome={() => navigate('today')}
            />
          </Suspense>
        )}
        {screen === 'reminders' &&
          (settings ? (
            <SettingsScreen
              settings={settings}
              decks={decks}
              onToggleReminders={toggleReminders}
              onChangeTimes={changeTimes}
              onToggleDeck={toggleDeckReminder}
              cloud={cloud}
              onSyncNow={syncCloudNow}
              onSignOut={signOut}
              onDataRestored={refreshAfterRestore}
            />
          ) : (
            <div className="page simple-loading">Đang mở cài đặt…</div>
          ))}
      </main>

      <footer className="app-footer">
        <span>Vun Từ</span>
        <p>
          Học ít một, nhớ lâu hơn ·{' '}
          {cloud.configured
            ? 'Offline trên máy và tự đồng bộ qua Firebase.'
            : 'Chế độ local: dữ liệu chỉ ở thiết bị này.'}
        </p>
      </footer>
      <MobileNav currentScreen={screen} onNavigate={navigate} />
    </div>
  )
}

export default App
