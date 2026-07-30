import {
  ArrowRight,
  Bell,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileText,
  Layers3,
  Plus,
} from 'lucide-react'

import { formatVietnameseDate } from '../lib/format'
import type { StudyStats } from '../db'
import type { DeckSummary } from '../models'
import type { AppScreen } from '../navigation'

export interface DashboardScreenProps {
  decks: DeckSummary[]
  stats: StudyStats
  onNavigate: (screen: AppScreen) => void
  onStartStudy: (deckId: string) => void
  loading?: boolean
}

function getAccuracyLabel(stats: StudyStats): string {
  if (stats.reviewCount === 0) return 'Chưa có dữ liệu'
  return `${Math.round(stats.accuracy * 100)}%`
}

function getLastReviewedLabel(lastReviewedAt?: number): string {
  if (lastReviewedAt === undefined) return 'Chưa bắt đầu ôn'

  return `Ôn gần nhất ${new Intl.DateTimeFormat('vi-VN', {
    day: 'numeric',
    month: 'long',
  }).format(lastReviewedAt)}`
}

export function DashboardScreen({
  decks,
  stats,
  onNavigate,
  onStartStudy,
  loading = false,
}: DashboardScreenProps) {
  const totalCards = decks.reduce(
    (total, deck) => total + deck.cardCount,
    0,
  )
  const totalDue = decks.reduce(
    (total, deck) => total + deck.dueCount,
    0,
  )
  const totalNew = decks.reduce(
    (total, deck) => total + deck.newCount,
    0,
  )
  const firstDueDeck = decks.find((deck) => deck.dueCount > 0)

  if (loading) {
    return <DashboardLoading />
  }

  const hasDecks = decks.length > 0
  const heroTitle =
    totalDue > 0
      ? `${totalDue} từ đang chờ được nhớ lại.`
      : hasDecks
        ? 'Hôm nay bạn đã ôn đủ rồi.'
        : 'Bàn học đang chờ bộ từ đầu tiên.'

  const heroDescription =
    totalDue > 0
      ? 'Mỗi lượt ôn ngắn đều giúp trí nhớ bền hơn.'
      : hasDecks
        ? 'Một ngày nhẹ nhàng — hẹn bạn ở nhịp ôn tiếp theo.'
        : 'Nhập danh sách đầu tiên, Vun Từ sẽ giúp bạn sắp thành từng thẻ.'

  return (
    <section
      className="page dashboard-page"
      data-testid="dashboard-screen"
      aria-labelledby="dashboard-title"
    >
      <div className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <p className="eyebrow">NHỊP HỌC HÔM NAY</p>
          <p className="dashboard-date">{formatVietnameseDate()}</p>
          <h1 id="dashboard-title">{heroTitle}</h1>
          <p className="dashboard-hero__description">{heroDescription}</p>

          <div className="dashboard-hero__actions">
            {firstDueDeck ? (
              <button
                className="button button-primary"
                type="button"
                onClick={() => onStartStudy(firstDueDeck.id)}
                aria-label={`Bắt đầu ôn bộ ${firstDueDeck.name}`}
                data-testid="dashboard-primary-study"
              >
                <BookOpen aria-hidden="true" />
                Bắt đầu ôn
                <ArrowRight aria-hidden="true" />
              </button>
            ) : hasDecks ? (
              <button
                className="button button-primary"
                type="button"
                onClick={() => onNavigate('decks')}
                data-testid="dashboard-view-decks"
              >
                <Layers3 aria-hidden="true" />
                Xem các bộ từ
              </button>
            ) : (
              <button
                className="button button-primary"
                type="button"
                onClick={() => onNavigate('import')}
                data-testid="dashboard-first-import"
              >
                <Plus aria-hidden="true" />
                Nhập bộ từ đầu tiên
              </button>
            )}

            {hasDecks && (
              <button
                className="button button-secondary"
                type="button"
                onClick={() => onNavigate('import')}
                data-testid="dashboard-import"
              >
                <Plus aria-hidden="true" />
                Nhập bộ từ
              </button>
            )}
          </div>
        </div>

        <aside
          className="today-note paper-note"
          aria-labelledby="today-note-title"
        >
          <div className="today-note__heading">
            <Clock3 aria-hidden="true" />
            <div>
              <p className="eyebrow">GHI CHÚ HÔM NAY</p>
              <h2 id="today-note-title">Một nhịp vừa đủ</h2>
            </div>
          </div>

          <dl className="today-note__stats">
            <div>
              <dt>Tổng số thẻ</dt>
              <dd>{totalCards}</dd>
            </div>
            <div>
              <dt>Thẻ mới</dt>
              <dd>{totalNew}</dd>
            </div>
            <div>
              <dt>Tỉ lệ nhớ</dt>
              <dd>{getAccuracyLabel(stats)}</dd>
            </div>
          </dl>

          <div className="today-note__seedling" aria-hidden="true">
            <i />
            <span />
            <span />
          </div>

          <p className="today-note__last-review">
            <CheckCircle2 aria-hidden="true" />
            {getLastReviewedLabel(stats.lastReviewedAt)}
          </p>
        </aside>
      </div>

      <section
        className="dashboard-decks"
        aria-labelledby="dashboard-decks-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">THƯ VIỆN NHỎ</p>
            <h2 id="dashboard-decks-title">Bộ từ của bạn</h2>
          </div>
          {hasDecks && (
            <button
              className="text-link"
              type="button"
              onClick={() => onNavigate('decks')}
              data-testid="dashboard-all-decks"
            >
              Xem tất cả
              <ArrowRight aria-hidden="true" />
            </button>
          )}
        </div>

        {hasDecks ? (
          <div className="dashboard-deck-grid" data-testid="dashboard-decks">
            {decks.map((deck, index) => (
              <DashboardDeckCard
                deck={deck}
                index={index}
                key={deck.id}
                onStartStudy={onStartStudy}
              />
            ))}
          </div>
        ) : (
          <div
            className="dashboard-empty paper-panel"
            data-testid="dashboard-empty"
          >
            <div className="dashboard-empty__visual" aria-hidden="true">
              <div className="empty-card-stack">
                <span />
                <span />
                <span>
                  <i />
                </span>
              </div>
              <div className="empty-sprout">
                <i />
                <span />
                <span />
              </div>
            </div>
            <div className="dashboard-empty__copy">
              <p className="eyebrow">BẮT ĐẦU TỪ MỘT TỆP</p>
              <h3>Bàn học còn trống.</h3>
              <p>
                Tải danh sách đầu tiên lên — Word, Excel hay văn bản đều
                được. Vun Từ sẽ giữ nguyên nguồn tệp và xếp thành từng thẻ.
              </p>
              <button
                className="button button-primary"
                type="button"
                onClick={() => onNavigate('import')}
              >
                <Plus aria-hidden="true" />
                Nhập bộ từ đầu tiên
              </button>
            </div>
          </div>
        )}
      </section>
    </section>
  )
}

