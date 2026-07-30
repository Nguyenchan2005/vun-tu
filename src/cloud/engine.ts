import {
  cloudErrorMessage,
  isNonRetryableCloudError,
} from './errors'
import type { RemoteStore } from './firestore'
import { planReconciliation, syncEntityKey } from './merge'
import {
  BrowserNetworkMonitor,
  type NetworkMonitor,
} from './network'
import type {
  CloudStateListener,
  CloudSyncState,
  LocalSyncAdapter,
  RemoteCursorByEntity,
  RemoteEntity,
  Unsubscribe,
} from './types'

const DEFAULT_OUTBOX_BATCH_SIZE = 100
const MAX_RETRY_DELAY = 5 * 60 * 1_000
export const NON_RETRYABLE_NEXT_ATTEMPT_AT = Number.MAX_SAFE_INTEGER

export type RemoteStoreFactory = (uid: string) => RemoteStore

export class CloudSyncEngine {
  private readonly local: LocalSyncAdapter
  private readonly remoteFactory: RemoteStoreFactory
  private readonly network: NetworkMonitor
  private readonly now: () => number
  private readonly listeners = new Set<CloudStateListener>()
  private state: CloudSyncState
  private uid?: string
  private remote?: RemoteStore
  private stopRemote?: Unsubscribe
  private stopOutbox?: Unsubscribe
  private stopNetwork?: Unsubscribe
  private bootstrapPromise?: Promise<void>
  private flushPromise?: Promise<void>
  private realtimeQueue: Promise<void> = Promise.resolve()
  private readonly deferredRemote = new Map<string, RemoteEntity>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAt?: number
  private bootstrapAttemptCount = 0
  private listenerAttemptCount = 0
  private retryNeedsCatchUp = false
  private bootstrapped = false
  private initialBootstrapComplete = false
  private remoteCursorByEntity: RemoteCursorByEntity = {}
  private generation = 0

  constructor(
    local: LocalSyncAdapter,
    remoteFactory: RemoteStoreFactory,
    options: {
      network?: NetworkMonitor
      now?: () => number
      configured?: boolean
    } = {},
  ) {
    this.local = local
    this.remoteFactory = remoteFactory
    this.network = options.network ?? new BrowserNetworkMonitor()
    this.now = options.now ?? Date.now
    const configured = options.configured ?? true
    this.state = {
      configured,
      authPhase: configured ? 'signed-out' : 'disabled',
      syncPhase: configured ? 'idle' : 'disabled',
      online: this.network.isOnline(),
      pendingCount: 0,
      changeVersion: 0,
    }
  }

  getState(): CloudSyncState {
    return { ...this.state }
  }

