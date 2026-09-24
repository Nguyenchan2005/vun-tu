import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  RotateCcw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'

import {
  listDueCards,
  persistReview,
} from '../db'
import {
  createStudyQueue,
  drawNextCard,
  updateReviewState,
  type SchedulerRating,
  type StudyQueue,
} from '../lib/scheduler'
import type {
  Card,
  Deck,
  ReviewRating,
  StudyDirection,
} from '../models'

interface StudyScreenProps {
  deck: Deck
  onExit: () => void
  onSavedReview: () => void
}

type CardDirection = Exclude<StudyDirection, 'random'>

function pickDirection(direction: StudyDirection): CardDirection {
  if (direction === 'random') {
    return Math.random() < 0.5 ? 'en-vi' : 'vi-en'
  }
  return direction
}

export function StudyScreen({
  deck,
  onExit,
  onSavedReview,
}: StudyScreenProps) {
  const [direction, setDirection] = useState(deck.preferredDirection)
  const [cardDirection, setCardDirection] = useState<CardDirection>(
    pickDirection(deck.preferredDirection),
  )
  const [queue, setQueue] = useState<StudyQueue<Card>>({
    upcoming: [],
    lastShownId: null,
  })
  const [initialCards, setInitialCards] = useState<Card[]>([])
  const [currentCard, setCurrentCard] = useState<Card | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [complete, setComplete] = useState(false)
  const [confirmExit, setConfirmExit] = useState(false)
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set())
  const [rememberedCount, setRememberedCount] = useState(0)
  const [forgottenCount, setForgottenCount] = useState(0)
  const [answerCount, setAnswerCount] = useState(0)

  const frontContent =
    cardDirection === 'en-vi' ? currentCard?.front : currentCard?.back
  const backContent =
    cardDirection === 'en-vi' ? currentCard?.back : currentCard?.front
  const faceLabel =
    cardDirection === 'en-vi' ? 'MẶT TIẾNG ANH' : 'MẶT TIẾNG VIỆT'
  const backLabel =
    cardDirection === 'en-vi' ? 'NGHĨA TIẾNG VIỆT' : 'TỪ TIẾNG ANH'
  const progress = initialCards.length
    ? Math.round((reviewedIds.size / initialCards.length) * 100)
    : 0



  useEffect(() => {
    let active = true
    async function loadSession() {
      setLoading(true)
      setError('')
      try {
        const cards = await listDueCards(Date.now(), deck.id)
        if (!active) return
        setInitialCards(cards)
        startRound(cards)
      } catch {
        if (active) {
          setError('Không thể mở bộ thẻ trên thiết bị này.')
          setLoading(false)
        }
      }
    }
    void loadSession()
    return () => {
      active = false
    }
    // The deck id uniquely identifies the session being loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id])

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'SELECT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return
      }
      if (
        (event.key === ' ' || event.key === 'Enter') &&
        currentCard &&
        !complete
      ) {
        event.preventDefault()
        setFlipped((value) => !value)
      }
      if (flipped && !busy && event.key === '1') {
        void rateCard('again')
      }
      if (flipped && !busy && event.key === '2') {
        void rateCard('good')
      }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  })

  function showNext(nextQueue: StudyQueue<Card>) {
    const drawn = drawNextCard(nextQueue)
    setQueue(drawn.queue)
    setCurrentCard(drawn.card)
    setFlipped(false)
    setCardDirection(pickDirection(direction))
    if (!drawn.card) setComplete(true)
  }

  function startRound(cards: Card[]) {
    setComplete(false)
    setReviewedIds(new Set())
    setRememberedCount(0)
    setForgottenCount(0)
    setAnswerCount(0)
    const firstQueue = createStudyQueue(cards)
    const drawn = drawNextCard(firstQueue)
    setQueue(drawn.queue)
    setCurrentCard(drawn.card)
    setFlipped(false)
    setCardDirection(pickDirection(direction))
    setLoading(false)
    if (!drawn.card) setComplete(true)
  }

  async function rateCard(rating: 'again' | 'good') {
    if (!currentCard || busy || !flipped) return
    setBusy(true)
    setError('')
    const reviewedAt = Date.now()
    const schedulerRating: SchedulerRating = rating
    const nextState = updateReviewState(
      currentCard,
      schedulerRating,
      reviewedAt,
    )
    try {
      await persistReview({
        cardId: currentCard.id,
        sessionId: `session-${deck.id}`,
        rating: rating as ReviewRating,
        wasCorrect: rating === 'good',
        boxAfter: nextState.box,
        nextReviewAt: nextState.nextReviewAt,
        reviewedAt,
      })
      onSavedReview()
      setAnswerCount((count) => count + 1)
      setReviewedIds((ids) => new Set(ids).add(currentCard.id))
      if (rating === 'again') {
        setForgottenCount((count) => count + 1)
      } else {
        setRememberedCount((count) => count + 1)
      }

      const updatedCard: Card = {
        ...currentCard,
        box: nextState.box,
        streak: nextState.streak,
        correctCount: nextState.correctCount,
        incorrectCount: nextState.incorrectCount,
        lastReviewedAt: nextState.lastReviewedAt,
        nextReviewAt: nextState.nextReviewAt,
      }
      showNext(queue)
    } catch {
      setError('Chưa lưu được lượt học. Hãy thử lại.')
    } finally {
      setBusy(false)
    }
  }

  function requestExit() {
    if (answerCount > 0 && !complete) setConfirmExit(true)
    else onExit()
  }

  if (loading) {
    return (
      <main className="study-shell study-loading">
        <div className="study-loader">
          <span />
          <p>Đang xếp lại những thẻ cần nhớ…</p>
        </div>
      </main>
    )
  }

  return (
    <main className="study-shell" data-testid="study-screen">
      <header className="study-header">
        <button className="study-exit" type="button" onClick={requestExit}>
          <ArrowLeft />
          <span>Rời phiên</span>
        </button>
        <div className="study-deck-name">
          <span>BỘ TỪ</span>
          <strong>{deck.name}</strong>
        </div>
        <label className="session-direction">
          <Settings2 />
          <span className="sr-only">Hướng học trong phiên</span>
          <select
            value={direction}
            onChange={(event) => {
              const nextDirection = event.target.value as StudyDirection
              setDirection(nextDirection)
              setCardDirection(pickDirection(nextDirection))
              setFlipped(false)
            }}
          >
            <option value="en-vi">Anh → Việt</option>
            <option value="vi-en">Việt → Anh</option>
            <option value="random">Ngẫu nhiên</option>
          </select>
        </label>
      </header>

      <div className="study-progress-track">
        <span style={{ width: `${progress}%` }} />
      </div>

      {!complete && currentCard ? (
        <section className="study-stage">
          <div className="study-meta">
            <span>
              Đã xem {reviewedIds.size}/{initialCards.length} thẻ
            </span>
            {queue.upcoming.length > 0 && (
              <span>{queue.upcoming.length} lượt đang chờ</span>
            )}
          </div>

          <button
            className={`flashcard ${flipped ? 'is-flipped' : ''}`}
            type="button"
            onClick={() => setFlipped((value) => !value)}
            aria-label={flipped ? 'Lật về mặt trước' : 'Lật sang mặt sau'}
            aria-pressed={flipped}
            data-testid="flashcard"
          >
            <span className="flashcard-inner">
              <span className="flashcard-face flashcard-front">
                <small>{faceLabel}</small>
                <strong>{frontContent}</strong>
                <span className="flip-hint">
                  <RotateCcw />
                  Chạm hoặc nhấn Space để lật
                </span>
                <i aria-hidden="true">{currentCard.partOfSpeech}</i>
              </span>
              <span className="flashcard-face flashcard-back">
                <small>{backLabel}</small>
                <strong>{backContent}</strong>
                {currentCard.example && (
                  <q className="card-example">{currentCard.example}</q>
                )}
                <span className="flip-hint">
                  <RotateCcw />
                  Chạm để xem lại mặt trước
                </span>
              </span>
            </span>
          </button>

          <div className={`rating-area ${flipped ? 'is-visible' : ''}`}>
            {error && <p className="study-error">{error}</p>}
            <p>Bạn nhớ từ này đến đâu?</p>
            <div className="rating-buttons">
              <button
                className="rating-button rating-again"
                type="button"
                disabled={!flipped || busy}
                onClick={() => void rateCard('again')}
              >
                <span className="shortcut">1</span>
                <span>
                  <strong>Chưa nhớ</strong>
                  <small>Ôn lại sau 3 ngày</small>
                </span>
              </button>
              <button
                className="rating-button rating-good"
                type="button"
                disabled={!flipped || busy}
                onClick={() => void rateCard('good')}
              >
                <span className="shortcut">2</span>
                <span>
                  <strong>Đã nhớ</strong>
                  <small>Giãn lịch ôn</small>
                </span>
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="study-complete" data-testid="study-complete">
          <div className="complete-illustration" aria-hidden="true">
            <span />
            <Sparkles />
            <Check />
          </div>
          <p className="eyebrow">PHIÊN HỌC HOÀN THÀNH</p>
          <h1>Một vòng ôn đã khép lại.</h1>
          {initialCards.length > 0 ? (
            <p>
              {reviewedIds.size} thẻ đã xem · {rememberedCount} lượt đã nhớ ·{' '}
              {forgottenCount} lượt cần gặp lại
            </p>
          ) : (
            <p>Bộ từ này chưa có thẻ. Hãy nhập thêm từ để bắt đầu.</p>
          )}
          <div className="complete-stats">
            <div>
              <strong>{answerCount}</strong>
              <span>Lượt trả lời</span>
            </div>
            <div>
              <strong>
                {answerCount
                  ? Math.round((rememberedCount / answerCount) * 100)
                  : 0}
                %
              </strong>
              <span>Tỷ lệ nhớ</span>
            </div>
          </div>
          <div className="complete-actions">
            <button className="button button-primary" type="button" onClick={onExit}>
              Về trang chủ
            </button>
          </div>
        </section>
      )}

      {confirmExit && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="leave-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-title"
          >
            <button
              className="dialog-close"
              type="button"
              onClick={() => setConfirmExit(false)}
              aria-label="Đóng"
            >
              <X />
            </button>
            <h2 id="leave-title">Rời phiên học?</h2>
            <p>
              Những lượt vừa học đã được lưu. Bạn có thể quay lại bất kỳ lúc
              nào.
            </p>
            <div>
              <button
                className="button button-primary"
                type="button"
                onClick={() => setConfirmExit(false)}
              >
                Tiếp tục học
              </button>
              <button className="button button-ghost" type="button" onClick={onExit}>
                Rời phiên
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
