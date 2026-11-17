/** Corpus preparation touches only private copies; public signature inspection is simulated. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareSigningCorpus } from './helpers/windows-signing-corpus.ts'
import { inspectWindowsRuntimeSignature } from '../scripts/windows-runtime-signature.mjs'

vi.mock('../scripts/windows-runtime-signature.mjs', () => ({ inspectWindowsRuntimeSignature: vi.fn() }))
let root: string
let source: string
let manifest: string
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'signing-corpus-'))
  source = join(root, 'original.dll')
  manifest = join(root, 'manifest.json')
  await writeFile(source, 'signed original')
  await writeFile(manifest, JSON.stringify([{ path: source, sha256: digest('signed original') }]))
  vi.mocked(inspectWindowsRuntimeSignature).mockResolvedValue({ status: 'NotSigned', timestamped: false, thumbprint: null })
})
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }) })

it('strips only a pinned private copy and preserves the original bytes', async () => {
  vi.mocked(inspectWindowsRuntimeSignature).mockResolvedValueOnce({ status: 'Valid', timestamped: true, thumbprint: 'A' })
  const remove = vi.fn(async (path: string) => { expect(path).not.toBe(source); await writeFile(path, 'unsigned copy') })
  const files = await prepareSigningCorpus(manifest, join(root, 'copies'), remove, new AbortController().signal)
  expect(remove).toHaveBeenCalledOnce()
  expect(files).toEqual([{ path: join(root, 'copies', '0.dll'), sha256: digest('unsigned copy'), bytes: 13 }])
  expect(await readFile(source, 'utf8')).toBe('signed original')
})

it('accepts already unsigned input without invoking removal', async () => {
  const remove = vi.fn()
  const files = await prepareSigningCorpus(manifest, join(root, 'copies'), remove, new AbortController().signal)
  expect(remove).not.toHaveBeenCalled()
  expect(files[0]?.sha256).toBe(digest('signed original'))
})

it.each([[], {}, [{ path: 'relative', sha256: 'a'.repeat(64) }], [{ path: 'ignored', sha256: 'invalid' }]])('rejects malformed manifest %j', async (value) => {
  await writeFile(manifest, JSON.stringify(value))
  const remove = vi.fn()
  await expect(prepareSigningCorpus(manifest, join(root, 'copies'), remove, new AbortController().signal)).rejects.toThrow('Signing corpus')
  expect(remove).not.toHaveBeenCalled()
})

it('rejects source content changed since the manifest was created', async () => {
  await writeFile(source, 'changed source')
  await expect(prepareSigningCorpus(manifest, join(root, 'copies'), vi.fn(), new AbortController().signal)).rejects.toThrow('pinned digest')
  expect(inspectWindowsRuntimeSignature).not.toHaveBeenCalled()
})

it.each(['HashMismatch', 'NotTrusted'])('rejects invalid source signature %s without removal', async (status) => {
  vi.mocked(inspectWindowsRuntimeSignature).mockResolvedValue({ status, timestamped: false, thumbprint: null })
  const remove = vi.fn()
  await expect(prepareSigningCorpus(manifest, join(root, 'copies'), remove, new AbortController().signal)).rejects.toThrow('invalid signature')
  expect(remove).not.toHaveBeenCalled()
})

it('rejects a copy whose signature removal did not finish', async () => {
  vi.mocked(inspectWindowsRuntimeSignature).mockResolvedValue({ status: 'Valid', timestamped: true, thumbprint: 'A' })
  await expect(prepareSigningCorpus(manifest, join(root, 'copies'), vi.fn(), new AbortController().signal)).rejects.toThrow('must be unsigned')
})

it('stops before copying after cancellation', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await expect(prepareSigningCorpus(manifest, join(root, 'copies'), vi.fn(), controller.signal)).rejects.toThrow('cancelled')
  expect(inspectWindowsRuntimeSignature).not.toHaveBeenCalled()
})