  subscribe(listener: CloudStateListener): Unsubscribe {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  async start(uid: string, email: string | null = null): Promise<void> {
    if (!this.state.configured) {
      return
    }
    if (!uid || uid.includes('/')) {
      throw new Error('A valid Firebase uid is required.')
    }

    this.stopSession()
    const generation = this.generation
    this.uid = uid
    this.patchState({
      authPhase: 'checking',
      syncPhase: this.network.isOnline() ? 'idle' : 'offline',
      online: this.network.isOnline(),
      error: undefined,
      user: undefined,
    })

    try {
      const ownership = await this.local.claimOwnership(uid)
      if (generation !== this.generation) {
        return
      }
      if (!ownership.claimed) {
        this.patchState({
          authPhase: 'signed-out',
          syncPhase: 'error',
          error:
            'Dữ liệu cục bộ đang thuộc một tài khoản khác. Hãy đăng nhập lại tài khoản đó hoặc xóa dữ liệu cục bộ trước khi đổi tài khoản.',
          user: undefined,
        })
        return
      }
      this.remote = this.remoteFactory(uid)
      this.patchState({
        authPhase: 'signed-in',
        user: { uid, email },
      })
    } catch (error) {
      if (generation === this.generation) {
        this.patchState({
          authPhase: 'signed-out',
          syncPhase: 'error',
          error: cloudErrorMessage(error),
          user: undefined,
        })
      }
      return
    }

    let meta
    try {
      meta = await this.local.getMeta(uid)
    } catch (error) {
      if (generation === this.generation) {
        this.patchState({
          syncPhase: 'error',
          error: cloudErrorMessage(error),
        })
      }
      return
    }
    if (generation !== this.generation) {
      return
    }
    this.remoteCursorByEntity = meta?.remoteCursorByEntity ?? {}
    this.initialBootstrapComplete = meta?.lastPulledAt !== undefined
    this.patchState({ lastSyncedAt: meta?.lastSuccessfulSyncAt })
    this.stopOutbox = this.local.subscribeToPending(() => {
      void this.onOutboxChanged(generation)
    })
    this.stopNetwork = this.network.subscribe((online) => {
      void this.onNetworkChanged(online, generation)
    })
    await this.refreshPendingCount(generation)

    if (this.network.isOnline()) {
      await this.bootstrap(generation)
    }
  }

  signOut(): void {
    this.stopSession()
    this.patchState({
      authPhase: this.state.configured ? 'signed-out' : 'disabled',
      syncPhase: this.state.configured ? 'idle' : 'disabled',
      pendingCount: 0,
      lastSyncedAt: undefined,
      error: undefined,
      user: undefined,
    })
  }

  stop(): void {
    this.stopSession()
    this.listeners.clear()
  }

  async flush(options: { force?: boolean } = {}): Promise<void> {
    const generation = this.generation
    if (
      !this.uid ||
      !this.remote ||
      !this.bootstrapped ||
      !this.network.isOnline()
    ) {
      return
    }
    if (this.flushPromise) {
      await this.flushPromise
      if (options.force) {
        return this.flush({ force: true })
      }
      return
    }

    this.flushPromise = this.flushOutbox(
      generation,
      options.force ?? false,
    ).finally(() => {
      this.flushPromise = undefined
    })
    return this.flushPromise
  }

  async retryNow(): Promise<void> {
    this.clearRetryTimer()
    if (
      this.uid &&
      this.remote &&
      !this.bootstrapped &&
      this.network.isOnline()
    ) {
      return this.bootstrap(this.generation)
    }
    if (
      this.uid &&
      this.remote &&
      this.bootstrapped &&
      this.network.isOnline()
    ) {
      return this.recoverRealtime(this.generation, {
        forceFlush: true,
      })
    }
    return this.flush({ force: true })
  }

  private async bootstrap(generation: number): Promise<void> {
    if (!this.uid || !this.remote || generation !== this.generation) {
      return
    }
    if (this.bootstrapPromise) {
      return this.bootstrapPromise
    }

    this.bootstrapPromise = this.runBootstrap(generation).finally(() => {
      this.bootstrapPromise = undefined
    })
    return this.bootstrapPromise
  }

  private async runBootstrap(generation: number): Promise<void> {
    const uid = this.uid
    const remoteStore = this.remote
    if (!uid || !remoteStore) {
      return
    }

    this.patchState({ syncPhase: 'bootstrapping', error: undefined })
    try {
      const isInitialBootstrap = !this.initialBootstrapComplete
      const [local, remotePull, pending] = await Promise.all([
        this.local.listLocal(),
        remoteStore.pullAll(this.remoteCursorByEntity),
        this.local.listPending(),
      ])
      if (generation !== this.generation) {
        return
      }

      const plan = planReconciliation(
        isInitialBootstrap ? local : [],
        remotePull.entities,
        pending,
      )
      this.bufferProtectedRemote(plan.protectedRemote)
      const appliedRemote = await this.local.applyRemote(plan.applyRemote)
      const appliedKeys = new Set(
        appliedRemote.map((entry) =>
          syncEntityKey(entry.entityType, entry.entityId),
        ),
      )
      this.bufferProtectedRemote(
        plan.applyRemote.filter(
          (entry) =>
            !appliedKeys.has(
              syncEntityKey(entry.entityType, entry.entityId),
            ),
        ),
      )
      if (appliedRemote.length > 0) {
        this.patchState({
          changeVersion: this.state.changeVersion + 1,
        })
      }
      await this.local.queueBootstrap(plan.uploadLocal)
      this.remoteCursorByEntity = mergeRemoteCursors(
        appliedRemote,
        this.remoteCursorByEntity,
      )
      this.initialBootstrapComplete = true
      this.bootstrapAttemptCount = 0
      this.clearRetryTimer()
      const syncedAt = this.now()
      await this.local.updateMeta(uid, {
        remoteCursorByEntity: this.remoteCursorByEntity,
        lastPulledAt: syncedAt,
        lastSuccessfulSyncAt: syncedAt,
      })
      this.bootstrapped = true
      this.patchState({
        syncPhase: 'idle',
        lastSyncedAt: syncedAt,
        error: undefined,
      })
      this.startRealtime(generation)
      await this.refreshPendingCount(generation)
      await this.flush()
    } catch (error) {
      if (generation !== this.generation) {
        return
      }
      this.patchState({
        syncPhase: this.network.isOnline() ? 'error' : 'offline',
        error: cloudErrorMessage(error),
      })
      if (this.network.isOnline()) {
        const retryAt =
          this.now() + retryDelay(this.bootstrapAttemptCount)
        this.bootstrapAttemptCount += 1
        this.scheduleRetry(retryAt, generation)
      }
    }
  }

  private startRealtime(generation: number): void {
    if (!this.remote || this.stopRemote) {
      return
    }
    this.stopRemote = this.remote.listen(
      (changes) => {
        this.listenerAttemptCount = 0
        if (changes.length === 0) {
          return
        }
        this.realtimeQueue = this.realtimeQueue.then(() =>
          this.applyRealtime(changes, generation),
        ).catch((error) => {
          this.handleRealtimeApplyFailure(error, generation)
        })
      },
      (error) => {
        if (generation === this.generation) {
          const stop = this.stopRemote
          this.stopRemote = undefined
          stop?.()
          this.patchState({
            syncPhase: 'error',
            error: cloudErrorMessage(error),
          })
          const retryAt =
            this.now() + retryDelay(this.listenerAttemptCount)
          this.listenerAttemptCount += 1
          this.scheduleRetry(retryAt, generation, true)
        }
      },
      this.remoteCursorByEntity,
    )
  }

  private handleRealtimeApplyFailure(
    error: unknown,
    generation: number,
  ): void {
    if (generation !== this.generation) {
      return
    }
    const stop = this.stopRemote
    this.stopRemote = undefined
    stop?.()
    this.patchState({
      syncPhase: 'error',
      error: cloudErrorMessage(error),
    })
    const retryAt =
      this.now() + retryDelay(this.listenerAttemptCount)
    this.listenerAttemptCount += 1
    this.scheduleRetry(retryAt, generation, true)
  }

  private async applyRealtime(
    changes: readonly RemoteEntity[],
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      return
    }
    try {
      const pending = await this.local.listPending()
      const plan = planReconciliation([], changes, pending)
      this.bufferProtectedRemote(plan.protectedRemote)
      const appliedRemote = await this.local.applyRemote(plan.applyRemote)
      const appliedKeys = new Set(
        appliedRemote.map((entry) =>
          syncEntityKey(entry.entityType, entry.entityId),
        ),
      )
      this.bufferProtectedRemote(
        plan.applyRemote.filter(
          (entry) =>
            !appliedKeys.has(
              syncEntityKey(entry.entityType, entry.entityId),
            ),
        ),
      )
      for (const entry of appliedRemote) {
        this.deferredRemote.delete(
          syncEntityKey(entry.entityType, entry.entityId),
        )
      }
      if (appliedRemote.length === 0) {
        return
      }
      if (generation !== this.generation) {
        return
      }
      const syncedAt = this.now()
      const nextCursorByEntity = mergeRemoteCursors(
        appliedRemote,
        this.remoteCursorByEntity,
      )
      if (this.uid) {
        await this.local.updateMeta(this.uid, {
          remoteCursorByEntity: nextCursorByEntity,
          lastPulledAt: syncedAt,
          lastSuccessfulSyncAt: syncedAt,
        })
      }
      this.remoteCursorByEntity = nextCursorByEntity
      this.patchState({
        syncPhase:
          this.state.syncPhase === 'syncing' ? 'syncing' : 'idle',
        lastSyncedAt: syncedAt,
        error: undefined,
        changeVersion: this.state.changeVersion + 1,
      })
    } catch (error) {
      if (generation === this.generation) {
        this.patchState({
          syncPhase: 'error',
          error: cloudErrorMessage(error),
        })
      }
      throw error
    }
  }

