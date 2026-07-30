import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { Deck } from '../models'
import {
  CloudSyncEngine,
  NON_RETRYABLE_NEXT_ATTEMPT_AT,
  retryDelay,
} from './engine'
import { NonRetryableCloudError } from './errors'
import type { RemoteStore } from './firestore'
import type {
  CloudSyncMeta,
  LocalEntitySnapshot,
  LocalSyncAdapter,
  PendingMutationSnapshot,
  RemoteCursorByEntity,
  RemoteEntity,
} from './types'

const NOW = 1_800_000_000_000
const activeEngines: CloudSyncEngine[] = []

afterEach(() => {
  for (const engine of activeEngines.splice(0)) {
    engine.stop()
  }
  vi.useRealTimers()
})

describe('cloud sync engine', () => {
  it('pulls a new device and bootstrap-uploads legacy local entities', async () => {
    const localDeck = makeLocalDeck('local-deck')
    const remoteDeck = remoteUpsert('remote-deck')
    const local = new MemoryLocalAdapter([localDeck])
    const remote = new MemoryRemoteStore([remoteDeck])
    const engine = createEngine(local, remote)

    await engine.start('uid-1', 'learner@example.com')

    expect(local.appliedRemote).toEqual([remoteDeck])
    expect(remote.pushed).toHaveLength(1)
    expect(remote.pushed[0]).toMatchObject({
      entityType: 'deck',
      entityId: 'local-deck',
      operation: 'upsert',
    })
    expect(engine.getState()).toMatchObject({
      authPhase: 'signed-in',
      syncPhase: 'idle',
      pendingCount: 0,
      lastSyncedAt: NOW,
      user: { uid: 'uid-1', email: 'learner@example.com' },
    })
  })

  it('does not apply a remote value over an existing pending mutation', async () => {
    const localDeck = makeLocalDeck('deck-1', 'Local')
    const pending = pendingUpsert(localDeck)
    const local = new MemoryLocalAdapter([localDeck], [pending])
    const remoteValue = remoteUpsert('deck-1', 'Remote')
    const remote = new MemoryRemoteStore([remoteValue])
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(
      local.appliedRemote.some(
        (entry) =>
          entry.operation === 'upsert' &&
          (entry.payload as Deck).name === 'Remote',
      ),
    ).toBe(false)
    expect(remote.pushed).toEqual([pending])
  })

  it('applies realtime tombstones when the entity is not pending', async () => {
    const local = new MemoryLocalAdapter([])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    const tombstone: RemoteEntity = {
      entityType: 'card',
      entityId: 'card-1',
      operation: 'delete',
      modifiedAt: NOW,
    }

    remote.emit([tombstone])

    await vi.waitFor(() => {
      expect(local.appliedRemote).toContainEqual(tombstone)
    })
  })

  it('marks failed pushes with exponential backoff', async () => {
    const pending = pendingUpsert(makeLocalDeck('deck-1'))
    const local = new MemoryLocalAdapter([], [pending])
    const remote = new MemoryRemoteStore([])
    remote.pushError = new Error('network failed')
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(local.failed).toEqual([
      {
        id: pending.id,
        revision: pending.revision,
        error: 'network failed',
        nextAttemptAt: NOW + 1_000,
      },
    ])
    expect(engine.getState()).toMatchObject({
      syncPhase: 'error',
      pendingCount: 1,
      error: 'network failed',
    })
  })

  it('keeps a deterministic oversized failure pending without auto retry', async () => {
    vi.useFakeTimers()
    const pending = pendingUpsert(makeLocalDeck('oversized'))
    const local = new MemoryLocalAdapter([], [pending])
    const remote = new MemoryRemoteStore([])
    remote.pushError = new NonRetryableCloudError(
      'Mục này vượt giới hạn an toàn 900 KiB.',
      { affectedMutationIds: [pending.id] },
    )
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(remote.pushCount).toBe(1)
    expect(local.failed).toEqual([
      {
        id: pending.id,
        revision: pending.revision,
        error: 'Mục này vượt giới hạn an toàn 900 KiB.',
        nextAttemptAt: NON_RETRYABLE_NEXT_ATTEMPT_AT,
      },
    ])
    await vi.runAllTimersAsync()
    expect(remote.pushCount).toBe(1)
    expect(engine.getState()).toMatchObject({
      syncPhase: 'error',
      pendingCount: 1,
    })

    engine.signOut()
    await engine.start('uid-1')
    expect(remote.pushCount).toBe(1)
    expect(engine.getState()).toMatchObject({
      syncPhase: 'error',
      error: 'Mục này vượt giới hạn an toàn 900 KiB.',
      pendingCount: 1,
    })

    await engine.retryNow()
    expect(remote.pushCount).toBe(2)
  })

  it('manual retry ignores a future retry timestamp', async () => {
    const pending = {
      ...pendingUpsert(makeLocalDeck('deck-1')),
      nextAttemptAt: NOW + 60_000,
    }
    const local = new MemoryLocalAdapter([], [pending])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')

    expect(remote.pushed).toEqual([])

    await engine.retryNow()

    expect(remote.pushed).toEqual([pending])
    expect(engine.getState().pendingCount).toBe(0)
  })

  it('uses per-entity cursors and skips legacy bootstrap uploads after the first pull', async () => {
    const local = new MemoryLocalAdapter([makeLocalDeck('existing-deck')])
    local.seedMeta({
      uid: 'uid-1',
      lastPulledAt: NOW - 1_000,
      remoteCursorByEntity: {
        deck: NOW - 500,
        card: NOW - 400,
      },
    })
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(remote.lastPullCursor).toEqual({
      deck: NOW - 500,
      card: NOW - 400,
    })
    expect(remote.lastListenCursor).toEqual(remote.lastPullCursor)
    expect(remote.pushed).toEqual([])
  })

  it('does not advance a cursor for protected remote data and reapplies it when pending is discarded', async () => {
    const pending = {
      ...pendingUpsert(makeLocalDeck('deck-1')),
      nextAttemptAt: NOW + 60_000,
    }
    const local = new MemoryLocalAdapter([], [pending])
    local.seedMeta({
      uid: 'uid-1',
      lastPulledAt: NOW - 1_000,
      remoteCursorByEntity: { deck: NOW - 500 },
    })
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    const protectedRemote = {
      ...remoteUpsert('deck-1', 'Remote while pending'),
      remoteCursor: NOW + 100,
    }

    remote.emit([protectedRemote])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(local.appliedRemote).toEqual([])
    expect(local.metaFor('uid-1')?.remoteCursorByEntity).toEqual({
      deck: NOW - 500,
    })

    local.removePending(pending.id)
    await vi.waitFor(() => {
      expect(local.appliedRemote).toContainEqual(protectedRemote)
    })
    expect(local.metaFor('uid-1')?.remoteCursorByEntity).toEqual({
      deck: NOW + 100,
    })
  })

  it('blocks a different account from syncing an owned local dataset', async () => {
    const local = new MemoryLocalAdapter([])
    local.ownerUid = 'uid-owner'
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)

    await engine.start('uid-other')

    expect(remote.pullCount).toBe(0)
    expect(engine.getState()).toMatchObject({
      authPhase: 'signed-out',
      syncPhase: 'error',
    })
    expect(engine.getState().error).toContain('tài khoản khác')
  })

  it('authoritatively re-pulls a foreign revision buffered during a local push', async () => {
    const localDeck = makeLocalDeck('deck-1', 'Local A')
    const pending = pendingUpsert(localDeck)
    const local = new MemoryLocalAdapter([localDeck], [pending])
    const remote = new MemoryRemoteStore([])
    const foreignCommit = {
      ...remoteUpsert('deck-1', 'Remote B'),
      revision: 'foreign-revision-b',
      remoteCursor: NOW + 100,
    }
    const newerCommit = {
      ...remoteUpsert('deck-1', 'Remote C'),
      revision: 'foreign-revision-c',
      remoteCursor: NOW + 200,
    }
    remote.onPush = async () => {
      remote.setPulled([foreignCommit])
      remote.emit([foreignCommit])
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    remote.onPull = (callCount) => {
      if (callCount !== 2) {
        return undefined
      }
      remote.setPulled([newerCommit])
      remote.emit([newerCommit])
      return {
        entities: [foreignCommit],
        cursorByEntity: { deck: NOW + 100 },
      }
    }
    remote.onListen = (callCount, onChanges) => {
      if (callCount === 2) {
        queueMicrotask(() => onChanges([newerCommit]))
      }
    }
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(remote.pullCount).toBe(2)
    expect(remote.listenCount).toBe(2)
    await vi.waitFor(() => {
      expect(local.appliedRemote.at(-1)).toEqual(newerCommit)
    })
    expect(local.metaFor('uid-1')?.remoteCursorByEntity).toEqual({
      deck: NOW + 200,
    })
  })

  it('keeps a server-resolved foreign event over a clock-ahead provisional echo', async () => {
    const localDeck = makeLocalDeck('deck-1', 'Local')
    const pending = pendingUpsert(localDeck)
    const local = new MemoryLocalAdapter([localDeck], [pending])
    const remote = new MemoryRemoteStore([])
    const provisionalEcho: RemoteEntity = {
      entityType: 'deck',
      entityId: 'deck-1',
      operation: 'upsert',
      payload: localDeck.payload,
      modifiedAt: NOW + 10_000_000,
      revision: pending.revision,
    }
    const foreignServerEvent = {
      ...remoteUpsert('deck-1', 'Foreign server value'),
      modifiedAt: NOW,
      revision: 'foreign-revision',
      remoteCursor: NOW + 100,
    }
    remote.onPush = async () => {
      remote.emit([provisionalEcho])
      remote.setPulled([foreignServerEvent])
      remote.emit([foreignServerEvent])
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const engine = createEngine(local, remote)

    await engine.start('uid-1')

    expect(remote.pullCount).toBe(2)
    await vi.waitFor(() => {
      expect(local.appliedRemote.at(-1)).toEqual(foreignServerEvent)
    })
    expect(local.metaFor('uid-1')?.remoteCursorByEntity).toEqual({
      deck: NOW + 100,
    })
  })

  it('caps retry delays and normalizes invalid attempt counts', () => {
    expect(retryDelay(-2)).toBe(1_000)
    expect(retryDelay(3)).toBe(8_000)
    expect(retryDelay(50)).toBe(5 * 60 * 1_000)
  })

  it('automatically retries a failed outbox push while still online', async () => {
    vi.useFakeTimers()
    let now = NOW
    const pending = pendingUpsert(makeLocalDeck('deck-1'))
    const local = new MemoryLocalAdapter([], [pending])
    const remote = new MemoryRemoteStore([])
    remote.pushError = new Error('temporary failure')
    const engine = createEngine(local, remote, () => now)
    await engine.start('uid-1')
    remote.pushError = undefined

    now += 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pushed).toEqual([pending])
    expect(engine.getState()).toMatchObject({
      syncPhase: 'idle',
      pendingCount: 0,
    })
  })

  it('automatically retries a failed bootstrap while still online', async () => {
    vi.useFakeTimers()
    const local = new MemoryLocalAdapter([])
    const remote = new MemoryRemoteStore([])
    remote.pullError = new Error('temporary pull failure')
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    expect(remote.pullCount).toBe(1)
    remote.pullError = undefined

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pullCount).toBe(2)
    expect(engine.getState().syncPhase).toBe('idle')
  })

  it('re-pulls from cursors and reattaches after a terminal listener error', async () => {
    vi.useFakeTimers()
    const local = new MemoryLocalAdapter([])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    expect(remote.pullCount).toBe(1)

    remote.failListener(new Error('listener disconnected'))
    expect(engine.getState().syncPhase).toBe('error')

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pullCount).toBe(2)
    expect(remote.listenCount).toBe(2)
    expect(engine.getState().syncPhase).toBe('idle')
  })

  it('re-pulls an event after a fail-once local realtime apply', async () => {
    vi.useFakeTimers()
    const local = new MemoryLocalAdapter([])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    const change = {
      ...remoteUpsert('deck-1', 'Recovered'),
      remoteCursor: NOW + 100,
    }
    local.applyRemoteFailuresRemaining = 1
    remote.setPulled([change])

    remote.emit([change])
    await vi.waitFor(() => {
      expect(engine.getState()).toMatchObject({
        syncPhase: 'error',
        error: 'Dexie apply failed once',
      })
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pullCount).toBe(2)
    expect(remote.listenCount).toBe(2)
    expect(local.appliedRemote).toContainEqual(change)
    expect(engine.getState().syncPhase).toBe('idle')
  })

  it('does not advance the in-memory cursor when realtime meta persistence fails', async () => {
    vi.useFakeTimers()
    const local = new MemoryLocalAdapter([])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    const change = {
      ...remoteUpsert('deck-1', 'Meta recovery'),
      remoteCursor: NOW + 100,
    }
    local.updateMetaFailuresRemaining = 1
    remote.setPulled([change])
    remote.onPull = (_callCount, afterCursor) =>
      (afterCursor?.deck ?? 0) >= NOW + 100
        ? {
            entities: [],
            cursorByEntity: afterCursor ?? {},
          }
        : undefined

    remote.emit([change])
    await vi.waitFor(() => {
      expect(engine.getState()).toMatchObject({
        syncPhase: 'error',
        error: 'Dexie meta update failed once',
      })
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pullCount).toBe(2)
    expect(local.appliedRemote).toEqual([change, change])
    expect(local.metaFor('uid-1')?.remoteCursorByEntity).toEqual({
      deck: NOW + 100,
    })
    expect(engine.getState().syncPhase).toBe('idle')
  })

  it('schedules a catch-up pull when fail-once deferred reconciliation fails', async () => {
    vi.useFakeTimers()
    const pending = {
      ...pendingUpsert(makeLocalDeck('deck-1')),
      nextAttemptAt: NOW + 60_000,
    }
    const local = new MemoryLocalAdapter([], [pending])
    const remote = new MemoryRemoteStore([])
    const engine = createEngine(local, remote)
    await engine.start('uid-1')
    const change = {
      ...remoteUpsert('deck-1', 'Deferred recovery'),
      remoteCursor: NOW + 100,
    }
    remote.setPulled([change])
    remote.emit([change])
    await vi.advanceTimersByTimeAsync(0)
    local.applyRemoteFailuresRemaining = 1

    local.removePending(pending.id)
    await vi.waitFor(() => {
      expect(engine.getState()).toMatchObject({
        syncPhase: 'error',
        error: 'Dexie apply failed once',
      })
    })
    expect(local.appliedRemote).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    expect(remote.pullCount).toBe(2)
    expect(remote.listenCount).toBe(2)
    expect(local.appliedRemote).toContainEqual(change)
    expect(engine.getState().syncPhase).toBe('idle')
  })
})

