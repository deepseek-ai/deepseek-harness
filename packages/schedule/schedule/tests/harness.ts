/** Host Schedule tests use real domain storage and an explicit Session resolver. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedModel, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import Storage, { type KvUnit, type KvUnitDescriptor, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScheduleService, { type Config } from '../src/index.ts'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from '../src/storage.ts'

import type { ScheduleCatalogEntry, ScheduleId, ScheduleRecord, ScheduleTarget } from '../src/types.ts'

/** Creation, change, and prompt-change time of seeded tasks, earlier than every test clock. */
export const SEED_TIME = '2000-01-01T00:00:00.000Z'

/**
 * Memory backend whose Schedule-unit writes pass through per-primitive hooks.
 *
 * The hook runs before the write reaches the medium, so a case can hold a row
 * write open or reject a chosen row delete.
 * @param pool - Media the backend serves.
 * @param traps - Optional hook per primitive; a rejection propagates to the caller.
 * @returns The backend to hand to `harness`.
 */
export function gatedScheduleBackend(
  pool: MemoryMediaPool,
  traps: {
    putRecord?: (table: string, key: string) => Promise<void> | undefined
    deleteRecord?: (table: string, key: string) => Promise<void> | undefined
    deleteRecords?: (table: string, keys: readonly string[]) => Promise<void> | undefined
  } = {},
): StorageBackend {
  const memory = new MemoryStorageBackend(pool)
  return {
    close: () => memory.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await memory.kv.open(descriptor)
        if (descriptor.name !== scheduleDomain.name) return unit
        const backup = unit.backupRecord?.bind(unit)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            await traps.putRecord?.(table, key)
            await unit.putRecord(table, key, value)
          },
          deleteRecord: async (table, key) => {
            await traps.deleteRecord?.(table, key)
            await unit.deleteRecord(table, key)
          },
          deleteRecords: async (table, keys) => {
            await traps.deleteRecords?.(table, keys)
            await unit.deleteRecords(table, keys)
          },
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
          ...(backup === undefined ? {} : { backupRecord: backup }),
        }
      },
    },
  }
}

/** Create isolated services with an explicit fake Session resolver.
 * @param options - Optional durable or live state present before service activation.
 * @returns Context, durable storage, service, and Session-controller and delivery observations.
 */
export async function harness(options: {
  beforeService?: (ctx: Context, facility: DomainFacility) => Promise<void>
  onContext?: (ctx: Context) => void
  pool?: MemoryMediaPool
  backend?: StorageBackend
  direct?: true
  sessionController?: false
  config?: Config
} = {}) {
  const ctx = new Context()
  options.onContext?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = options.backend ?? new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const resolve = vi.fn<Context['sessionController']['resolveAgent']>(async () => { throw new Error('missing Session') })
  const createSession = vi.fn<Context['sessionController']['create']>(async request => ({
    sessionId: request.sessionId ?? SessionId('created-session'),
  }))
  // Every Session exists as a top-level stored Session unless a case overrides this observation.
  const stat = vi.fn<Context['sessionPersistence']['stat']>(async sessionId => storedSession(sessionId))
  if (options.sessionController !== false) {
    ctx.provide('sessionController', { resolveAgent: resolve, create: createSession } as never)
  }
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush)
  ctx.provide('sessionPersistence', { stat } as never)
  await options.beforeService?.(ctx, facility)
  let fiber: Context['fiber']
  if (options.direct) {
    const service = new ScheduleService(ctx, options.config ?? {})
    await service[Service.init]()
    fiber = ctx.fiber
  } else {
    fiber = await ctx.plugin(ScheduleService, options.config)
  }
  const resolveAgent = async (sessionId: SessionId): Promise<Agent> => {
    const controller = ctx.get('sessionController')
    if (controller === undefined) throw new Error('schedule: no Session activation provider')
    const result = await controller.resolveAgent(sessionId)
    if ('error' in result) throw result.error
    return result.agent
  }
  return { ctx, service: ctx.schedule, pool, resolve, resolveAgent, createSession, stat, flush, fiber }
}

/**
 * Build the header-only observation of a stored Session.
 * @param sessionId - Inspected Session.
 * @param delegationDepth - Saved delegation depth; omission records a top-level Session.
 * @returns Saved header and revision.
 */
