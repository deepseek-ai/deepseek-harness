import { fork } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cachedMacOSSignature, type MacOSCachedSigner } from '../scripts/macos-signature-cache.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): { root: string; file: string; cache: string; signer: MacOSCachedSigner } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-signature-cache-')))
  roots.push(root)
  const file = join(root, 'code')
  writeFileSync(file, 'original', { mode: 0o755 })
  return { root, file, cache: join(root, 'cache'), signer: {
    policy: 'certificate+identifier+entitlements+tools',
    sign: vi.fn(async (path: string) => { writeFileSync(path, `${readFileSync(path, 'utf8')}:signed`) }),
    verify: vi.fn((path: string) => { if (!readFileSync(path, 'utf8').endsWith(':signed')) throw Error('invalid signature') }),
  } }
}
it('reuses verified bytes without sharing mutable cache storage', async () => {
  const { file, cache, signer } = fixture()
  expect(await cachedMacOSSignature(file, cache, signer)).toBe(false)
  writeFileSync(file, 'original')
  expect(await cachedMacOSSignature(file, cache, signer)).toBe(true)
  expect(signer.sign).toHaveBeenCalledTimes(1)
  expect(signer.verify).toHaveBeenCalledTimes(2)
  expect(readFileSync(file, 'utf8')).toBe('original:signed')
  if (process.platform !== 'win32') expect(lstatSync(file).mode & 0o777).toBe(0o755)
  writeFileSync(file, 'later mutation')
  writeFileSync(file, 'original')
  expect(await cachedMacOSSignature(file, cache, signer)).toBe(true)
})
it.each(['input', 'policy', 'mode'])('invalidates changed %s without consulting git', async (change) => {
  const { file, cache, signer } = fixture()
  await cachedMacOSSignature(file, cache, signer)
  writeFileSync(file, change === 'input' ? 'uncommitted' : 'original')
  if (change === 'mode') {
    if (process.platform === 'win32') return
    chmodSync(file, 0o644)
  }
  expect(await cachedMacOSSignature(file, cache, change === 'policy' ? { ...signer, policy: 'new-policy' } : signer)).toBe(false)
  expect(signer.sign).toHaveBeenCalledTimes(2)
})
it.each(['payload', 'record', 'signature'])('rejects corrupted %s without replacing the input', async (damage) => {
  const { file, cache, signer } = fixture()
  await cachedMacOSSignature(file, cache, signer)
  writeFileSync(file, 'original')
  const entry = join(cache, readdirSync(cache)[0]!)
  if (damage === 'payload') writeFileSync(join(entry, 'code'), 'truncated')
  if (damage === 'record') writeFileSync(join(entry, 'record.json'), '{"key":"wrong"}')
  if (damage === 'signature') signer.verify = () => { throw Error('invalid signature') }
  await expect(cachedMacOSSignature(file, cache, signer)).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe('original')
})
it('never publishes or replaces input after signing fails', async () => {
  const { file, cache, signer } = fixture()
  signer.sign = async () => { throw Error('interrupted signing') }
  await expect(cachedMacOSSignature(file, cache, signer)).rejects.toThrow('interrupted')
  expect(readFileSync(file, 'utf8')).toBe('original')
  expect(readdirSync(cache)).toEqual([])
})
it('rejects a concurrently changed target', async () => {
  const { file, cache, signer } = fixture()
  const sign = signer.sign
  signer.sign = async (candidate) => { await sign(candidate); writeFileSync(file, 'concurrent edit') }
  await expect(cachedMacOSSignature(file, cache, signer)).rejects.toThrow('input changed')
  expect(readFileSync(file, 'utf8')).toBe('concurrent edit')
  expect(readdirSync(cache)).toEqual([])
})
it.skipIf(process.platform === 'win32')('allows competing writers to publish only complete entries', async () => {
  const { root, file, cache, signer } = fixture()
  const second = join(root, 'other')
  writeFileSync(second, 'original', { mode: 0o755 })
  let ready!: () => void
  const both = new Promise<void>((resolve) => { ready = resolve })
  let count = 0
  const sign = signer.sign
  signer.sign = async (path) => { if (++count === 2) ready(); await both; await sign(path) }
  await Promise.all([cachedMacOSSignature(file, cache, signer), cachedMacOSSignature(second, cache, signer)])
  expect(readdirSync(cache)).toHaveLength(1)
  expect(readFileSync(file, 'utf8')).toBe('original:signed')
  expect(readFileSync(second, 'utf8')).toBe('original:signed')
  writeFileSync(file, 'original')
  expect(await cachedMacOSSignature(file, cache, signer)).toBe(true)
})
it.skipIf(process.platform === 'win32')('rejects links in the target and cache ancestry', async () => {
  const { root, file, cache, signer } = fixture()
  const link = join(root, 'link')
  symlinkSync(file, link)
  await expect(cachedMacOSSignature(link, cache, signer)).rejects.toThrow('regular file')
  const real = join(root, 'real')
  mkdirSync(real)
  symlinkSync(real, cache)
  await expect(cachedMacOSSignature(file, join(cache, 'nested'), signer)).rejects.toThrow('directory')
  expect(existsSync(join(real, 'nested'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('publishes reusable entries across independent processes', async () => {
  const { root, file, cache } = fixture()
  const second = join(root, 'second')
  writeFileSync(second, 'original', { mode: 0o755 })
  // Windows directory replacement uses different errors; this cache is owned by macOS packaging.
  const children: ReturnType<typeof fork>[] = []
  const exits: Promise<[number | null, NodeJS.Signals | null]>[] = []
  try {
    for (const path of [file, second]) {
      const child = fork(join(import.meta.dirname, 'fixtures/macos-cache-writer.mjs'), [path, cache], {
        execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      children.push(child)
      exits.push(new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => { resolve([code, signal]) })
      }))
    }
    await Promise.all(children.map((child, index) => Promise.race([once(child, 'message'), exits[index]!.then(() => { throw Error('cache writer exited before ready') })])))
    for (const child of children) child.send('continue')
    for (const [code, signal] of await Promise.all(exits)) {
      expect(signal).toBeNull()
      expect(code).toBe(0)
    }
    expect(readdirSync(cache)).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe('original:signed')
    expect(readFileSync(second, 'utf8')).toBe('original:signed')
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.allSettled(exits)
  }
})

it('rejects candidate mutation during verification', async () => {
  const { file, cache, signer } = fixture()
  signer.verify = (candidate) => { writeFileSync(candidate, 'mutated') }
  await expect(cachedMacOSSignature(file, cache, signer)).rejects.toThrow('candidate changed')
  expect(readFileSync(file, 'utf8')).toBe('original')
  expect(readdirSync(cache)).toEqual([])
})