function createEngine(
  local: MemoryLocalAdapter,
  remote: MemoryRemoteStore,
  now: () => number = () => NOW,
): CloudSyncEngine {
  const engine = new CloudSyncEngine(local, () => remote, {
    now,
  })
  activeEngines.push(engine)
  return engine
}

class MemoryRemoteStore implements RemoteStore {
  readonly pushed: PendingMutationSnapshot[] = []
  pushError?: Error
  pushCount = 0
  pullError?: Error
  pullCount = 0
  listenCount = 0
  lastPullCursor?: RemoteCursorByEntity
  lastListenCursor?: RemoteCursorByEntity
  onPush?: (
    entries: readonly PendingMutationSnapshot[],
  ) => void | Promise<void>
  onPull?: (
    callCount: number,
    afterCursor?: RemoteCursorByEntity,
  ) =>
    | Awaited<ReturnType<RemoteStore['pullAll']>>
    | undefined
    | Promise<
        Awaited<ReturnType<RemoteStore['pullAll']>> | undefined
      >
  onListen?: (
    callCount: number,
    onChanges: (changes: RemoteEntity[]) => void,
  ) => void
  private changeListener?: (changes: RemoteEntity[]) => void
  private errorListener?: (error: unknown) => void
  private readonly pulled: RemoteEntity[]

