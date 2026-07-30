import {
  getApp,
  getApps,
  initializeApp,
  type FirebaseApp,
} from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

import {
  readFirebaseConfig,
  type FirebaseConfigResult,
} from './config'
import { cloudErrorMessage } from './errors'

const FIREBASE_APP_NAME = 'vocab-anki-cloud'

export interface FirebaseClient {
  app: FirebaseApp
  auth: Auth
  firestore: Firestore
}

export type FirebaseClientResult =
  | {
      available: true
      configured: true
      client: FirebaseClient
    }
  | {
      available: false
      configured: boolean
      missingKeys: string[]
      error?: string
    }

let defaultClientResult: FirebaseClientResult | undefined

export function createFirebaseClient(
  configResult: FirebaseConfigResult = readFirebaseConfig(),
): FirebaseClientResult {
  if (!configResult.configured || !configResult.config) {
    return {
      available: false,
      configured: false,
      missingKeys: configResult.missingKeys,
    }
  }

  try {
    const existingApp = getApps().some((app) => app.name === FIREBASE_APP_NAME)
      ? getApp(FIREBASE_APP_NAME)
      : initializeApp(configResult.config, FIREBASE_APP_NAME)
    return {
      available: true,
      configured: true,
      client: {
        app: existingApp,
        auth: getAuth(existingApp),
        firestore: getFirestore(existingApp),
      },
    }
  } catch (error) {
    return {
      available: false,
      configured: true,
      missingKeys: [],
      error: cloudErrorMessage(error),
    }
  }
}

export function getFirebaseClient(): FirebaseClientResult {
  defaultClientResult ??= createFirebaseClient()
  return defaultClientResult
}

/**
 * Browser persistence is best-effort. Authentication still works with the
 * SDK's in-memory fallback in restricted/private browsing environments.
 */
export async function enableFirebaseAuthPersistence(
  auth: Auth,
): Promise<void> {
  try {
    await setPersistence(auth, browserLocalPersistence)
  } catch {
    // A blocked storage backend must not make local-only usage fail.
  }
}
