export const REVIEW_INTERVALS = [
  { unit: 'day', amount: 3 },
  { unit: 'day', amount: 7 },
  { unit: 'month', amount: 1 },
  { unit: 'month', amount: 3 },
  { unit: 'month', amount: 6 },
] as const

export type SchedulerRating =
  | 'forgot'
  | 'remember'
  | 'again'
  | 'hard'
  | 'good'
  | 'easy'

export interface ReviewState {
  /** 0 is new/forgotten; 1..6 map to REVIEW_INTERVAL_DAYS. */
  box: number
  streak: number
  correctCount: number
  incorrectCount: number
  lastReviewedAt?: number
  /** Unix timestamp in milliseconds, matching the persisted Card model. */
  nextReviewAt: number
}

export type CardId = string | number

export interface QueueCard {
  id: CardId
}

export interface StudyQueue<T extends QueueCard> {
  upcoming: T[]
  lastShownId: CardId | null
}

export interface DrawResult<T extends QueueCard> {
  card: T | null
  queue: StudyQueue<T>
}

type RandomSource = () => number

function clampRandom(random: RandomSource): number {
  const value = random()
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(0.9999999999999999, value))
}



function normalizeDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Thời điểm ôn tập không hợp lệ.')
  }

  return date
}
function normalizeDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Thời điểm ôn tập không hợp lệ.')
  }

  return date
}
export function createInitialReviewState(
  now: Date | string | number = new Date(),
): ReviewState {
  const current = normalizeDate(now).getTime()

  return {
    box: 0,
    streak: 0,
    correctCount: 0,
    incorrectCount: 0,
    nextReviewAt: current,
  }
}

export function isForgottenRating(rating: SchedulerRating): boolean {
  return rating === 'forgot' || rating === 'again'
}

function boxAdvanceForRating(rating: SchedulerRating): number {
  if (rating === 'easy') {
    return 2
  }
  if (rating === 'hard') {
    return 0
  }
  return 1
}

export function updateReviewState<T extends ReviewState>(
  state: T,
  rating: SchedulerRating,
  now: Date | string | number = new Date(),
): T {
  const reviewedAt = normalizeDate(now)

  if (isForgottenRating(rating)) {
    return {
      ...state,
      box: 0,
      streak: 0,
      incorrectCount: state.incorrectCount + 1,
      lastReviewedAt: reviewedAt.getTime(),
      nextReviewAt: addTime(
        reviewedAt,
        FORGOT_RETRY_MINUTES * 60 * 1000,
      ).getTime(),
    } as T
  }

  const nextBox = Math.min(
    REVIEW_INTERVAL_DAYS.length,
    Math.max(1, state.box + boxAdvanceForRating(rating)),
  )
  const intervalDays = REVIEW_INTERVAL_DAYS[nextBox - 1] ?? 1

  return {
    ...state,
    box: nextBox,
    streak: state.streak + 1,
    correctCount: state.correctCount + 1,
    lastReviewedAt: reviewedAt.getTime(),
    nextReviewAt: addTime(
      reviewedAt,
      intervalDays * 24 * 60 * 60 * 1000,
    ).getTime(),
  } as T
}

export function isDue(
  state: Pick<ReviewState, 'nextReviewAt'>,
  now: Date | string | number = new Date(),
): boolean {
  return (
    Number.isFinite(state.nextReviewAt) &&
    state.nextReviewAt <= normalizeDate(now).getTime()
  )
}

export function shuffleCards<T>(
  cards: readonly T[],
  random: RandomSource = Math.random,
): T[] {
  const shuffled = [...cards]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(clampRandom(random) * (index + 1))
    const temporary = shuffled[index]
    shuffled[index] = shuffled[target] as T
    shuffled[target] = temporary as T
  }

  return shuffled
}

export function createStudyQueue<T extends QueueCard>(
  cards: readonly T[],
  random: RandomSource = Math.random,
): StudyQueue<T> {
  return {
    upcoming: shuffleCards(cards, random),
    lastShownId: null,
  }
}

function findNextIndex<T extends QueueCard>(queue: StudyQueue<T>): number {
  if (queue.upcoming.length === 0) {
    return -1
  }

  if (
    queue.lastShownId == null ||
    queue.upcoming[0]?.id !== queue.lastShownId
  ) {
    return 0
  }

  const differentCardIndex = queue.upcoming.findIndex(
    (card) => card.id !== queue.lastShownId,
  )
  return differentCardIndex < 0 ? 0 : differentCardIndex
}

export function drawNextCard<T extends QueueCard>(
  queue: StudyQueue<T>,
): DrawResult<T> {
  const index = findNextIndex(queue)

  if (index < 0) {
    return { card: null, queue }
  }

  const upcoming = [...queue.upcoming]
  const [card] = upcoming.splice(index, 1)

  if (!card) {
    return { card: null, queue }
  }

  return {
    card,
    queue: {
      upcoming,
      lastShownId: card.id,
    },
  }
}

/**
 * Adds a missed card back after one intervening card whenever possible.
 * Repeated misses therefore cause repeated appearances without an immediate
 * duplicate of the card that was just shown.
 */
export function reinsertForgotten<T extends QueueCard>(
  queue: StudyQueue<T>,
  card: T,
): StudyQueue<T> {
  const upcoming = [...queue.upcoming]
  const hasInterveningCard = upcoming.some(
    (candidate) => candidate.id !== card.id,
  )
  const insertionIndex = hasInterveningCard
    ? Math.min(1, upcoming.length)
    : upcoming.length

  upcoming.splice(insertionIndex, 0, card)
  return { ...queue, upcoming }
}

export function applyRatingToQueue<T extends QueueCard>(
  queue: StudyQueue<T>,
  card: T,
  rating: SchedulerRating,
): StudyQueue<T> {
  return isForgottenRating(rating)
    ? reinsertForgotten(queue, card)
    : queue
}