  constructor(pulled: RemoteEntity[]) {
    this.pulled = pulled
  }

  async pullAll(afterCursor?: RemoteCursorByEntity): Promise<{
    entities: RemoteEntity[]
    cursorByEntity: RemoteCursorByEntity
  }> {
    this.pullCount += 1
    if (this.pullError) {
      throw this.pullError
    }
    const override = await this.onPull?.(
      this.pullCount,
      afterCursor,
    )
    if (override) {
      return override
    }
    this.lastPullCursor = afterCursor
    const cursorByEntity = { ...afterCursor }
    for (const entry of this.pulled) {
      if (entry.remoteCursor !== undefined) {
        cursorByEntity[entry.entityType] = entry.remoteCursor
      }
    }
    return { entities: this.pulled, cursorByEntity }
  }

  async push(entries: readonly PendingMutationSnapshot[]): Promise<void> {
    this.pushCount += 1
    if (this.pushError) {
      throw this.pushError
    }
    this.pushed.push(...entries)
    this.applyEntriesToPulled(entries)
    await this.onPush?.(entries)
  }

  listen(
    onChanges: (changes: RemoteEntity[]) => void,
    _onError: (error: unknown) => void,
    afterCursor?: RemoteCursorByEntity,
  ): () => void {
    this.listenCount += 1
    this.lastListenCursor = afterCursor
    this.changeListener = onChanges
    this.errorListener = _onError
    this.onListen?.(this.listenCount, onChanges)
    return () => {
      this.changeListener = undefined
      this.errorListener = undefined
    }
  }

