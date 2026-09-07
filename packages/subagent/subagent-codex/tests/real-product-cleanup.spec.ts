import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { cleanupRealProduct } from './real-product-cleanup.ts'

it.each(['context', 'HTTP fixture'] as const)('attributes %s cleanup failures without losing the cause', async (stage) => {
  const cause = new Error('fixture failure')
  const fail = (): Promise<void> => Promise.reject(cause)
  await expect(cleanupRealProduct({
    contexts: stage === 'context' ? [{ fiber: { dispose: fail } }] : [],
    fixtures: stage === 'HTTP fixture' ? [{ close: fail }] : [],
    roots: [],
  })).rejects.toMatchObject({
    message: stage === 'context'
      ? 'Codex test context disposal failed'
      : 'Codex test HTTP fixture closure failed',
    cause,
  })
})

it('attributes root removal failures to the owned path', async () => {
  const root = 'invalid\0root'
  await expect(cleanupRealProduct({ contexts: [], fixtures: [], roots: [root] }))
    .rejects.toMatchObject({
      message: `Codex test temporary root removal failed: ${root}`,
      cause: { code: 'ERR_INVALID_ARG_VALUE' },
    })
})

it('closes its real HTTP server and removes its root after context disposal rejects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-rejected-'))
  const server = createServer()
  const close = (): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const cause = new Error('context disposal failed')
    await expect(cleanupRealProduct({
      contexts: [{ fiber: { dispose: () => Promise.reject(cause) } }],
      fixtures: [{ close }],
      roots: [root],
    })).rejects.toMatchObject({ cause })
    expect(server.listening).toBe(false)
    expect(existsSync(root)).toBe(false)
  } finally {
    if (server.listening) await close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

it('removes sibling roots after an earlier root removal fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-sibling-'))
  try {
    await expect(cleanupRealProduct({ contexts: [], fixtures: [], roots: ['invalid\0root', root] }))
      .rejects.toHaveProperty('cause.code', 'ERR_INVALID_ARG_VALUE')
    expect(existsSync(root)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

it.each(['context', 'HTTP fixture'] as const)('joins pending %s cleanup after a sibling rejects', async (stage) => {
  const release = Promise.withResolvers<undefined>()
  const cause = new Error('sibling cleanup failed')
  const fail = (): Promise<void> => Promise.reject(cause)
  const pending = (): Promise<undefined> => release.promise
  const laterFixture = vi.fn(async () => {})
  let settled = false
  const cleanup = cleanupRealProduct({
    contexts: stage === 'context' ? [{ fiber: { dispose: fail } }, { fiber: { dispose: pending } }] : [],
    fixtures: stage === 'context' ? [{ close: laterFixture }] : [{ close: fail }, { close: pending }],
    roots: [],
  }).catch((error: unknown) => {
    settled = true
    return error
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(laterFixture).not.toHaveBeenCalled()
    release.resolve(undefined)
    await expect(cleanup).resolves.toMatchObject({ cause })
    if (stage === 'context') expect(laterFixture).toHaveBeenCalledOnce()
  } finally {
    release.resolve(undefined)
    await cleanup
  }
})

it('reports failures from every cleanup stage together', async () => {
  const contextCause = new Error('context failed')
  const fixtureCause = new Error('fixture failed')
  await expect(cleanupRealProduct({
    contexts: [{ fiber: { dispose: () => { throw contextCause } } }],
    fixtures: [{ close: () => { throw fixtureCause } }],
    roots: ['invalid\0root'],
  })).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [
      { message: 'Codex test context disposal failed', cause: contextCause },
      { message: 'Codex test HTTP fixture closure failed', cause: fixtureCause },
      { cause: { code: 'ERR_INVALID_ARG_VALUE' } },
    ],
  })
})

it('keeps resources registered during pending cleanup for their own cleanup', async () => {
  const oldRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-old-'))
  const nextRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-next-'))
  const releaseContext = Promise.withResolvers<undefined>()
  const oldContext = { fiber: { dispose: vi.fn(() => releaseContext.promise) } }
  const nextContext = { fiber: { dispose: vi.fn(async () => {}) } }
  const oldFixture = { close: vi.fn(async () => {
    expect(existsSync(oldRoot)).toBe(true)
  }) }
  const nextFixture = { close: vi.fn(async () => {}) }
  const resources: Parameters<typeof cleanupRealProduct>[0] = {
    contexts: [oldContext], fixtures: [oldFixture], roots: [oldRoot],
  }
  const cleanup = cleanupRealProduct(resources)
  try {
    expect(oldContext.fiber.dispose).toHaveBeenCalledOnce()
    expect(oldFixture.close).not.toHaveBeenCalled()
    resources.contexts.push(nextContext)
    resources.fixtures.push(nextFixture)
    resources.roots.push(nextRoot)
    releaseContext.resolve(undefined)
    await cleanup

    expect(oldFixture.close).toHaveBeenCalledOnce()
    expect(existsSync(oldRoot)).toBe(false)
    expect(nextContext.fiber.dispose).not.toHaveBeenCalled()
    expect(nextFixture.close).not.toHaveBeenCalled()
    expect(existsSync(nextRoot)).toBe(true)
    expect(resources).toEqual({ contexts: [nextContext], fixtures: [nextFixture], roots: [nextRoot] })

    await cleanupRealProduct(resources)
    expect(nextContext.fiber.dispose).toHaveBeenCalledOnce()
    expect(nextFixture.close).toHaveBeenCalledOnce()
    expect(existsSync(nextRoot)).toBe(false)
    expect(resources).toEqual({ contexts: [], fixtures: [], roots: [] })
  } finally {
    releaseContext.resolve(undefined)
    await cleanup
    rmSync(oldRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(nextRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
