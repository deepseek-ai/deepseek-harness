/** Snapshot collection observes real backend logs without taking writer ownership. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '@deepseek-ai/dsh-session-persistence-jsonl'
import { collectSessionLogs } from '../src/persistence.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-collect-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(plugin, { root, compression: 'none' })
  return ctx
}

it('collects the complete fork history while the parent remains owned', async () => {
  const ctx = await fixture(), store = ctx.sessionPersistence
  expect(await collectSessionLogs(store)).toEqual([])
  const parent = await store.create({ version: SESSION_FORMAT_VERSION, id: SessionId('parent'), createdAt: 1, isSeeded: false })
  const prefix = [
    { type: 'turn/start' as const, seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    { type: 'turn/end' as const, seq: SessionSeq(1), time: 0, data: { turn: 1, reason: { kind: 'completed' as const } } },
  ]
  await parent.append(prefix)
  const childWriter = await store.create({ version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 2,
    isSeeded: true, origin: 'subagent', parentSession: parent.id }, { inheritedEventCount: SessionLogOffset(2) })
  try {
    await childWriter.append([...prefix, { type: 'session/end-seed', seq: SessionSeq(2), time: 0, data: { inherited: true } }])
  } finally { await childWriter.close() }
  const logs = await collectSessionLogs(store)
  expect(logs.map(log => log.id).sort()).toEqual(['child', 'parent'])
  const child = logs.find(log => log.id === 'child')
  expect(child?.parentSession).toBe(parent.id)
  const rows = child!.content.trimEnd().split('\n').map((line) => {
    const row: unknown = JSON.parse(line)
    return row
  })
  expect(rows[0]).toMatchObject({ type: 'session', version: SESSION_FORMAT_VERSION, isSeeded: true, origin: 'subagent' })
  expect(rows.slice(1)).toEqual([...prefix, { type: 'session/end-seed', seq: 2, time: 0, data: { inherited: true } }])
  await parent.append([{ type: 'turn/start', seq: SessionSeq(2), time: 0, data: { turn: 2 } }])
  expect((await collectSessionLogs(store)).find(log => log.id === 'child')?.content).toBe(child?.content)
  await parent.close()
})

it('closes the observational handle when its body read rejects', async () => {
  const ctx = await fixture(), store = ctx.sessionPersistence
  const writer = await store.create({ version: SESSION_FORMAT_VERSION, id: SessionId('failure'), createdAt: 1, isSeeded: false })
  await writer.flush()
  const reader = await store.open(writer.id, 'read')
  const failure = new Error('body read failed')
  const read = vi.spyOn(reader, 'read').mockRejectedValue(failure)
  const close = vi.spyOn(reader, 'close')
  const optionalDepth = new Proxy(reader, {
    get(target, key, receiver) {
      if (key === 'header') return { ...target.header, delegationDepth: undefined }
      const value: unknown = Reflect.get(target, key, receiver)
      return value
    },
  })
  const opening = vi.spyOn(store, 'open').mockResolvedValue(optionalDepth)
  try {
    await expect(collectSessionLogs(store)).rejects.toBe(failure)
    expect(opening).toHaveBeenCalledWith(writer.id, 'read')
    expect(close).toHaveBeenCalledOnce()
  } finally { read.mockRestore(); close.mockRestore(); opening.mockRestore(); await reader.close(); await writer.close() }
})