  emit(changes: RemoteEntity[]): void {
    this.changeListener?.(changes)
  }

  failListener(error: unknown): void {
    this.errorListener?.(error)
  }

  setPulled(entries: readonly RemoteEntity[]): void {
    this.pulled.splice(0, this.pulled.length, ...entries)
  }

  private applyEntriesToPulled(
    entries: readonly PendingMutationSnapshot[],
  ): void {
    for (const entry of entries) {
      const index = this.pulled.findIndex(
        (remote) =>
          remote.entityType === entry.entityType &&
          remote.entityId === entry.entityId,
      )
      const pushed: RemoteEntity = {
        entityType: entry.entityType,
        entityId: entry.entityId,
        operation: entry.operation,
        payload: entry.payload,
        modifiedAt: entry.queuedAt,
        revision: entry.revision,
        remoteCursor: NOW + 1,
      }
      if (index >= 0) {
        this.pulled[index] = pushed
      } else {
        this.pulled.push(pushed)
      }
    }
  }
}

class MemoryLocalAdapter implements LocalSyncAdapter {
  readonly appliedRemote: RemoteEntity[] = []
  readonly failed: Array<{
    id: string
    revision: string
    error: string
    nextAttemptAt: number
  }> = []
  private readonly meta = new Map<string, CloudSyncMeta>()
  private listener?: () => void
  ownerUid?: string
  applyRemoteFailuresRemaining = 0
  updateMetaFailuresRemaining = 0
  private readonly local: LocalEntitySnapshot[]
  private readonly pending: PendingMutationSnapshot[]

