import { describe, expect, it } from 'vitest'

import { readFirebaseConfig } from './config'

describe('Firebase client configuration', () => {
  it('is disabled gracefully when required Vite variables are absent', () => {
    const result = readFirebaseConfig({})

    expect(result.configured).toBe(false)
    expect(result.config).toBeUndefined()
    expect(result.missingKeys).toEqual([
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_APP_ID',
    ])
  })

  it('trims required and optional Firebase config values', () => {
    const result = readFirebaseConfig({
      VITE_FIREBASE_API_KEY: ' api-key ',
      VITE_FIREBASE_AUTH_DOMAIN: ' example.firebaseapp.com ',
      VITE_FIREBASE_PROJECT_ID: ' project-id ',
      VITE_FIREBASE_APP_ID: ' app-id ',
      VITE_FIREBASE_STORAGE_BUCKET: ' bucket ',
      VITE_FIREBASE_MESSAGING_SENDER_ID: ' sender ',
    })

    expect(result).toEqual({
      configured: true,
      missingKeys: [],
      config: {
        apiKey: 'api-key',
        authDomain: 'example.firebaseapp.com',
        projectId: 'project-id',
        appId: 'app-id',
        storageBucket: 'bucket',
        messagingSenderId: 'sender',
      },
    })
  })
})