export function storedSession(sessionId: SessionId, delegationDepth?: number): SessionPersistenceSnapshot {
  return {
    header: {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false,
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    },
    revision: SessionPersistenceRevision(`test:${sessionId}:stat`),
  }
}

/**
 * Agent fixture whose follow-up and inject entries stay spy properties.
 *
 * `Agent` declares `followup` and `inject` as methods, so reading them off the interface
 * would hand callers unbound method references; the fixture's own type keeps
 * them properties of function type, which is what the runtime stores.
 */
export interface HarnessAgent extends Agent {
  /** Spy recording every message a delivery wrote to this Agent. */
  followup: Mock<(message: UserMessage) => void>
  /** Spy recording every change notice queued for this Agent. */
  inject: Mock<(message: UserMessage) => void>
}

/** Build an unregistered Agent for a test-owned Session.
 * @param ctx - Services owning the Session.
 * @param id - Unique Session identity within the test Context.
 * @param meta - Optional Session creation metadata, such as subagent lineage.
 * @returns Agent whose follow-up and inject entries are spies.
 */
export function agentFor(ctx: Context, id = 'original', meta?: CreateSessionOptions['meta']): HarnessAgent {
  const session = ctx.sessions.create(SessionId(id), meta === undefined ? undefined : { meta })
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    followup: vi.fn<(message: UserMessage) => void>(), inject: vi.fn<(message: UserMessage) => void>(),
    send() {}, steer() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}

/**
 * Build the stored value of a task targeting one existing Session.
 * @param sessionId - Target Session.
 * @param rule - Authoritative timing record.
 * @param fields - Stored fields that replace the seeded defaults.
 * @returns Validated task value.
 */
export function boundTask(sessionId: SessionId, rule: ScheduleRecord, fields: Partial<ScheduleTask> = {}): ScheduleTask {
  return seededTask(rule, { kind: 'session', sessionId }, fields)
}

/**
 * Build the stored value of a task without delivery history.
 * @param record - Record with its committed occurrence.
 * @param target - Stored destination.
 * @param fields - Stored fields that replace the seeded defaults.
 * @returns Validated task value.
 */
export function seededTask(record: ScheduleRecord, target: ScheduleTarget, fields: Partial<ScheduleTask> = {}): ScheduleTask {
  return scheduleTaskSchema.parse({
    record, target, involvedSessionIds: target.kind === 'new' ? [] : [target.sessionId], status: 'active',
    createdAt: SEED_TIME, updatedAt: SEED_TIME,
    deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
    ...fields,
  })
}

/**
 * Store tasks before the service opens its domain.
 * @param facility - Facility the service later opens.
 * @param tasks - Values to store under their record identities.
 */
export async function seedTasks(facility: DomainFacility, tasks: readonly ScheduleTask[]): Promise<void> {
  const domain = await facility.open(scheduleDomain)
  try {
    for (const task of tasks) await domain.table('tasks').put(task.record.id, task)
  } finally {
    await domain.close()
  }
}

/**
 * Read the task table that the running service holds open.
 * @param ctx - Context whose service opened the domain.
 * @returns Live task table.
 */
export function taskTable(ctx: Context): KvTable<ScheduleId, ScheduleTask> {
  const domain = ctx.storageDomain.get(scheduleDomain.name)
  if (domain === undefined) throw new Error('Schedule domain not initialized')
  // The service opens this name with scheduleDomain; registry lookup erases that type.
  return domain.table('tasks') as KvTable<ScheduleId, ScheduleTask>
}

/** Extract the authoritative rule from a management response for storage assertions. */
export function recordOf(entry: ScheduleCatalogEntry): ScheduleRecord {
  const { target: _target, involvedSessionIds: _involved, status: _status, createdAt: _createdAt, updatedAt: _updatedAt,
    lastDelivery: _lastDelivery,
    executionActive: _execution, deliveryFloorEndsAt: _floor, ...record } = entry
  return record
}

/** Shape inspected in test-owned Schedule JSON; assertions verify the raw stored values. */
interface StoredScheduleUnit {
  readonly unit: unknown
  readonly global: unknown
  readonly tables: { readonly tasks: Record<string, ScheduleTask> }
}

/** Read trusted test output without running the task decoder or normalizing its raw fields. */
export function storedUnit(text: string): StoredScheduleUnit {
  return JSON.parse(text) as StoredScheduleUnit
}
