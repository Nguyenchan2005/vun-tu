import { describe, expect, it } from 'vitest'

import {
  FORGOT_RETRY_MINUTES,
  REVIEW_INTERVAL_DAYS,
  applyRatingToQueue,
  createInitialReviewState,
  createStudyQueue,
  drawNextCard,
  isDue,
  updateReviewState,
} from './scheduler'

describe('spaced repetition scheduler', () => {
  it('advances remembered cards through 1/3/7/14/30/60 day intervals', () => {
    const start = new Date('2026-07-29T00:00:00.000Z')
    let state = createInitialReviewState(start)

    REVIEW_INTERVAL_DAYS.forEach((days, index) => {
      state = updateReviewState(state, 'remember', start)
      expect(state.box).toBe(index + 1)
      expect(state.nextReviewAt).toBe(
        start.getTime() + days * 24 * 60 * 60 * 1000,
      )
    })

    const capped = updateReviewState(state, 'remember', start)
    expect(capped.box).toBe(REVIEW_INTERVAL_DAYS.length)
    expect(capped.nextReviewAt).toBe(
      start.getTime() + 60 * 24 * 60 * 60 * 1000,
    )
    expect(capped.correctCount).toBe(7)
  })

  it('resets a forgotten card and schedules a short retry', () => {
    const now = new Date('2026-07-29T12:30:00.000Z')
    const learned = {
      ...createInitialReviewState(now),
      box: 4,
      streak: 4,
      correctCount: 4,
    }
    const forgotten = updateReviewState(learned, 'forgot', now)

    expect(forgotten).toMatchObject({
      box: 0,
      streak: 0,
      correctCount: 4,
      incorrectCount: 1,
      lastReviewedAt: now.getTime(),
    })
    expect(forgotten.nextReviewAt).toBe(
      now.getTime() + FORGOT_RETRY_MINUTES * 60 * 1000,
    )
  })

  it('does not show the same card twice when another card is available', () => {
    const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    let queue = createStudyQueue(cards, () => 0.999)
    const first = drawNextCard(queue)
    expect(first.card).not.toBeNull()
    queue = first.queue

    queue = applyRatingToQueue(queue, first.card!, 'forgot')
    const second = drawNextCard(queue)
    expect(second.card?.id).not.toBe(first.card?.id)

    const third = drawNextCard(second.queue)
    expect(third.card?.id).toBe(first.card?.id)
  })

  it('does not reinsert remembered cards', () => {
    const card = { id: 1 }
    const queue = createStudyQueue([card], () => 0)
    const drawn = drawNextCard(queue)
    const afterRating = applyRatingToQueue(
      drawn.queue,
      drawn.card!,
      'remember',
    )

    expect(afterRating.upcoming).toEqual([])
  })

  it('checks due dates at the exact boundary', () => {
    const state = createInitialReviewState('2026-07-29T10:00:00.000Z')

    expect(isDue(state, '2026-07-29T09:59:59.999Z')).toBe(false)
    expect(isDue(state, '2026-07-29T10:00:00.000Z')).toBe(true)
  })
})
