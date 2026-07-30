import type {
  AppSettings,
  Card,
  Deck,
  StudyLog,
} from '../models'

export interface SyncEntityMap {
  deck: Deck
  card: Card
  studyLog: StudyLog
  settings: AppSettings
}

export type SyncEntityType = keyof SyncEntityMap
export type SyncOperation = 'upsert' | 'delete'
export type RemoteCursorByEntity = Partial<
  Record<SyncEntityType, number>
>

export const SYNC_ENTITY_TYPES = [
  'deck',
  'card',
  'studyLog',
  'settings',
] as const satisfies readonly SyncEntityType[]

export const FIRESTORE_COLLECTION_BY_ENTITY = {
  deck: 'decks',
  card: 'cards',
  studyLog: 'studyLogs',
  settings: 'settings',
} as const satisfies Record<SyncEntityType, string>

export interface LocalEntitySnapshot<
  Type extends SyncEntityType = SyncEntityType,
> {
  entityType: Type
  entityId: string
  payload: SyncEntityMap[Type]
}

export interface PendingMutationSnapshot {
  id: string
  revision: string
  entityType: SyncEntityType
  entityId: string
  operation: SyncOperation
  payload?: SyncEntityMap[SyncEntityType]
  queuedAt: number
  attemptCount?: number
  nextAttemptAt?: number
  lastError?: string
}

export interface RemoteEntity<
  Type extends SyncEntityType = SyncEntityType,
> {
  entityType: Type
  entityId: string
  operation: SyncOperation
  payload?: SyncEntityMap[Type]
  modifiedAt: number
  revision?: string
  remoteCursor?: number
}

export interface ReconciliationPlan {
  applyRemote: RemoteEntity[]
  uploadLocal: LocalEntitySnapshot[]
  protectedRemote: RemoteEntity[]
}

export type AuthPhase =
  | 'disabled'
  | 'checking'
  | 'signed-out'
  | 'signed-in'

export type SyncPhase =
  | 'disabled'
  | 'idle'
  | 'bootstrapping'
  | 'syncing'
  | 'offline'
  | 'error'

export interface CloudUser {
  uid: string
  email: string | null
}

export interface CloudSyncState {
  configured: boolean
  authPhase: AuthPhase
  syncPhase: SyncPhase
  online: boolean
  pendingCount: number
  /** Monotonic signal for React/data consumers after remote cache mutation. */
  changeVersion: number
  lastSyncedAt?: number
  error?: string
  user?: CloudUser
}

export type CloudStateListener = (state: CloudSyncState) => void
export type Unsubscribe = () => void

export interface CloudSyncMeta {
  uid: string
  /** Legacy global cursor; retained only for older IndexedDB records. */
  remoteCursor?: number
  remoteCursorByEntity?: RemoteCursorByEntity
  lastPulledAt?: number
  lastPushedAt?: number
  lastSuccessfulSyncAt?: number
}

export interface LocalSyncAdapter {
  claimOwnership(uid: string): Promise<{
    claimed: boolean
    ownerUid: string
  }>
  listLocal(): Promise<LocalEntitySnapshot[]>
  countPending(): Promise<number>
  listPending(options?: {
    readyAt?: number
    limit?: number
  }): Promise<PendingMutationSnapshot[]>
  /** Returns only changes actually applied after the atomic outbox recheck. */
  applyRemote(changes: readonly RemoteEntity[]): Promise<RemoteEntity[]>
  queueBootstrap(entities: readonly LocalEntitySnapshot[]): Promise<void>
  acknowledgeMany(
    entries: readonly { id: string; revision: string }[],
  ): Promise<void>
  markFailedMany(
    entries: readonly {
      id: string
      revision: string
      error: string
      nextAttemptAt: number
    }[],
  ): Promise<void>
  getMeta(uid: string): Promise<CloudSyncMeta | undefined>
  updateMeta(
    uid: string,
    patch: Partial<Omit<CloudSyncMeta, 'uid'>>,
  ): Promise<void>
  subscribeToPending(listener: () => void): Unsubscribe
}
