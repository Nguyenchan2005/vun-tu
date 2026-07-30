import type {
  LocalEntitySnapshot,
  PendingMutationSnapshot,
  ReconciliationPlan,
  RemoteEntity,
  SyncEntityType,
} from './types'

export function syncEntityKey(
  entityType: SyncEntityType,
  entityId: string,
): string {
  return `${entityType}:${entityId}`
}

/**
 * Plans a bootstrap/realtime merge. A queued local mutation always wins,
 * irrespective of timestamps. Without one, the remote document is
 * authoritative, including tombstones.
 */
export function planReconciliation(
  local: readonly LocalEntitySnapshot[],
  remote: readonly RemoteEntity[],
  pending: readonly PendingMutationSnapshot[],
): ReconciliationPlan {
  const protectedKeys = new Set(
    pending.map((entry) => syncEntityKey(entry.entityType, entry.entityId)),
  )
  const remoteKeys = new Set(
    remote.map((entry) => syncEntityKey(entry.entityType, entry.entityId)),
  )
  const applyRemote: RemoteEntity[] = []
  const protectedRemote: RemoteEntity[] = []

  for (const entry of remote) {
    if (protectedKeys.has(syncEntityKey(entry.entityType, entry.entityId))) {
      protectedRemote.push(entry)
    } else {
      applyRemote.push(entry)
    }
  }

  const uploadLocal = local.filter((entry) => {
    const key = syncEntityKey(entry.entityType, entry.entityId)
    return !remoteKeys.has(key) && !protectedKeys.has(key)
  })

  return { applyRemote, uploadLocal, protectedRemote }
}

export function filterUnprotectedRemote(
  remote: readonly RemoteEntity[],
  pending: readonly PendingMutationSnapshot[],
): RemoteEntity[] {
  const protectedKeys = new Set(
    pending.map((entry) => syncEntityKey(entry.entityType, entry.entityId)),
  )
  return remote.filter(
    (entry) =>
      !protectedKeys.has(syncEntityKey(entry.entityType, entry.entityId)),
  )
}
