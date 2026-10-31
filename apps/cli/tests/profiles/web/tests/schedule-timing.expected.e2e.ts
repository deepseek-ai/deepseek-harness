/**
 * Built CLI, public Remote requests, and persisted task files; seeded receipts are not delivery evidence.
 * Existing rows load without writes; edits keep the envelope and store the current target shape.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DailyScheduleRecord, ScheduleCatalogEntry, ScheduleTask } from '@deepseek-ai/dsh-schedule'
import { expect, it } from 'vitest'
import { withDefaultWeb, webGet, webRequest } from './default-web-process.ts'

const id = 'retained-remote-task' as DailyScheduleRecord['id']
const sessionId = 'unloaded-owner' as SessionId
const record: DailyScheduleRecord = {
  id, kind: 'daily', title: 'Retained instruction', prompt: 'Retained instruction\nwith a second line',
  time: '09:00:00.125', timeZone: 'Asia/Shanghai', scheduledAt: '2099-01-01T01:00:00.125Z',
}
const lastDelivery = {
  scheduledAt: '2026-01-01T01:00:00.125Z', deliveredAt: '2026-01-01T01:00:01.250Z', messageId: 'saved-receipt',
}
const task = {
  sessionId, record, status: 'active', lastDelivery,
  deliveryHistory: { earlierRecordsUnavailable: false, records: [{ ...lastDelivery, prompt: record.prompt }] },
}
const source = `${JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { [id]: task } } }, null, 2)}\n`
const sourcePath = (root: string) => join(root, 'home', 'storages', 'schedule.json')
const receipt = { ...lastDelivery, targetSessionId: sessionId }
const historyRequest = { request: { id, limit: 20 } }
const expectedHistory = {
  ok: true,
  value: {
    id, records: [{ ...receipt, prompt: record.prompt }], earlierRecordsUnavailable: false,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  },
}

/** Catalog entry retains the stored daily rule and has no invented creation or change times. */
const retainedEntry = (title: string) => expect.objectContaining({
  id, title, prompt: record.prompt, scheduledAt: record.scheduledAt, target: { kind: 'session', sessionId },
  involvedSessionIds: [sessionId], status: 'active', lastDelivery: receipt,
  kind: 'daily', time: record.time, timeZone: record.timeZone,
}) as object

/** Seed the existing domain or the exact bytes a preceding Host edited. */
async function seed(root: string, bytes = source): Promise<void> {
  await mkdir(join(root, 'home', 'storages'), { recursive: true })
  await writeFile(sourcePath(root), bytes)
}

async function readStore(root: string): Promise<string> {
  return readFile(sourcePath(root), 'utf8')
}

async function connect(url: string, signal: AbortSignal) {
  const auth = await webGet(url, signal)
  const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Owned Web process did not issue its authentication cookie')
  return async (method: string, args: Record<string, unknown>) => {
    const rpcId = randomUUID()
    const response = await webRequest(new URL(`/api/${method}`, url), signal, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    expect(response.status, response.text).toBe(200)
    const envelope = JSON.parse(response.text) as { type?: unknown; rpcId?: unknown; result?: unknown }
    expect(envelope).toMatchObject({ type: 'server-response', rpcId })
    return envelope.result
  }
}

it('edits an existing task through built Remote bindings and keeps its identity and seeded history after cold startup', async (test) => {
  let persisted: string | undefined
  let renamed: ScheduleCatalogEntry | undefined
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    const catalog = await rpc('schedule/catalog', {})
    expect(catalog).toEqual({ ok: true, value: [retainedEntry(record.title)] })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
    const { value: [retained] } = catalog as { value: ScheduleCatalogEntry[] }
    const rename = {
      request: { id, action: 'update', patch: { title: 'Renamed instruction' }, expectedUpdatedAt: retained?.updatedAt ?? null },
    }
    const edited = await rpc('schedule/edit', rename)
    expect(edited).toEqual({ ok: true, value: retainedEntry('Renamed instruction') })
    renamed = (edited as { value: ScheduleCatalogEntry }).value
    persisted = await readStore(root)
    const document = storedUnit(persisted)
    expect(document.unit).toEqual({ name: 'schedule', version: 2 })
    expect(document.global).toBeNull()
    expect(document.tables.tasks[id]!).toMatchObject({ record: { ...record, title: 'Renamed instruction' },
      target: { kind: 'session', sessionId }, status: 'active', updatedAt: renamed.updatedAt, lastDelivery: receipt })
    expect(document.tables.tasks[id]!).not.toHaveProperty('sessionId')
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)

    expect(await rpc('schedule/edit', rename)).toEqual({ ok: true, value: { id, code: 'schedule_conflict' } })
    expect(await rpc('schedule/edit', { request: { id: 'missing-task', action: 'delete' } }))
      .toEqual({ ok: true, value: { id: 'missing-task', code: 'schedule_not_found' } })
    expect(await readStore(root)).toEqual(persisted)
  }, { prepare: root => seed(root) })

  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    expect(await rpc('schedule/catalog', {})).toEqual({ ok: true, value: [renamed] })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
    expect(await readStore(root)).toEqual(persisted)
    await rpc('session/create', { request: { sessionId, cwd: root } })
    const rrule = 'DTSTART;TZID=Asia/Shanghai:20990101T090000\nRRULE:FREQ=DAILY'
    const replaced = await rpc('schedule/edit', {
      request: { id, action: 'update', patch: { timing: { kind: 'rrule', rrule } }, expectedUpdatedAt: renamed?.updatedAt },
    })
    expect(replaced).toEqual({
      ok: true, value: expect.objectContaining({ id, title: 'Renamed instruction', scheduledAt: '2099-01-01T01:00:00.000Z' }) as object,
    })
    const stored = storedUnit(await readStore(root)).tables.tasks[id]!
    expect(stored.record).toMatchObject({ kind: 'rrule', rrule })
    expect(stored).not.toHaveProperty('sessionId')
    expect(stored).toMatchObject({ target: { kind: 'session', sessionId }, lastDelivery: receipt })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
  }, { prepare: root => seed(root, persisted) })
})

it('creates and idempotently adopts the explicit Session id bound to existing task data without touching its task files', async (test) => {
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    // A Schedule request waits for startup to validate the task store.
    const view = await rpc('schedule/view', { request: { id } })
    expect(view).toEqual({ ok: true, value: retainedEntry(record.title) })
    const retained = await readStore(root)
    const create = { request: { sessionId, cwd: root } }
    const expectedCreate = { ok: true, value: { sessionId, agentPreset: 'standard' } }
    expect(await rpc('session/create', create)).toEqual(expectedCreate)
    expect(await rpc('session/create', create)).toEqual(expectedCreate)
    expect(await rpc('schedule/view', { request: { id } })).toEqual(view)
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
    expect(await readStore(root)).toEqual(retained)
    expect(await readFile(sourcePath(root), 'utf8')).toBe(source)
  }, { prepare: root => seed(root) })
})

/** Read test-owned output without normalizing away the fields asserted below. */
function storedUnit(text: string): {
  readonly unit: unknown
  readonly global: unknown
  readonly tables: { readonly tasks: Record<string, ScheduleTask> }
} {
  return JSON.parse(text) as {
    unit: unknown
    global: unknown
    tables: { tasks: Record<string, ScheduleTask> }
  }
}
