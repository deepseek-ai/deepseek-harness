/** Host Schedule tests use real domain storage and an explicit Session resolver. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage, { type KvUnit, type KvUnitDescriptor, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScheduleService, { type Config } from '../src/index.ts'

/**
 * Memory backend whose schedule-unit writes pass through per-primitive hooks.
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
  } = {},
): StorageBackend {
  const memory = new MemoryStorageBackend(pool)
  return {
    close: () => memory.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await memory.kv.open(descriptor)
        if (descriptor.name !== 'schedule') return unit
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
 * @returns Context, durable storage, service, and delivery observations.
 */
export async function harness(options: {
  beforeService?: (ctx: Context, facility: DomainFacility) => Promise<void>
  onContext?: (ctx: Context) => void
  pool?: MemoryMediaPool
  backend?: StorageBackend
  direct?: true
  config?: Config
} = {}) {
  const ctx = new Context()
  options.onContext?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
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
  ctx.provide('sessionController', { resolveAgent: resolve } as never)
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush)
  // This fixture supplies flush behavior above; Schedule does not invoke persistence methods directly.
  ctx.provide('sessionPersistence', {} as never)
  await options.beforeService?.(ctx, facility)
  let fiber: Context['fiber']
  if (options.direct) {
    const service = new ScheduleService(ctx, options.config ?? {})
    await service[Service.init]()
    fiber = ctx.fiber
  } else {
    fiber = await ctx.plugin(ScheduleService, options.config)
  }
  return { ctx, service: ctx.schedule, pool, resolve, flush, fiber }
}

/**
 * Agent fixture whose follow-up entry stays a spy property.
 *
 * `Agent` declares `followup` as a method, so reading it off the interface
 * would hand callers an unbound method reference; the fixture's own type keeps
 * it a property of function type, which is what the runtime stores.
 */
export interface HarnessAgent extends Agent {
  /** Spy recording every message a delivery wrote to this Agent. */
  followup: Mock<(message: UserMessage) => void>
}

/** Build an unregistered Agent for a test-owned Session.
 * @param ctx - Services owning the Session.
 * @param id - Unique Session identity within the test Context.
 * @returns Agent whose follow-up entry is a spy.
 */
export function agentFor(ctx: Context, id = 'original'): HarnessAgent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', inbox: unsupportedInbox(),
    send() {}, followup: vi.fn<(message: UserMessage) => void>(), steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}
