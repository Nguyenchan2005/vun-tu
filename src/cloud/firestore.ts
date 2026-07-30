import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import {
  FIRESTORE_COLLECTION_BY_ENTITY,
  SYNC_ENTITY_TYPES,
  type PendingMutationSnapshot,
  type RemoteCursorByEntity,
  type RemoteEntity,
  type SyncEntityMap,
  type SyncEntityType,
  type Unsubscribe,
} from './types'
import { NonRetryableCloudError } from './errors'

const FIRESTORE_SYNC_FIELD = '_sync'
const FIRESTORE_SCHEMA_VERSION = 1
export const FIRESTORE_MAX_BATCH_DOCUMENTS = 400
export const FIRESTORE_MAX_DOCUMENT_BYTES = 900 * 1_024
export const FIRESTORE_MAX_BATCH_BYTES = 8 * 1_024 * 1_024
const FIRESTORE_ESTIMATED_WRITE_OVERHEAD_BYTES = 1_024

interface FirestoreSyncMetadata {
  deleted: boolean
  modifiedAt: number
  revision?: string
  schemaVersion: number
  serverModifiedAt?: unknown
}

export interface RemoteStore {
  pullAll(afterCursor?: RemoteCursorByEntity): Promise<{
    entities: RemoteEntity[]
    cursorByEntity: RemoteCursorByEntity
  }>
  push(entries: readonly PendingMutationSnapshot[]): Promise<void>
  listen(
    onChanges: (changes: RemoteEntity[]) => void,
    onError: (error: unknown) => void,
    afterCursor?: RemoteCursorByEntity,
  ): Unsubscribe
}

export interface PreparedFirestoreWrite {
  entry: PendingMutationSnapshot
  data: DocumentData
  encodedBytes: number
  estimatedCommitBytes: number
}

export class FirestoreDocumentTooLargeError extends NonRetryableCloudError {
  override name = 'FirestoreDocumentTooLargeError'
  readonly entityType: SyncEntityType
  readonly entityId: string
  readonly encodedBytes: number

  constructor(
    entry: PendingMutationSnapshot,
    encodedBytes: number,
  ) {
    const encodedKiB = Math.ceil(encodedBytes / 1_024)
    super(
      `Không thể đồng bộ "${entry.entityType}:${entry.entityId}" vì dữ liệu mã hóa khoảng ${encodedKiB} KiB, vượt giới hạn an toàn 900 KiB. Hãy rút gọn hoặc xóa mục này rồi thử đồng bộ thủ công.`,
      { affectedMutationIds: [entry.id] },
    )
    this.entityType = entry.entityType
    this.entityId = entry.entityId
    this.encodedBytes = encodedBytes
  }
}

export class FirebaseRemoteStore implements RemoteStore {
  private readonly firestore: Firestore
  private readonly uid: string

  constructor(
    firestore: Firestore,
    uid: string,
  ) {
    if (!uid || uid.includes('/')) {
      throw new Error('A valid Firebase uid is required.')
    }
    this.firestore = firestore
    this.uid = uid
  }

  async pullAll(afterCursor?: RemoteCursorByEntity): Promise<{
    entities: RemoteEntity[]
    cursorByEntity: RemoteCursorByEntity
  }> {
    const snapshots = await Promise.all(
      SYNC_ENTITY_TYPES.map(async (entityType) => {
        const snapshot = await getDocs(
          this.query(entityType, afterCursor?.[entityType]),
        )
        return snapshot.docs.map((document) =>
          decodeRemoteDocument(entityType, document),
        )
      }),
    )
    const entities = snapshots.flat()
    return {
      entities,
      cursorByEntity: mergeRemoteCursors(afterCursor, entities),
    }
  }

  async push(entries: readonly PendingMutationSnapshot[]): Promise<void> {
    const chunks = prepareFirestoreWriteBatches(entries)
    for (const chunk of chunks) {
      const batch = writeBatch(this.firestore)

      for (const write of chunk) {
        const reference = doc(
          this.collection(write.entry.entityType),
          write.entry.entityId,
        )
        batch.set(reference, write.data)
      }

      await batch.commit()
    }
  }

  listen(
    onChanges: (changes: RemoteEntity[]) => void,
    onError: (error: unknown) => void,
    afterCursor?: RemoteCursorByEntity,
  ): Unsubscribe {
    const unsubscribe = SYNC_ENTITY_TYPES.map((entityType) =>
      onSnapshot(
        this.query(entityType, afterCursor?.[entityType]),
        (snapshot) => {
          const changes = snapshot.docChanges().flatMap((change) =>
            change.type === 'removed'
              ? []
              : [decodeRemoteDocument(entityType, change.doc)],
          )
          onChanges(changes)
        },
        onError,
      ),
    )

    return () => {
      for (const stop of unsubscribe) {
        stop()
      }
    }
  }

  private collection(entityType: SyncEntityType) {
    return collection(
      this.firestore,
      'users',
      this.uid,
      FIRESTORE_COLLECTION_BY_ENTITY[entityType],
    )
  }

  private query(entityType: SyncEntityType, afterCursor?: number) {
    const reference = this.collection(entityType)
    return afterCursor && afterCursor > 0
      ? query(
          reference,
          where(
            `${FIRESTORE_SYNC_FIELD}.serverModifiedAt`,
            '>',
            Timestamp.fromMillis(afterCursor),
          ),
          orderBy(`${FIRESTORE_SYNC_FIELD}.serverModifiedAt`),
        )
      : reference
  }
}

/**
 * Encodes and validates every write before the first commit. This prevents a
 * later oversized document from leaving earlier batches committed but unacked.
 */
