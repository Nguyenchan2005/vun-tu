import { describe, expect, it } from 'vitest'

import {
  REVIEW_INTERVALS,
  createInitialReviewState,
  createStudyQueue,
  drawNextCard,
  isDue,
  updateReviewState,
} from './scheduler'

describe('spaced repetition scheduler', () => {
  it('advances remembered cards through 3d/7d/1m/3m/6m intervals', () => {
    const start = new Date('2026-06-15T00:00:00.000Z')
    let state = createInitialReviewState(start)
  
    const expectedDates = [
      '2026-06-18T00:00:00.000Z',
      '2026-06-22T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z',
      '2026-09-15T00:00:00.000Z',
      '2026-12-15T00:00:00.000Z',
    ]
  
    REVIEW_INTERVALS.forEach((_interval, index) => {
      state = updateReviewState(state, 'remember', start)
  
      expect(state.box).toBe(index + 1)
  
      expect(
        new Date(state.nextReviewAt).toISOString(),
      ).toBe(expectedDates[index])
    })
  
    const capped = updateReviewState(state, 'remember', start)
  
    expect(capped.box).toBe(REVIEW_INTERVALS.length)
  
    expect(
      new Date(capped.nextReviewAt).toISOString(),
    ).toBe('2026-12-15T00:00:00.000Z')
  
    expect(capped.correctCount).toBe(6)
  })

  it('resets a forgotten card to the 3-day review stage', () => {
    const now = new Date('2026-07-29T12:30:00.000Z')
  
    const learned = {
      ...createInitialReviewState(now),
      box: 4,
      streak: 4,
      correctCount: 4,
    }
  
    const forgotten = updateReviewState(
      learned,
      'forgot',
      now,
    )
  
    expect(forgotten).toMatchObject({
      box: 1,
      streak: 0,
      correctCount: 4,
      incorrectCount: 1,
      lastReviewedAt: now.getTime(),
    })
  
    expect(
      new Date(forgotten.nextReviewAt).toISOString(),
    ).toBe('2026-08-01T12:30:00.000Z')
  })

it('draws cards from the study queue', () => {
  const queue = createStudyQueue(
    [{ id: 'a' }, { id: 'b' }],
    () => 0.999,
  )

  const first = drawNextCard(queue)

  expect(first.card).not.toBeNull()
  expect(first.queue.upcoming).toHaveLength(1)
})
  it('checks due dates at the exact boundary', () => {
    const state = createInitialReviewState('2026-07-29T10:00:00.000Z')

    expect(isDue(state, '2026-07-29T09:59:59.999Z')).toBe(false)
    expect(isDue(state, '2026-07-29T10:00:00.000Z')).toBe(true)
  })
})
