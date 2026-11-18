/** Routing scans share JSONL's filesystem budget and settle before returning. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as persistence from '../src/index.ts'

const interception = vi.hoisted(() => ({
  read: undefined as ((path: string, next: () => Promise<string | Buffer>) => Promise<string | Buffer>) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    const next = () => actual.readFile(...args)
    return interception.read === undefined || typeof args[0] !== 'string'
      ? next() : interception.read(args[0], next)
  } }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-route-list-concurrency-'))
  const ctx = new Context()
  onTestFinished(async () => {
    interception.read = undefined
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(persistence, { root, compression: 'none', listConcurrency: 2 })
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId(`route-${ordinal}`), createdAt: ordinal, isSeeded: false,
    })
    await handle.flush(); await handle.close()
  }
  return { ctx, directory: join(root, '.segments') }
}

it('lists concurrent Session snapshots without reading per-Session routing records', async () => {
  const { ctx, directory } = await fixture()
  let reads = 0
  interception.read = async (path, next) => {
    if (path.startsWith(directory) && path.endsWith('.json')) reads++
    return next()
  }
  const results = await Promise.all([ctx.sessionPersistence.list(), ctx.sessionPersistence.list()])
  for (const entries of results) expect(entries).toHaveLength(4)
  expect(reads).toBe(0)
})