  constructor(
    local: LocalEntitySnapshot[],
    pending: PendingMutationSnapshot[] = [],
  ) {
    this.local = local
    this.pending = pending
  }

  async claimOwnership(uid: string): Promise<{
    claimed: boolean
    ownerUid: string
  }> {
    if (this.ownerUid && this.ownerUid !== uid) {
      return { claimed: false, ownerUid: this.ownerUid }
    }
    this.ownerUid = uid
    return { claimed: true, ownerUid: uid }
  }

  async listLocal(): Promise<LocalEntitySnapshot[]> {
    return this.local
  }

  async countPending(): Promise<number> {
    return this.pending.length
  }

  async listPending(options: {
    readyAt?: number
    limit?: number
  } = {}): Promise<PendingMutationSnapshot[]> {
    const ready =
      options.readyAt === undefined
        ? this.pending
        : this.pending.filter(
            (entry) =>
              entry.nextAttemptAt === undefined ||
              entry.nextAttemptAt <= options.readyAt!,
          )
    return ready.slice(0, options.limit)
  }

  async applyRemote(
    changes: readonly RemoteEntity[],
  ): Promise<RemoteEntity[]> {
    if (this.applyRemoteFailuresRemaining > 0) {
      this.applyRemoteFailuresRemaining -= 1
      throw new Error('Dexie apply failed once')
    }
    this.appliedRemote.push(...changes)
    return [...changes]
  }

