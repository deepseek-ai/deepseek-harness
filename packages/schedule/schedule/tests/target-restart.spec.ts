/** Real JSON task files keep Host tasks of every target kind across Host restarts without a Session owner. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { harness, storedUnit } from './harness.ts'

const contexts: Context[] = []
const roots: string[] = []
const NOW = '2026-09-16T00:00:00.000Z'
const RRULE = 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY'
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('reopens Host tasks of every target kind byte-identical without activating a Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-targets-'))
  roots.push(root)
  const setup = () => harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  const first = await setup()
  const owner = SessionId('restart-owner')
  const created = [
    await first.service.remoteCreate({
      title: 'Existing', prompt: 'Check state', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'session', sessionId: owner },
    }),
    await first.service.remoteCreate({
      title: 'Once', prompt: 'Check once', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'new_once', create: { cwd: '/work' } },
    }),
    await first.service.remoteCreate({
      title: 'Every run', prompt: 'Check each', timing: { kind: 'rrule', rrule: RRULE }, target: { kind: 'new', create: { agentPreset: 'reviewer' } },
    }),
  ]
  expect(await readdir(root)).toEqual(['schedule.json'])
  const file = join(root, 'schedule.json')
  const bytes = await readFile(file, 'utf8')
  const document = storedUnit(bytes)
  expect(document.unit).toEqual({ name: 'schedule', version: 2 })
  expect(document.global).toBeNull()
  expect(Object.keys(document.tables.tasks).sort()).toEqual(created.map(entry => entry.id).sort())
  for (const entry of created) {
    const { target, involvedSessionIds, status, createdAt, updatedAt, ...record } = entry
    expect(document.tables.tasks[entry.id]).toEqual({
      record, target, involvedSessionIds, status, createdAt, updatedAt,
      deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
    })
  }
  expect(created.map(entry => entry.target.kind)).toEqual(['session', 'new_once', 'new'])
  await first.ctx.fiber.dispose()

  const second = await setup()
  for (const entry of created) expect(await second.service.view({ id: entry.id })).toEqual(entry)
  expect((await second.service.list({})).total).toBe(3)
  expect(second.resolve).not.toHaveBeenCalled()
  expect(second.createSession).not.toHaveBeenCalled()
  expect(second.stat).not.toHaveBeenCalled()
  await second.ctx.fiber.dispose()
  expect(await readFile(file, 'utf8')).toBe(bytes)
})
