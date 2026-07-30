import { describe, expect, it, vi } from 'vitest'

import { startOwnedSyncSession } from './session'
import type { CloudSyncState } from './types'

const BASE_STATE: CloudSyncState = {
  configured: true,
  authPhase: 'signed-out',
  syncPhase: 'error',
  online: true,
  pendingCount: 1,
  changeVersion: 0,
  error: 'Local dataset belongs to another account.',
}

describe('owned cloud session', () => {
  it('signs out a Firebase credential rejected by local ownership', async () => {
    const logout = vi.fn(async () => undefined)
    const sync = {
      start: vi.fn(async () => undefined),
      getState: () => BASE_STATE,
    }

    await startOwnedSyncSession(
      sync,
      { currentUid: () => 'uid-other', logout },
      'uid-other',
    )

    expect(logout).toHaveBeenCalledOnce()
  })

  it('does not sign out an accepted session or a newer credential', async () => {
    const logout = vi.fn(async () => undefined)
    const accepted = {
      ...BASE_STATE,
      authPhase: 'signed-in',
      syncPhase: 'idle',
    } satisfies CloudSyncState

    await startOwnedSyncSession(
      {
        start: async () => undefined,
        getState: () => accepted,
      },
      { currentUid: () => 'uid-newer', logout },
      'uid-original',
    )

    expect(logout).not.toHaveBeenCalled()
  })
})
