/** A malformed whole-unit document must refuse the Schedule domain instead of opening it empty. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { scheduleDomain } from '../src/storage.ts'
import { ScheduleId, createAtScheduleRecord } from '../src/domain.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function open(root: string) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  return { facility, backend }
}

it('refuses an array-shaped tables map instead of opening an empty task catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-malformed-')); roots.push(root)
  const path = join(root, 'schedule.json')
  const task = {
    sessionId: 'session-1',
    record: createAtScheduleRecord(ScheduleId('kept'), 'Keep me', '2099-01-01T00:00:00.000Z', 0, 'Keep me'),
    status: 'active',
  }
  // An array is `typeof 'object'`: an empty-domain read would let the first
  // write republish this file without the task it could not see.
  const text = `${JSON.stringify({
    unit: { name: 'schedule', version: 1 },
    global: null,
    tables: [{ tasks: { kept: task } }],
  }, null, 2)}\n`
  await writeFile(path, text, 'utf8')

  const { facility, backend } = await open(root)
  await expect(facility.open(scheduleDomain)).rejects.toMatchObject({ code: 'malformed-medium' })
  expect(await readFile(path, 'utf8')).toBe(text)
  await backend.close()
})