export function prepareFirestoreWriteBatches(
  entries: readonly PendingMutationSnapshot[],
): PreparedFirestoreWrite[][] {
  const prepared = entries.map(prepareFirestoreWrite)
  const batches: PreparedFirestoreWrite[][] = []
  let current: PreparedFirestoreWrite[] = []
  let currentBytes = 0

  for (const write of prepared) {
    if (
      current.length > 0 &&
      (current.length >= FIRESTORE_MAX_BATCH_DOCUMENTS ||
        currentBytes + write.estimatedCommitBytes >
          FIRESTORE_MAX_BATCH_BYTES)
    ) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(write)
    currentBytes += write.estimatedCommitBytes
  }

  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

export function estimateFirestoreDocumentUtf8Bytes(
  data: DocumentData,
): number {
  const encoded = JSON.stringify(data)
  if (encoded === undefined) {
    return 0
  }
  return new TextEncoder().encode(encoded).byteLength
}

export function encodeRemoteDocument(
  entry: PendingMutationSnapshot,
): DocumentData {
  const metadata: FirestoreSyncMetadata = {
    deleted: entry.operation === 'delete',
    modifiedAt: entry.queuedAt,
    revision: entry.revision,
    schemaVersion: FIRESTORE_SCHEMA_VERSION,
    serverModifiedAt: serverTimestamp(),
  }

  if (entry.operation === 'delete') {
    return {
      id: entry.entityId,
      [FIRESTORE_SYNC_FIELD]: metadata,
    }
  }

  if (!entry.payload) {
    throw new Error(`Sync upsert ${entry.id} is missing its payload.`)
  }

  return {
    ...(sanitizeFirestoreValue(entry.payload) as Record<string, unknown>),
    id: entry.entityId,
    [FIRESTORE_SYNC_FIELD]: metadata,
  }
}

export function decodeRemoteData(
  entityType: SyncEntityType,
  entityId: string,
  data: DocumentData,
): RemoteEntity {
  const metadata = readSyncMetadata(data[FIRESTORE_SYNC_FIELD])
  const remoteCursor = timestampToMillis(metadata.serverModifiedAt)
  if (metadata.deleted) {
    return {
      entityType,
      entityId,
      operation: 'delete',
      modifiedAt: metadata.modifiedAt,
      revision: metadata.revision,
      remoteCursor,
    }
  }

  const payload = { ...data }
  delete payload[FIRESTORE_SYNC_FIELD]
  payload.id = entityId
  return {
    entityType,
    entityId,
    operation: 'upsert',
    payload: payload as SyncEntityMap[typeof entityType],
    modifiedAt:
      metadata.modifiedAt ||
      legacyModifiedAt(payload as Record<string, unknown>),
    revision: metadata.revision,
    remoteCursor,
  }
}

function prepareFirestoreWrite(
  entry: PendingMutationSnapshot,
): PreparedFirestoreWrite {
  assertDocumentId(entry.entityId)
  const data = encodeRemoteDocument(entry)
  const encodedBytes = estimateFirestoreDocumentUtf8Bytes(data)
  if (encodedBytes > FIRESTORE_MAX_DOCUMENT_BYTES) {
    throw new FirestoreDocumentTooLargeError(entry, encodedBytes)
  }
  return {
    entry,
    data,
    encodedBytes,
    estimatedCommitBytes:
      encodedBytes +
      utf8ByteLength(entry.entityId) +
      FIRESTORE_ESTIMATED_WRITE_OVERHEAD_BYTES,
  }
}

function decodeRemoteDocument(
  entityType: SyncEntityType,
  document: QueryDocumentSnapshot<DocumentData>,
): RemoteEntity {
  return decodeRemoteData(entityType, document.id, document.data())
}

function readSyncMetadata(value: unknown): FirestoreSyncMetadata {
  if (!isRecord(value)) {
    return {
      deleted: false,
      modifiedAt: 0,
      schemaVersion: 0,
    }
  }
  return {
    deleted: value.deleted === true,
    modifiedAt:
      typeof value.modifiedAt === 'number' ? value.modifiedAt : 0,
    revision:
      typeof value.revision === 'string' ? value.revision : undefined,
    schemaVersion:
      typeof value.schemaVersion === 'number' ? value.schemaVersion : 0,
    serverModifiedAt: value.serverModifiedAt,
  }
}

function legacyModifiedAt(payload: Record<string, unknown>): number {
  for (const field of ['updatedAt', 'reviewedAt', 'createdAt']) {
    const value = payload[field]
    if (typeof value === 'number') {
      return value
    }
  }
  return 0
}

function sanitizeFirestoreValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeFirestoreValue)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, sanitizeFirestoreValue(child)]),
    )
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertDocumentId(entityId: string): void {
  if (!entityId || entityId.includes('/')) {
    throw new Error(`Invalid sync entity id: ${entityId}`)
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function timestampToMillis(value: unknown): number | undefined {
  if (value instanceof Timestamp) {
    return value.toMillis()
  }
  if (
    isRecord(value) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    return value.seconds * 1_000 + Math.floor(value.nanoseconds / 1_000_000)
  }
  return undefined
}

function mergeRemoteCursors(
  current: RemoteCursorByEntity = {},
  entries: readonly RemoteEntity[],
): RemoteCursorByEntity {
  const merged = { ...current }
  for (const entry of entries) {
    if (entry.remoteCursor !== undefined) {
      merged[entry.entityType] = Math.max(
        merged[entry.entityType] ?? 0,
        entry.remoteCursor,
      )
    }
  }
  return merged
}
