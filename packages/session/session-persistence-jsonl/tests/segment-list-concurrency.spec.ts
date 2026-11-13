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
  await ctx.plugin(persistence, { storage: 'sqlite', root, compression: 'none', listConcurrency: 2 })
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId(`route-${ordinal}`), createdAt: ordinal, isSeeded: false,
    })
    await handle.flush(); await handle.close()
  }
  return { ctx, directory: join(root, '.segments') }
}

it('shares the configured read limit across simultaneous routed lists', async () => {
  const { ctx, directory } = await fixture()
  const release = Promise.withResolvers<undefined>()
  let active = 0, peak = 0, reads = 0
  interception.read = async (path, next) => {
    if (!path.startsWith(directory) || !path.endsWith('.json')) return next()
    active++; reads++; peak = Math.max(peak, active)
    try { await release.promise; return await next() } finally { active-- }
  }
  const first = ctx.sessionPersistence.list()
  let second: ReturnType<typeof ctx.sessionPersistence.list> | undefined
  try {
    await vi.waitFor(() => { expect(reads).toBeGreaterThanOrEqual(2) })
    second = ctx.sessionPersistence.list()
    expect(active).toBe(2)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([first, ...second === undefined ? [] : [second]])
  }
  expect(await first).toHaveLength(4)
  expect(await second).toHaveLength(4)
  expect(reads).toBe(8)
  expect(peak).toBe(2)
  expect(active).toBe(0)
})

it.each(['failure', 'cancel'] as const)('settles in-flight routing reads before reporting %s', async (mode) => {
  const { ctx, directory } = await fixture()
  const release = Promise.withResolvers<undefined>()
  const controller = new AbortController(), failure = new Error('routing read refused')
  let active = 0, reads = 0, settled = false
  interception.read = async (path, next) => {
    if (!path.startsWith(directory) || !path.endsWith('.json')) return next()
    const ordinal = ++reads
    active++
    try {
      if (mode === 'failure' && ordinal === 1) throw failure
      await release.promise
      return await next()
    } finally { active-- }
  }
  const operation = ctx.sessionPersistence.list({ signal: controller.signal })
  const outcome = operation.then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
  try {
    await vi.waitFor(() => { expect(reads).toBeGreaterThanOrEqual(2) })
    if (mode === 'cancel') controller.abort(failure)
    expect(settled).toBe(false)
  } finally { release.resolve(undefined); await outcome }
  if (mode === 'failure') expect(await outcome).toBe(failure)
  else expect(await outcome).toMatchObject({ name: 'AbortError' })
  expect(active).toBe(0)
  expect(reads).toBe(mode === 'cancel' ? 2 : 4)
})