function DashboardDeckCard({
  deck,
  index,
  onStartStudy,
}: {
  deck: DeckSummary
  index: number
  onStartStudy: (deckId: string) => void
}) {
  const introducedCount = Math.max(0, deck.cardCount - deck.newCount)
  const titleId = `dashboard-deck-title-${deck.id}`

  return (
    <article
      className={`dashboard-deck-card paper-panel accent-${
        (index % 4) + 1
      }`}
      aria-labelledby={titleId}
      data-testid={`dashboard-deck-${deck.id}`}
    >
      <div className="dashboard-deck-card__top">
        <span className="deck-number" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
        {deck.reminderEnabled && (
          <span className="deck-reminder">
            <Bell aria-hidden="true" />
            <span className="sr-only">Đang bật nhắc học</span>
          </span>
        )}
      </div>

      <div className="dashboard-deck-card__title">
        <Layers3 aria-hidden="true" />
        <h3 id={titleId}>{deck.name}</h3>
      </div>

      <p
        className="dashboard-deck-card__description deck-source-line"
        title={deck.sourceName}
      >
        <FileText aria-hidden="true" />
        <span>Nguồn file</span>
        <strong>{deck.sourceName ?? 'Nguồn nhập thủ công'}</strong>
      </p>

      <div className="dashboard-deck-card__meta">
        <span>{deck.cardCount} thẻ</span>
        <span aria-hidden="true">·</span>
        <strong>
          {deck.dueCount > 0
            ? `${deck.dueCount} đến hạn`
            : 'Chưa có thẻ cần ôn'}
        </strong>
      </div>

      {deck.cardCount > 0 && (
        <div className="deck-progress">
          <progress
            max={deck.cardCount}
            value={introducedCount}
            aria-label={`${introducedCount} trên ${deck.cardCount} thẻ đã bắt đầu học`}
          />
          {deck.newCount > 0 && (
            <span>{deck.newCount} thẻ mới</span>
          )}
        </div>
      )}

      <button
        className="deck-study-link"
        type="button"
        onClick={() => onStartStudy(deck.id)}
        disabled={deck.cardCount === 0}
        data-testid={`dashboard-study-${deck.id}`}
      >
        <BookOpen aria-hidden="true" />
        {deck.cardCount === 0
          ? 'Bộ từ đang trống'
          : deck.dueCount > 0
            ? `Ôn ${deck.dueCount} thẻ`
            : 'Học bộ từ này'}
        <ArrowRight aria-hidden="true" />
      </button>
    </article>
  )
}

function DashboardLoading() {
  return (
    <section
      className="page dashboard-page dashboard-loading"
      data-testid="dashboard-loading"
      aria-busy="true"
      aria-label="Đang mở bàn học"
    >
      <div className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <p className="eyebrow">NHỊP HỌC HÔM NAY</p>
          <div className="skeleton skeleton-heading" aria-hidden="true" />
          <div className="skeleton skeleton-line" aria-hidden="true" />
          <div className="skeleton skeleton-button" aria-hidden="true" />
        </div>
        <div
          className="today-note paper-note skeleton-panel"
          aria-hidden="true"
        />
      </div>
      <div className="dashboard-decks">
        <div className="skeleton skeleton-section-title" aria-hidden="true" />
        <div className="dashboard-deck-grid" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div
              className="dashboard-deck-card paper-panel skeleton-card"
              key={item}
            />
          ))}
        </div>
      </div>
      <p className="sr-only" role="status">
        Đang tải các bộ từ…
      </p>
    </section>
  )
}
