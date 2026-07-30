export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
  storageBucket?: string
  messagingSenderId?: string
}

export interface FirebaseConfigResult {
  configured: boolean
  config?: FirebaseWebConfig
  missingKeys: string[]
}

type Environment = Record<string, string | boolean | undefined>

const REQUIRED_FIREBASE_ENVIRONMENT_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const

function readString(environment: Environment, key: string): string | undefined {
  const value = environment[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readFirebaseConfig(
  environment: Environment = import.meta.env,
): FirebaseConfigResult {
  const missingKeys = REQUIRED_FIREBASE_ENVIRONMENT_KEYS.filter(
    (key) => !readString(environment, key),
  )

  if (missingKeys.length > 0) {
    return { configured: false, missingKeys }
  }

  return {
    configured: true,
    missingKeys: [],
    config: {
      apiKey: readString(environment, 'VITE_FIREBASE_API_KEY')!,
      authDomain: readString(environment, 'VITE_FIREBASE_AUTH_DOMAIN')!,
      projectId: readString(environment, 'VITE_FIREBASE_PROJECT_ID')!,
      appId: readString(environment, 'VITE_FIREBASE_APP_ID')!,
      storageBucket: readString(environment, 'VITE_FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: readString(
        environment,
        'VITE_FIREBASE_MESSAGING_SENDER_ID',
      ),
    },
  }
}