  private async flushOutbox(
    generation: number,
    force: boolean,
  ): Promise<void> {
    const uid = this.uid
    const remoteStore = this.remote
    if (!uid || !remoteStore) {
      return
    }

    while (generation === this.generation) {
      const entries = await this.local.listPending({
        readyAt: force ? undefined : this.now(),
        limit: DEFAULT_OUTBOX_BATCH_SIZE,
      })
      if (generation !== this.generation) {
        return
      }
      if (entries.length === 0) {
        await this.reconcileDeferred(generation)
        await this.refreshPendingCount(generation)
        await this.scheduleNextOutboxRetry(generation)
        return
      }

      this.patchState({ syncPhase: 'syncing', error: undefined })
      try {
        await remoteStore.push(entries)
        if (!this.retryNeedsCatchUp) {
          this.clearRetryTimer()
        }
        const needsAuthoritativePull = this.discardDeferred(entries)
        await this.local.acknowledgeMany(
          entries.map((entry) => ({
            id: entry.id,
            revision: entry.revision,
          })),
        )
        if (generation !== this.generation) {
          return
        }
        const syncedAt = this.now()
        await this.local.updateMeta(uid, {
          lastPushedAt: syncedAt,
          lastSuccessfulSyncAt: syncedAt,
        })
        this.patchState({
          syncPhase: 'idle',
          lastSyncedAt: syncedAt,
          error: undefined,
        })
        await this.refreshPendingCount(generation)
        if (needsAuthoritativePull) {
          await this.recoverRealtime(generation, {
            flushAfter: false,
          })
        }
      } catch (error) {
        const message = cloudErrorMessage(error)
        const nonRetryable = isNonRetryableCloudError(error)
        const affectedMutationIds =
          nonRetryable && error.affectedMutationIds
            ? new Set(error.affectedMutationIds)
            : undefined
        const failedEntries = affectedMutationIds
          ? entries.filter((entry) => affectedMutationIds.has(entry.id))
          : entries
        let earliestRetryAt = Number.POSITIVE_INFINITY
        const failures = []
        for (const entry of failedEntries) {
          const nextAttemptAt = nonRetryable
            ? NON_RETRYABLE_NEXT_ATTEMPT_AT
            : this.now() + retryDelay(entry.attemptCount ?? 0)
          earliestRetryAt = Math.min(earliestRetryAt, nextAttemptAt)
          failures.push({
            id: entry.id,
            revision: entry.revision,
            error: message,
            nextAttemptAt,
          })
        }
        await this.local.markFailedMany(failures)
        if (generation === this.generation) {
          await this.refreshPendingCount(generation)
          this.patchState({
            syncPhase: this.network.isOnline() ? 'error' : 'offline',
            error: message,
          })
          if (this.network.isOnline() && !nonRetryable) {
            this.scheduleRetry(earliestRetryAt, generation)
          }
        }
        return
      }
    }
  }

