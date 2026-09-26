/** Schedule owns its record schema, so the creation-ordering integration runs here beside the storage it seeds. */
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import ScheduleService from '../src/index.ts'
import { scheduleDomain } from '../src/storage.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function core(persistenceRoot: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('due delivery during Agent creation', () => {
  it('enqueues the reminder without starting a turn before every creation listener finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-serial-'))
    roots.push(root)
    const ctx = await core(join(root, 'sessions'))
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'schedule-storage') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const sessionId = SessionId('serial-delivery')
    const id = ScheduleId('due')
    const record = createAfterScheduleRecord(id, 'Due reminder', 1, Date.now() - 2_000, 'Due reminder')
    const seeded = await ctx.storageDomain.open(scheduleDomain)
    await seeded.table('tasks').put(record.id, { sessionId, record, status: 'active' })
    await seeded.close()
    const available = Promise.withResolvers<Agent>()
    // The resolver returns the Agent while its serial publication listeners are blocked.
    ctx.provide('sessionController', {
      resolveAgent: async (bound: SessionId) => {
        expect(bound).toBe(sessionId)
        return { agent: await available.promise }
      },
    } as never)
    await ctx.plugin(ScheduleService)
    const delivered: { readonly id: string; readonly source: unknown }[] = []
    const enqueued = Promise.withResolvers<undefined>()
    ctx.on('agent/inbox/inserted', ({ message }) => {
      delivered.push({ id: message.id, source: message.source })
      if (message.source.kind === 'schedule') enqueued.resolve(undefined)
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const turn = Promise.withResolvers<undefined>()
    let turns = 0
    let created = false
    let laterCreated = false
    ctx.on('agent/created', async ({ agent }) => {
      available.resolve(agent)
      entered.resolve(undefined)
      await release.promise
      created = true
    })
    ctx.on('agent/created', () => { laterCreated = true })
    ctx.on('session/event', (_session, event) => { if (event.type === 'turn/start') { turns += 1; turn.resolve(undefined) } })
    const creating = ctx.agents.create({ sessionId })
    try {
      await entered.promise
      await enqueued.promise
      // A full event-loop turn lets the due runtime run if it starts during creation.
      await setImmediate()
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.source).toMatchObject({ kind: 'schedule' })
      expect(turns).toBe(0)
      expect(laterCreated).toBe(false)
      release.resolve(undefined)
      await creating
      await turn.promise
      expect(created).toBe(true)
      expect(laterCreated).toBe(true)
      // The receipt commits after the flush resolves, so the settled record is observed asynchronously.
      await expect.poll(async () => (await ctx.schedule.catalog())[0]?.status).toBe('inactive')
      const [entry] = await ctx.schedule.catalog()
      expect(entry?.lastDelivery?.messageId).toBe(delivered[0]?.id)
    } finally {
      release.resolve(undefined)
      await creating
      await ctx.fiber.dispose()
    }
  })
})