  async queueBootstrap(
    entities: readonly LocalEntitySnapshot[],
  ): Promise<void> {
    this.pending.push(
      ...entities.map((entity) => ({
        id: `${entity.entityType}:${entity.entityId}`,
        revision: `bootstrap-${entity.entityId}`,
        entityType: entity.entityType,
        entityId: entity.entityId,
        operation: 'upsert' as const,
        payload: entity.payload,
        queuedAt: NOW,
        attemptCount: 0,
      })),
    )
  }

  async acknowledgeMany(
    entries: readonly { id: string; revision: string }[],
  ): Promise<void> {
    for (const entry of entries) {
      const index = this.pending.findIndex(
        (candidate) =>
          candidate.id === entry.id &&
          candidate.revision === entry.revision,
      )
      if (index >= 0) {
        this.pending.splice(index, 1)
      }
    }
    this.listener?.()
  }

  async markFailedMany(
    entries: readonly {
      id: string
      revision: string
      error: string
      nextAttemptAt: number
    }[],
  ): Promise<void> {
    this.failed.push(...entries)
    for (const failure of entries) {
      const entry = this.pending.find(
        (candidate) =>
          candidate.id === failure.id &&
          candidate.revision === failure.revision,
      )
      if (entry) {
        entry.nextAttemptAt = failure.nextAttemptAt
        entry.attemptCount = (entry.attemptCount ?? 0) + 1
        entry.lastError = failure.error
      }
    }
  }

  async getMeta(uid: string): Promise<CloudSyncMeta | undefined> {
    return this.meta.get(uid)
  }

  async updateMeta(
    uid: string,
    patch: Partial<Omit<CloudSyncMeta, 'uid'>>,
  ): Promise<void> {
    if (this.updateMetaFailuresRemaining > 0) {
      this.updateMetaFailuresRemaining -= 1
      throw new Error('Dexie meta update failed once')
    }
    this.meta.set(uid, {
      ...this.meta.get(uid),
      ...patch,
      uid,
    })
  }

  subscribeToPending(listener: () => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  seedMeta(meta: CloudSyncMeta): void {
    this.meta.set(meta.uid, meta)
  }

  metaFor(uid: string): CloudSyncMeta | undefined {
    return this.meta.get(uid)
  }

  removePending(id: string): void {
    const index = this.pending.findIndex((entry) => entry.id === id)
    if (index >= 0) {
      this.pending.splice(index, 1)
      this.listener?.()
    }
  }
}

function makeLocalDeck(
  id: string,
  name = 'Local deck',
): LocalEntitySnapshot<'deck'> {
  return {
    entityType: 'deck',
    entityId: id,
    payload: makeDeck(id, name),
  }
}

function remoteUpsert(id: string, name = 'Remote deck'): RemoteEntity<'deck'> {
  return {
    entityType: 'deck',
    entityId: id,
    operation: 'upsert',
    payload: makeDeck(id, name),
    modifiedAt: NOW,
  }
}

function pendingUpsert(
  local: LocalEntitySnapshot<'deck'>,
): PendingMutationSnapshot {
  return {
    id: `deck:${local.entityId}`,
    revision: `revision-${local.entityId}`,
    entityType: 'deck',
    entityId: local.entityId,
    operation: 'upsert',
    payload: local.payload,
    queuedAt: NOW,
    attemptCount: 0,
  }
}

function makeDeck(id: string, name: string): Deck {
  return {
    id,
    name,
    sourceType: 'manual',
    preferredDirection: 'en-vi',
    reminderEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }
}
