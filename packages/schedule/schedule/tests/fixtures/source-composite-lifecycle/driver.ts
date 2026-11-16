/** Real Loader teardown with controlled composite work and persisted delivery observations. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { scheduleDomain } from '@deepseek-ai/dsh-schedule'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import type {} from './world.ts'

const configPath = process.argv[2]
const mode = process.argv[3]
assert.ok(configPath)
assert.ok(mode === 'provider' || mode === 'composer')
const ctx = await boot('source-composite-lifecycle', resolveConfigPath(configPath, undefined))
assert.equal(ctx.fiber.uid, 0)
// The root stays active while the provider and composer are unloaded.
const activeState = ctx.fiber.state
let release: (() => void) | undefined
let sender: Promise<object> | undefined
let closing: Promise<void> | undefined
let report: object | undefined

try {
  const world = ctx.get('sourceCompositeLifecycle')
  const schedule = ctx.get('schedule')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  assert.ok(world && schedule && sessions && persistence)
  release = () => { world.release.resolve(undefined) }
  world.task = await schedule.create({
    title: 'Composite lifecycle',
    prompt: 'Read the composite observation.',
    timing: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
    target: { kind: 'session', sessionId: world.agent.id },
  })
  const owner = [...ctx.loader.entries()].find(entry => entry.options.id === 'source-owner')
  const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'schedule')
  const worldOwner = [...ctx.loader.entries()].find(entry => entry.options.id === 'lifecycle-world')
  assert.ok(owner && provider?.fiber && worldOwner?.fiber)
  await owner.update({ disabled: false })
  assert.ok(owner.fiber)
  await owner.fiber.await()
  assert.ok(world.receiver)
  await world.receiver.await()

  const counts = async () => {
    await world.agent.whenIdle()
    await sessions.flush(world.agent.session)
    const handle = await persistence.open(world.agent.id, 'read')
    let userMessageIds: string[] = []
    let inboxMessageIds: string[] = []
    try {
      const events = (await handle.read(0)).events
      const inputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule')
      userMessageIds = inputs.flatMap(event => event.type === 'user/message' ? [event.data.id] : [])
      inboxMessageIds = events.filter(event => event.type === 'agent/inbox/spliced')
        .flatMap(event => event.data.inserted).map(message => message.id)
    } finally {
      await handle.close()
    }
    const backend = new JsonStorageBackend(join(process.cwd(), 'storage'))
    try {
      const unit = await backend.kv.open(descriptorOf(scheduleDomain))
      try {
        const saved = await unit.loadAll()
        const task = scheduleDomain.tables.tasks.valueSchema.parse(saved.tables.tasks?.[world.task.id])
        const ids = new Set<string>(task.deliveryHistory.records.map(receipt => receipt.messageId))
        return {
          messages: userMessageIds.filter(id => ids.has(id)).length,
          inbox: inboxMessageIds.filter(id => ids.has(id)).length,
          receipts: task.deliveryHistory.records.length,
          requests: world.adapter.requests.length,
        }
      } finally {
        await unit.close()
      }
    } finally {
      await backend.close()
    }
  }

  sender = world.producer.sample('controlled composite before unload').then(() => {
    world.events.push('sender-fulfilled')
    return { status: 'fulfilled' }
  }, (error: unknown) => {
    world.events.push('sender-rejected')
    return { status: 'rejected', error: String(error), detail: JSON.stringify(error) }
  })
  await world.entered.promise
  const target = mode === 'composer' ? owner.fiber : provider.fiber
  closing = target.dispose().then(() => { world.events.push('disposal-done') })
  await world.draining.promise
  await world.receiver.await()
  const beforeRelease = {
    receiverCleanup: world.events.includes('receiver-cleanup'),
    disposalDone: world.events.includes('disposal-done'),
    providerActive: provider.fiber?.state === activeState,
    worldActive: worldOwner.fiber.state === activeState,
  }
  assert.equal(beforeRelease.disposalDone, false)
  assert.equal(beforeRelease.worldActive, true)
  world.events.push('release')
  world.release.resolve(undefined)
  const outcome = await sender
  await closing
  const primary = await counts()
  const events = [...world.events]
  let replacement: Awaited<ReturnType<typeof counts>> | undefined
  if (mode !== 'composer') {
    await provider.update({ disabled: false })
    assert.ok(provider.fiber)
    await provider.fiber.await()
    await owner.update({ disabled: false })
    assert.ok(owner.fiber)
    await owner.fiber.await()
    assert.ok(world.receiver)
    await world.receiver.await()
    assert.equal(provider.fiber.state, activeState)
    assert.equal(owner.fiber.state, activeState)
    assert.equal(world.receiver.state, activeState)
    const replacementSchedule = ctx.get('schedule')
    assert.ok(replacementSchedule)
    const view = await replacementSchedule.view({ id: world.task.id })
    assert.ok(!('code' in view))
    try {
      if (view.deliveryFloorEndsAt !== undefined) {
        mock.timers.enable({ apis: ['Date'], now: Date.parse(view.deliveryFloorEndsAt) })
      }
      await world.producer.sample('explicit sample after provider replacement')
    } finally {
      mock.timers.reset()
    }
    replacement = await counts()
  }
  report = { mode, outcome, beforeRelease, events, primary, replacement }
} finally {
  release?.()
  await Promise.allSettled([sender, closing])
  await ctx.fiber.dispose()
}
await writeFile('source-composite-lifecycle.json', `${JSON.stringify(report, null, 2)}\n`)
