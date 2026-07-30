import { FirebaseEmailPasswordAuth } from './auth'
import {
  getFirebaseClient,
  type FirebaseClientResult,
} from './client'
import { DexieLocalSyncAdapter } from './dexie-adapter'
import { CloudSyncEngine } from './engine'
import { CloudUnavailableError } from './errors'
import { FirebaseRemoteStore } from './firestore'
import { startOwnedSyncSession } from './session'
import type {
  CloudStateListener,
  CloudSyncState,
  CloudUser,
  Unsubscribe,
} from './types'

export { firebaseAuthErrorMessage } from './auth-errors'
export { CloudUnavailableError } from './errors'
export type {
  AuthPhase,
  CloudSyncState,
  CloudUser,
  SyncPhase,
} from './types'

export const cloudClientResult: FirebaseClientResult = getFirebaseClient()
export const cloudConfigured = cloudClientResult.configured
export const cloudAvailable = cloudClientResult.available

const localAdapter = new DexieLocalSyncAdapter()

export const cloudSyncEngine = new CloudSyncEngine(
  localAdapter,
  (uid) => {
    if (!cloudClientResult.available) {
      throw unavailableError()
    }
    return new FirebaseRemoteStore(
      cloudClientResult.client.firestore,
      uid,
    )
  },
  { configured: cloudClientResult.available },
)

const authService = cloudClientResult.available
  ? new FirebaseEmailPasswordAuth(cloudClientResult.client.auth)
  : undefined

export function subscribeCloudAuth(
  listener: (user: CloudUser | null) => void,
): Unsubscribe {
  if (!authService) {
    listener(null)
    return () => undefined
  }
  return authService.subscribe(listener)
}

/**
 * Call once at application startup. Auth changes automatically start/stop the
 * sync session; calling this function never creates a user account.
 */
export function startCloudSync(): Unsubscribe {
  return subscribeCloudAuth((user) => {
    if (user) {
      void startCloudSyncForUser(user.uid, user.email)
    } else {
      signOutCloudSync()
    }
  })
}

export async function startCloudSyncForUser(
  uid: string,
  email: string | null = null,
): Promise<void> {
  await startOwnedSyncSession(
    cloudSyncEngine,
    authService && cloudClientResult.available
      ? {
          currentUid: () =>
            cloudClientResult.client.auth.currentUser?.uid ?? null,
          logout: () => authService.logout(),
        }
      : undefined,
    uid,
    email,
  )
}

export function signOutCloudSync(): void {
  const state = cloudSyncEngine.getState()
  if (
    state.authPhase === 'signed-out' &&
    state.syncPhase === 'error'
  ) {
    return
  }
  cloudSyncEngine.signOut()
}

export async function loginCloud(
  email: string,
  password: string,
): Promise<CloudUser> {
  return requireAuth().login(email, password)
}

export async function logoutCloud(): Promise<void> {
  try {
    await requireAuth().logout()
  } finally {
    cloudSyncEngine.signOut()
  }
}

export async function resetCloudPassword(email: string): Promise<void> {
  await requireAuth().resetPassword(email)
}

export function flushCloudSync(): Promise<void> {
  return cloudSyncEngine.flush()
}

export function retryCloudSyncNow(): Promise<void> {
  return cloudSyncEngine.retryNow()
}

/** Manual catch-up pull, listener restart, and forced outbox retry. */
export function syncCloudNow(): Promise<void> {
  return cloudSyncEngine.retryNow()
}

export function subscribeCloudSync(
  listener: CloudStateListener,
): Unsubscribe {
  return cloudSyncEngine.subscribe(listener)
}

export function getCloudSyncState(): CloudSyncState {
  return cloudSyncEngine.getState()
}

function requireAuth(): FirebaseEmailPasswordAuth {
  if (!authService) {
    throw unavailableError()
  }
  return authService
}

function unavailableError(): CloudUnavailableError {
  const detail =
    !cloudClientResult.available &&
    cloudClientResult.missingKeys.length > 0
      ? ` Missing: ${cloudClientResult.missingKeys.join(', ')}.`
      : !cloudClientResult.available && cloudClientResult.error
        ? ` ${cloudClientResult.error}`
        : ''
  return new CloudUnavailableError(
    `Firebase cloud sync is unavailable.${detail}`,
  )
}
