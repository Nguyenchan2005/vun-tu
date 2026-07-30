import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth'

import {
  enableFirebaseAuthPersistence,
  getFirebaseClient,
} from './client'
import { CloudUnavailableError } from './errors'
import type { CloudUser, Unsubscribe } from './types'

export interface EmailPasswordAuth {
  login(email: string, password: string): Promise<CloudUser>
  logout(): Promise<void>
  resetPassword(email: string): Promise<void>
  subscribe(listener: (user: CloudUser | null) => void): Unsubscribe
}

export class FirebaseEmailPasswordAuth implements EmailPasswordAuth {
  private readonly auth: Auth

  constructor(auth: Auth) {
    this.auth = auth
  }

  async login(email: string, password: string): Promise<CloudUser> {
    await enableFirebaseAuthPersistence(this.auth)
    const credential = await signInWithEmailAndPassword(
      this.auth,
      normalizeEmail(email),
      password,
    )
    return {
      uid: credential.user.uid,
      email: credential.user.email,
    }
  }

  async logout(): Promise<void> {
    await signOut(this.auth)
  }

  async resetPassword(email: string): Promise<void> {
    await sendPasswordResetEmail(this.auth, normalizeEmail(email))
  }

  subscribe(listener: (user: CloudUser | null) => void): Unsubscribe {
    return onAuthStateChanged(this.auth, (user) => {
      listener(user ? { uid: user.uid, email: user.email } : null)
    })
  }
}

export function getEmailPasswordAuth(): EmailPasswordAuth {
  const result = getFirebaseClient()
  if (!result.available) {
    const detail =
      result.missingKeys.length > 0
        ? ` Missing: ${result.missingKeys.join(', ')}.`
        : result.error
          ? ` ${result.error}`
          : ''
    throw new CloudUnavailableError(
      `Firebase is not configured.${detail}`,
    )
  }
  return new FirebaseEmailPasswordAuth(result.client.auth)
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase('en')
  if (!normalized) {
    throw new Error('Email is required.')
  }
  return normalized
}