  private async onOutboxChanged(generation: number): Promise<void> {
    await this.refreshPendingCount(generation)
    if (!this.flushPromise) {
      const reconciled = await this.reconcileDeferred(generation)
      if (!reconciled) {
        return
      }
    }
    await this.scheduleNextOutboxRetry(generation)
    if (
      generation === this.generation &&
      this.bootstrapped &&
      this.network.isOnline()
    ) {
      await this.flush()
    }
  }

  private async onNetworkChanged(
    online: boolean,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      return
    }
    this.patchState({
      online,
      syncPhase: online
        ? this.state.syncPhase === 'offline'
          ? 'idle'
          : this.state.syncPhase
        : 'offline',
      error: online ? undefined : this.state.error,
    })
    if (!online) {
      this.clearRetryTimer()
      return
    }
    if (!this.bootstrapped) {
      await this.bootstrap(generation)
    } else if (!this.stopRemote) {
      await this.recoverRealtime(generation)
    } else {
      await this.flush()
    }
  }

  private async recoverRealtime(
    generation: number,
    options: {
      flushAfter?: boolean
      forceFlush?: boolean
    } = {},
  ): Promise<void> {
    const uid = this.uid
    const remoteStore = this.remote
    if (
      !uid ||
      !remoteStore ||
      generation !== this.generation ||
      !this.network.isOnline()
    ) {
      return
    }

    const stop = this.stopRemote
    this.stopRemote = undefined
    stop?.()
    await this.realtimeQueue
    if (generation !== this.generation) {
      return
    }

    this.patchState({ syncPhase: 'syncing', error: undefined })
    try {
      const pull = await remoteStore.pullAll(
        this.remoteCursorByEntity,
      )
      await this.applyRealtime(pull.entities, generation)
      if (generation !== this.generation) {
        return
      }
      this.listenerAttemptCount = 0
      const syncedAt = this.now()
      await this.local.updateMeta(uid, {
        remoteCursorByEntity: this.remoteCursorByEntity,
        lastPulledAt: syncedAt,
        lastSuccessfulSyncAt: syncedAt,
      })
      this.patchState({
        syncPhase: 'idle',
        lastSyncedAt: syncedAt,
        error: undefined,
      })
      this.startRealtime(generation)
      if (options.flushAfter ?? true) {
        await this.flush({ force: options.forceFlush ?? false })
      }
    } catch (error) {
      if (generation !== this.generation) {
        return
      }
      const message = cloudErrorMessage(error)
      this.patchState({ syncPhase: 'error', error: message })
      const retryAt =
        this.now() + retryDelay(this.listenerAttemptCount)
      this.listenerAttemptCount += 1
      this.scheduleRetry(retryAt, generation, true)
    }
  }

  private async refreshPendingCount(generation: number): Promise<void> {
    const pending = await this.local.countPending()
    if (generation === this.generation) {
      this.patchState({ pendingCount: pending })
    }
  }

  private async reconcileDeferred(generation: number): Promise<boolean> {
    if (
      generation !== this.generation ||
      this.deferredRemote.size === 0
    ) {
      return true
    }
    const changes = [...this.deferredRemote.values()]
    let succeeded = true
    this.realtimeQueue = this.realtimeQueue.then(() =>
      this.applyRealtime(changes, generation),
    ).catch((error) => {
      succeeded = false
      this.handleRealtimeApplyFailure(error, generation)
    })
    await this.realtimeQueue
    return succeeded
  }

  private async scheduleNextOutboxRetry(
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      !this.bootstrapped ||
      !this.network.isOnline()
    ) {
      return
    }
    const pending = await this.local.listPending()
    const blocked = pending.find(
      (entry) =>
        entry.nextAttemptAt === NON_RETRYABLE_NEXT_ATTEMPT_AT &&
        entry.lastError,
    )
    if (blocked?.lastError) {
      this.patchState({
        syncPhase: 'error',
        error: blocked.lastError,
      })
    }
    const now = this.now()
    const nextAttemptAt = pending
      .map((entry) => entry.nextAttemptAt)
      .filter(
        (timestamp): timestamp is number =>
          timestamp !== undefined &&
          timestamp > now &&
          timestamp < NON_RETRYABLE_NEXT_ATTEMPT_AT,
      )
      .sort((left, right) => left - right)[0]
    if (nextAttemptAt !== undefined) {
      this.scheduleRetry(nextAttemptAt, generation)
    }
  }

  private scheduleRetry(
    retryAt: number,
    generation: number,
    catchUp = false,
  ): void {
    const needsCatchUp = this.retryNeedsCatchUp || catchUp
    if (
      generation !== this.generation ||
      !this.network.isOnline()
    ) {
      return
    }
    if (this.retryAt !== undefined && this.retryAt <= retryAt) {
      this.retryNeedsCatchUp = needsCatchUp
      return
    }
    this.clearRetryTimer()
    this.retryNeedsCatchUp = needsCatchUp
    this.retryAt = retryAt
    this.retryTimer = setTimeout(() => {
      const needsCatchUp = this.retryNeedsCatchUp
      this.retryTimer = undefined
      this.retryAt = undefined
      this.retryNeedsCatchUp = false
      if (
        generation !== this.generation ||
        !this.network.isOnline()
      ) {
        return
      }
      if (this.bootstrapped) {
        if (needsCatchUp || !this.stopRemote) {
          void this.recoverRealtime(generation)
        } else {
          void this.flush()
        }
      } else {
        void this.bootstrap(generation)
      }
    }, Math.max(0, retryAt - this.now()))
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
    }
    this.retryTimer = undefined
    this.retryAt = undefined
    this.retryNeedsCatchUp = false
  }

  private bufferProtectedRemote(entries: readonly RemoteEntity[]): void {
    for (const entry of entries) {
      const key = syncEntityKey(entry.entityType, entry.entityId)
      const current = this.deferredRemote.get(key)
      if (!current || compareRemoteOrder(entry, current) >= 0) {
        this.deferredRemote.set(key, entry)
      }
    }
  }

  private discardDeferred(
    entries: readonly {
      entityType: RemoteEntity['entityType']
      entityId: string
      revision: string
    }[],
  ): boolean {
    let needsAuthoritativePull = false
    for (const entry of entries) {
      const key = syncEntityKey(entry.entityType, entry.entityId)
      const deferred = this.deferredRemote.get(key)
      if (!deferred) {
        continue
      }
      if (deferred.revision === entry.revision) {
        this.deferredRemote.delete(key)
      } else {
        needsAuthoritativePull = true
      }
    }
    return needsAuthoritativePull
  }

  private stopSession(): void {
    this.generation += 1
    this.stopRemote?.()
    this.stopOutbox?.()
    this.stopNetwork?.()
    this.stopRemote = undefined
    this.stopOutbox = undefined
    this.stopNetwork = undefined
    this.bootstrapPromise = undefined
    this.flushPromise = undefined
    this.realtimeQueue = Promise.resolve()
    this.deferredRemote.clear()
    this.clearRetryTimer()
    this.bootstrapAttemptCount = 0
    this.listenerAttemptCount = 0
    this.bootstrapped = false
    this.initialBootstrapComplete = false
    this.remoteCursorByEntity = {}
    this.remote = undefined
    this.uid = undefined
  }

  private patchState(patch: Partial<CloudSyncState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.getState())
    }
  }
}

export function retryDelay(attemptCount: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attemptCount))
  return Math.min(MAX_RETRY_DELAY, 1_000 * 2 ** normalizedAttempt)
}

function mergeRemoteCursors(
  entries: readonly RemoteEntity[],
  current: RemoteCursorByEntity,
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

function compareRemoteOrder(
  left: RemoteEntity,
  right: RemoteEntity,
): number {
  const leftHasServerCursor = left.remoteCursor !== undefined ? 1 : 0
  const rightHasServerCursor = right.remoteCursor !== undefined ? 1 : 0
  if (leftHasServerCursor !== rightHasServerCursor) {
    return leftHasServerCursor - rightHasServerCursor
  }
  return (
    (left.remoteCursor ?? left.modifiedAt) -
    (right.remoteCursor ?? right.modifiedAt)
  )
}
