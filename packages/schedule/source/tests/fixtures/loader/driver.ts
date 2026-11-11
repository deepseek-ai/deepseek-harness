/** Keyless app/Loader fixture with real inbox persistence, task storage, and model-request assembly. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { scheduleDomain } from '@deepseek-ai/dsh-schedule'
import { SourceError } from '@deepseek-ai/dsh-source'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import type {} from './world.ts'

const configPath = process.argv[2]
assert.ok(configPath, 'source composition requires its Loader config')
const ctx = await boot('source-composition', resolveConfigPath(configPath, undefined))
let observedInput = ''
let taskId = ''
let receiptMessageId = ''
try {
  const world = ctx.get('sourceComposition')
  assert.ok(world, 'Loader must publish the composed source fixture')
  const schedule = ctx.get('schedule')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  assert.ok(schedule)
  assert.ok(sessions)
  assert.ok(persistence)
  taskId = world.task.id

  await world.left.sample('build passed')
  const beforePair = await schedule.history({ id: world.task.id, limit: 10 })
  assert.ok('records' in beforePair)
  assert.deepEqual(beforePair.records, [])
  assert.equal(world.adapter.requests.length, 0, 'one input cannot produce a composite delivery')

  await world.right.sample('tests failed\n"review" \\ observed')
  const history = await schedule.history({ id: world.task.id, limit: 10 })
  assert.ok('records' in history)
  assert.equal(history.records.length, 1)
  const receipt = history.records[0]
  assert.ok(receipt)
  receiptMessageId = receipt.messageId
  assert.equal(receipt.targetSessionId, world.agent.id)

  // The receipt identifies accepted input; whole-agent idle bounds the subsequent request observation.
  await world.agent.whenIdle()
  await sessions.flush(world.agent.session)
  const readSession = async () => {
    const handle = await persistence.open(world.agent.id, 'read')
    try {
      return (await handle.read(0)).events
    } finally {
      await handle.close()
    }
  }
  const events = await readSession()
  const inputs = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule')
  assert.equal(inputs.length, 1)
  const input = inputs[0]
  assert.ok(input?.type === 'user/message')
  assert.equal(input.data.id, receipt.messageId)
  const text = input.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  assert.equal(world.adapter.requests.length, 1)
  const request = world.adapter.requests[0]
  assert.ok(request)
  assert.ok(request.messages.some(message => message.role === 'user'
    && message.content.some(block => block.type === 'text' && block.text === text)),
  'the adapter must see the exact input reread from JSONL')
  const inboxInsertions = events.filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
  assert.ok(inboxInsertions.some(message => message.id === receipt.messageId))

  const afterDelivery = await schedule.view({ id: world.task.id })
  assert.ok(!('code' in afterDelivery))
  assert.equal(afterDelivery.scheduledAt, world.task.scheduledAt)
  assert.equal(afterDelivery.status, 'active')
  observedInput = text
    .replace(`schedule_id_json: ${JSON.stringify(world.task.id)}`, 'schedule_id_json: "<task-id>"')
    .replace(`occurrence_at: ${receipt.scheduledAt}`, 'occurrence_at: <delivery-time>')

  const owner = [...ctx.loader.entries()].find(entry => entry.options.id === 'source-owner')
  assert.ok(owner?.fiber, 'the source subscriptions need a real Loader owner')
  await owner.fiber.dispose()
  await world.left.sample('after owner disposal')
  await world.right.sample('after owner disposal')
  await sessions.flush(world.agent.session)
  assert.deepEqual(await readSession(), events, 'disposed subscriptions cannot append new Session input')
  assert.deepEqual(await schedule.history({ id: world.task.id, limit: 10 }), history)
  assert.equal(world.adapter.requests.length, 1)
  await world.left.dispose()
  await assert.rejects(() => world.left.sample('closed source'), SourceError)
} finally {
  await ctx.fiber.dispose()
}

const backend = new JsonStorageBackend(join(process.cwd(), 'storage'))
try {
  const unit = await backend.kv.open(descriptorOf(scheduleDomain))
  try {
    const saved = await unit.loadAll()
    const task = scheduleDomain.tables.tasks.valueSchema.parse(saved.tables.tasks?.[taskId])
    assert.equal(task.record.scheduledAt, '2099-01-01T00:00:00.000Z')
    assert.equal(task.status, 'active')
    assert.equal(task.lastDelivery?.messageId, receiptMessageId)
    assert.equal(task.deliveryHistory.records.length, 1)
  } finally {
    await unit.close()
  }
} finally {
  await backend.close()
}
await writeFile('source-input.txt', `${observedInput}\n`)
