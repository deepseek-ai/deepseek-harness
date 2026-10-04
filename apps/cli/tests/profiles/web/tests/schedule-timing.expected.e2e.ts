/** Built CLI, public Remote requests, and persisted task files; seeded receipts are not delivery evidence. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DailyScheduleRecord, ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import { expect, it } from 'vitest'
import { withDefaultWeb, webGet, webRequest } from './default-web-process.ts'

const id = 'retained-remote-task' as DailyScheduleRecord['id']
const sessionId = 'unloaded-owner' as ScheduleCatalogEntry['sessionId']
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
const taskPath = (root: string) => join(root, 'home', 'storages', 'schedule.json')

async function seed(root: string, bytes: string): Promise<void> {
  await mkdir(join(root, 'home', 'storages'), { recursive: true })
  await writeFile(taskPath(root), bytes)
}

function encoded(value: unknown): string {
  return `${JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks: { [id]: value } } }, null, 2)}\n`
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

it('edits a retained task through built Remote bindings and preserves its identity and seeded history after cold startup', async (test) => {
  let persisted = encoded(task)
  let updated = record
  const historyRequest = { request: { sessionId, id, limit: 20 } }
  const expectedHistory = {
    ok: true,
    value: {
      id, records: task.deliveryHistory.records, earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    },
  }
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    expect(await rpc('schedule/catalog', {})).toEqual({ ok: true, value: [{ ...record, sessionId, status: 'active', lastDelivery }] })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
    const target = new Date(Date.now() + 12 * 60 * 60 * 1_000)
    target.setUTCMilliseconds(125)
    updated = { ...record, time: target.toISOString().slice(11, 23), timeZone: 'UTC', scheduledAt: target.toISOString() }
    const change = { kind: 'daily', daily: { time: updated.time, time_zone: 'UTC' } }
    expect(await rpc('schedule/update', { request: { sessionId, id, expected: record, change } }))
      .toEqual({ ok: true, value: { id, updated: true, record: updated } })
    persisted = await readFile(taskPath(root), 'utf8')
    expect(JSON.parse(persisted)).toEqual({
      unit: { name: 'schedule', version: 1 },
      global: null,
      tables: { tasks: { [id]: { ...task, record: updated } } },
    })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)

    expect(await rpc('schedule/update', { request: { sessionId, id, expected: record, change } }))
      .toEqual({ ok: true, value: { id, updated: false, code: 'schedule_conflict' } })
    expect(await rpc('schedule/update', { request: { sessionId: 'other-owner', id, expected: updated, change } }))
      .toEqual({ ok: true, value: { id, updated: false, code: 'schedule_not_found' } })
    expect(await readFile(taskPath(root), 'utf8')).toBe(persisted)
  }, { prepare: root => seed(root, persisted) })

  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    expect(await rpc('schedule/catalog', {})).toEqual({ ok: true, value: [{ ...updated, sessionId, status: 'active', lastDelivery }] })
    expect(await rpc('schedule/history', historyRequest)).toEqual(expectedHistory)
    expect(await rpc('schedule/update', { request: {
      sessionId, id, expected: updated, change: { kind: 'daily', daily: { time: updated.time, time_zone: 'Etc/UTC' } },
    } })).toEqual({ ok: true, value: { id, updated: false, record: updated } })
    expect(await readFile(taskPath(root), 'utf8')).toBe(persisted)
  }, { prepare: root => seed(root, persisted) })
})

it('creates and idempotently adopts the explicit Session id bound to seeded task data without touching its task file', async (test) => {
  const persisted = encoded(task)
  const expectedList = { ok: true, value: [record] }
  const expectedHistory = {
    ok: true,
    value: {
      id, records: task.deliveryHistory.records, earlierRecordsUnavailable: false,
      earlierRecordsPruned: false, retention: { days: 30, records: 200 },
    },
  }
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    const create = { request: { sessionId, cwd: root } }
    const expectedCreate = { ok: true, value: { sessionId, agentPreset: 'standard' } }
    expect(await rpc('session/create', create)).toEqual(expectedCreate)
    expect(await rpc('session/create', create)).toEqual(expectedCreate)
    expect(await rpc('schedule/list', { request: { sessionId } })).toEqual(expectedList)
    expect(await rpc('schedule/history', { request: { sessionId, id, limit: 20 } })).toEqual(expectedHistory)
    expect(await readFile(taskPath(root), 'utf8')).toBe(persisted)
  }, { prepare: root => seed(root, persisted) })
})
