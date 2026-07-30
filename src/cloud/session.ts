import type { CloudSyncState } from './types'

export interface SyncSessionTarget {
  start(uid: string, email?: string | null): Promise<void>
  getState(): CloudSyncState
}

export interface AuthSessionTarget {
  currentUid(): string | null
  logout(): Promise<void>
}

/**
 * A Firebase credential is not accepted until the local dataset ownership
 * claim succeeds. Rejected credentials are signed out to avoid an auth/session
 * state that cannot make progress.
 */
export async function startOwnedSyncSession(
  sync: SyncSessionTarget,
  auth: AuthSessionTarget | undefined,
  uid: string,
  email: string | null = null,
): Promise<CloudSyncState> {
  await sync.start(uid, email)
  const state = sync.getState()
  if (
    auth &&
    auth.currentUid() === uid &&
    state.authPhase === 'signed-out' &&
    state.syncPhase === 'error'
  ) {
    try {
      await auth.logout()
    } catch {
      // Keep the ownership error visible even if Firebase sign-out fails.
    }
  }
  return state
}
