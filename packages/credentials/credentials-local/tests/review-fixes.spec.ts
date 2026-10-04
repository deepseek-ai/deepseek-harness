import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

const ALPHA = credentialRef('DSH_REVIEW_ALPHA')
const BETA = credentialRef('DSH_REVIEW_BETA')
const INNER = credentialRef('DSH_REVIEW_INNER')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-review-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('read-modify-write', () => {
  it('folds an unobserved external edit into a write instead of overwriting it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const seen: string[] = []
    ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
    await ctx.credentials.set(ALPHA, 'one')
    // The external edit has landed on disk but no watcher reported it (watch
    // is off — the same blind spot as a debounce window or a missed event).
    await writeCredentials(path, `version: 1\nrefs:\n  ${ALPHA}: one\n  ${BETA}: external\n`)
    await ctx.credentials.set(ALPHA, 'two')
    const text = await readFile(path, 'utf8')
    expect(text).toContain(`${BETA}: external`)
    expect(text).toContain(`${ALPHA}: two`)
    // The fold published the unobserved entry before the write's own commit.
    expect(seen).toEqual([ALPHA, BETA, ALPHA])
    expect(await ctx.credentials.resolve(BETA)).toEqual({ value: 'external', source: 'file' })
  })

  it('keeps both refs when two providers write the same document concurrently', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })
    await Promise.all([
      (async () => { for (const value of ['1', '2', '3'] as const) await first.credentials.set(ALPHA, value) })(),
      (async () => { for (const value of ['1', '2', '3'] as const) await second.credentials.set(BETA, value) })(),
    ])
    const third = await boot({ path, watch: false })
    expect(await third.credentials.resolve(ALPHA)).toEqual({ value: '3', source: 'file' })
    expect(await third.credentials.resolve(BETA)).toEqual({ value: '3', source: 'file' })
  })

  it('creates the credentials directory owner-only', async () => {
    const dir = await tempDir()
    const home = join(dir, 'home')
    const ctx = await boot({ path: join(home, '.credentials.yaml'), watch: false })
    await ctx.credentials.set(ALPHA, 'one')
    if (process.platform !== 'win32') expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it('holds every writer of the document to the record-mutation lock wait', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const holder = await boot({ path, watch: false })
    const contender = await boot({ path, watch: false })
    const doomed = credentialKey('llm-pi-ai', 'doomed')
    const slowKey = credentialKey('llm-pi-ai', 'slow')
    await holder.credentials.modifyRecord(doomed, () => Promise.resolve({ kind: 'api-key', key: 'x' }))
    const entered = Promise.withResolvers<undefined>()
    // The mutation holds the cross-process writer lock across a stand-in for
    // an OAuth refresh round trip — longer than withFileLock's 2s default.
    const slow = holder.credentials.modifyRecord(slowKey, async () => {
      entered.resolve(undefined)
      await new Promise(resolve => setTimeout(resolve, 2_400))
      return { kind: 'api-key', key: 'slow' }
    })
    await entered.promise
    // The other two writer paths — a reference write and a record delete —
    // share that file and that lock, so they must wait the refresh out rather
    // than fail at the file-work default.
    await Promise.all([
      contender.credentials.set(ALPHA, 'waited'),
      contender.credentials.deleteRecord(doomed),
    ])
    await slow
    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.resolve(ALPHA)).toEqual({ value: 'waited', source: 'file' })
    expect(await reread.credentials.readRecord(doomed)).toBeUndefined()
    expect(await reread.credentials.readRecord(slowKey)).toEqual({ kind: 'api-key', key: 'slow' })
  })
})

describe('contained update fan-out', () => {
  it('does not fail a committed set when a listener throws, and later listeners still run', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    ctx.on('credentials/reference-updated', () => {
      throw new Error('observer boom')
    })
    const second = vi.fn()
    ctx.on('credentials/reference-updated', second)
    await expect(ctx.credentials.set(ALPHA, 'one')).resolves.toBeUndefined()
    expect(second).toHaveBeenCalledWith(ALPHA)
    expect(await ctx.credentials.resolve(ALPHA)).toEqual({ value: 'one', source: 'file' })
  })

  it('contains an async listener rejection', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    // An unknown-returning function keeps the typed surface legal while the
    // runtime value is still the rejected promise the containment must handle.
    const boom = (): unknown => Promise.reject(new Error('async observer boom'))
    ctx.on('credentials/reference-updated', boom)
    await expect(ctx.credentials.set(ALPHA, 'one')).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

})

describe('document editor', () => {
  it('leaves a sibling multi-line value untouched while patching one entry', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const wrapped = `version: 1\nrefs:\n  DSH_REVIEW_WRAPPED: |-\n    line1\n    line2\n  ${ALPHA}: a\n`
    await writeCredentials(path, wrapped)
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(ALPHA, 'b')
    expect(await readFile(path, 'utf8'))
      .toBe(`version: 1\nrefs:\n  DSH_REVIEW_WRAPPED: |-\n    line1\n    line2\n  ${ALPHA}: b\n`)
    expect(await ctx.credentials.resolve(credentialRef('DSH_REVIEW_WRAPPED')))
      .toEqual({ value: 'line1\nline2', source: 'file' })
  })

  it('stores a value that looks like another entry without creating one', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    // The stored text must stay a value: a quoted-scalar write that leaked its
    // own structure would silently mint a credential nobody stored.
    await ctx.credentials.set(ALPHA, `${INNER}: injected`)
    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.resolve(ALPHA)).toEqual({ value: `${INNER}: injected`, source: 'file' })
    expect(await reread.credentials.resolve(INNER)).toBeUndefined()
  })
})
