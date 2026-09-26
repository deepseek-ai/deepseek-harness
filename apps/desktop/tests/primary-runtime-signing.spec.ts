import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { signWindowsPrimaryRuntime, signWindowsDesktopRuntime } from '../scripts/sign-primary-runtime.ts'
import { inspectWindowsRuntimeSignature, preserveWindowsRuntimeSignature, windowsRuntimeCode, verifyWindowsCode, signWindowsCode } from '../scripts/windows-runtime-signature.mjs'
import { runtimeFixture } from './runtime-fixture.ts'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { createPackagingRun } from '../scripts/packaging-run.mjs'

const roots: string[] = []
const thumbprint = 'A'.repeat(40)
const valid = { status: 'Valid', timestamped: true, thumbprint }
const unsigned = { status: 'NotSigned', timestamped: false, thumbprint: null }

async function fixture(names = ['a.exe', 'b.pyd', 'vendor.dll']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primary-signing-'))
  roots.push(root)
  const pe = Buffer.alloc(128)
  pe.writeUInt16LE(0x5a4d, 0)
  pe.writeUInt32LE(64, 0x3c)
  pe.writeUInt32LE(0x4550, 64)
  for (const name of names) await writeFile(join(root, name), pe)
  return root
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('bounds overlapping cache restores and verifies all hits before serial hardware misses', async () => {
  const root = await fixture(['a.exe', 'b.exe', 'c.exe', 'd.exe'])
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const signed = new Set<string>()
  const verified = new Set<string>()
  let active = 0
  let peak = 0
  let hits = 0
  const sign = vi.fn(async ({ path }: { path: string }) => {
    expect(active).toBe(0)
    expect(hits).toBe(2)
    expect(verified.has(join(root, 'a.exe')) && verified.has(join(root, 'b.exe'))).toBe(true)
    signed.add(path)
  })
  const operation = signWindowsCode(root, { thumbprint, record: () => {}, sign,
    inspect: async (path) => {
      if (!signed.has(path)) return unsigned
      verified.add(path)
      return valid
    },
    cache: { concurrency: 2, restore: async ({ path }) => {
      active++
      peak = Math.max(peak, active)
      if (active === 2) entered.resolve(undefined)
      await release.promise
      active--
      if (path.endsWith('a.exe') || path.endsWith('b.exe')) { signed.add(path); hits++; return true }
      return false
    } },
  })
  try {
    await Promise.race([entered.promise, operation])
    expect(sign).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await operation }
  expect(peak).toBe(2)
  expect(sign.mock.calls.map(([request]) => request.path)).toEqual(['c.exe', 'd.exe'].map(name => join(root, name)))
})

it.each(['restore', 'verification', 'audit'])('drains active cache restores after %s failure without dispatching more work', async (failure) => {
  const root = await fixture(['a.exe', 'b.exe', 'c.exe'])
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const failed = Promise.withResolvers<undefined>()
  const restored = new Set<string>()
  const calls: string[] = []
  const sign = vi.fn(async () => {})
  let settled = false
  const operation = signWindowsCode(root, { thumbprint, sign,
    record: (event) => {
      if (failure === 'audit' && 'type' in event && event.type === 'windows-code-signature-verified') {
        failed.resolve(undefined)
        throw new Error('audit failed')
      }
    },
    inspect: async (path) => {
      if (!restored.has(path)) return unsigned
      if (failure === 'verification' && path.endsWith('a.exe')) { failed.resolve(undefined); throw new Error('verification failed') }
      return valid
    },
    cache: { concurrency: 2, restore: async ({ path }) => {
      calls.push(path)
      if (path.endsWith('b.exe')) { entered.resolve(undefined); await release.promise; return false }
      await entered.promise
      if (failure === 'restore') { failed.resolve(undefined); throw new Error('restore failed') }
      restored.add(path)
      return true
    } },
  }).then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
  try {
    await Promise.race([failed.promise, operation])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(sign).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await operation }
  expect(await operation).toEqual(new Error(`${failure} failed`))
  expect(calls).toEqual(['a.exe', 'b.exe'].map(name => join(root, name)))
  expect(sign).not.toHaveBeenCalled()
})

it('selects real PE code, including .node, without signing foreign native modules or data', async () => {
  const root = await fixture(['runtime.node', 'python.exe', 'extensionless', 'custom.binary'])
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'foreign.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  await writeFile(join(root, 'readme.txt'), 'text')
  expect(await windowsRuntimeCode(root)).toEqual(['python.exe', 'runtime.node', 'extensionless', 'custom.binary'].map(name => join(root, name)).sort())
})

it('refuses malformed executables and root or nested directory links', async () => {
  const root = await fixture([])
  const target = await fixture([])
  const link = join(root, 'linked')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(windowsRuntimeCode(root)).rejects.toThrow('links are not signable')
  await expect(windowsRuntimeCode(link)).rejects.toThrow('real directory')
  await writeFile(join(target, 'broken.exe'), 'invalid')
  await expect(windowsRuntimeCode(target)).rejects.toThrow('invalid PE file')
  await rm(join(target, 'broken.exe'))
  await writeFile(join(target, 'broken.node'), 'MZ')
  await expect(windowsRuntimeCode(target)).rejects.toThrow('invalid PE file')
})

it('retains vendor signatures and verifies each new signature before execution', async () => {
  const root = await fixture()
  const signed = new Set<string>()
  const sequence: string[] = []
  const sign = vi.fn(async ({ path }: { path: string }) => { sequence.push(`sign:${path}`); signed.add(path) })
  const inspect = vi.fn(async (path: string) => {
    sequence.push(`inspect:${path}`)
    return path.endsWith('vendor.dll') ? { ...valid, thumbprint: 'B'.repeat(40) } : signed.has(path) ? valid : unsigned
  })
  const smoke = vi.fn(() => { sequence.push('smoke') })
  await signWindowsPrimaryRuntime(root, { sign, inspect, smoke, thumbprint, record: () => {} })
  expect(sign.mock.calls.map(([input]) => input.path)).toEqual([join(root, 'a.exe'), join(root, 'b.pyd')])
  expect(sequence).toEqual([
    ...['a.exe', 'b.pyd', 'vendor.dll'].map(name => `inspect:${join(root, name)}`),
    `sign:${join(root, 'a.exe')}`, `inspect:${join(root, 'a.exe')}`,
    `sign:${join(root, 'b.pyd')}`, `inspect:${join(root, 'b.pyd')}`, 'smoke',
  ])
  expect(smoke).toHaveBeenCalledWith(root)
})

it.each(['HashMismatch', 'NotTrusted', 'UnknownError'])('rejects existing %s signatures before any hardware call', async (status) => {
  const root = await fixture()
  const sign = vi.fn(async () => {})
  const smoke = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, { thumbprint, sign, smoke, record: () => {},
    inspect: async path => path.endsWith('vendor.dll') ? { ...valid, status } : unsigned })).rejects.toThrow(status)
  expect(sign).not.toHaveBeenCalled()
  expect(smoke).not.toHaveBeenCalled()
})

it('stops immediately on signer failure without retrying, signing another file or executing it', async () => {
  const root = await fixture()
  const sign = vi.fn(async () => { throw new Error('token refused') })
  const smoke = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, { thumbprint, sign, smoke, record: () => {}, inspect: async () => unsigned }))
    .rejects.toThrow('token refused')
  expect(sign).toHaveBeenCalledOnce()
  expect(smoke).not.toHaveBeenCalled()
})

it.each([
  { ...valid, timestamped: false },
  { ...valid, thumbprint: 'B'.repeat(40) },
  { ...valid, status: 'HashMismatch' },
])('refuses an unverified new signature before the next file: %j', async (invalid) => {
  const root = await fixture()
  let signed = false
  const sign = vi.fn(async () => { signed = true })
  const smoke = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, {
    thumbprint, sign, smoke, record: () => {}, inspect: async () => signed ? invalid : unsigned,
  }))
    .rejects.toThrow('signing verification failed')
  expect(sign).toHaveBeenCalledOnce()
  expect(smoke).not.toHaveBeenCalled()
})

it('stops before hardware when the audit sink fails and never reports a failed smoke as success', async () => {
  const root = await fixture()
  const sign = vi.fn(async () => {})
  const smoke = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, { thumbprint, sign, smoke, inspect: async () => unsigned,
    record: () => { throw new Error('audit unavailable') } })).rejects.toThrow('audit unavailable')
  expect(sign).not.toHaveBeenCalled()
  const record = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, { thumbprint, sign, inspect: async () => valid, record,
    smoke: () => { throw new Error('runtime blocked') } })).rejects.toThrow('runtime blocked')
  expect(record).not.toHaveBeenCalledWith({ type: 'primary-runtime-smoke-success' })
})

it('refuses an empty runtime without declaring successful validation', async () => {
  const root = await fixture([])
  const smoke = vi.fn()
  await expect(signWindowsPrimaryRuntime(root, { thumbprint, sign: vi.fn(), smoke, record: () => {} })).rejects.toThrow('no Windows code')
  expect(smoke).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'win32')('reads a Windows system signature without using signing hardware', async () => {
  const signature = await inspectWindowsRuntimeSignature(join(process.env.SystemRoot!, 'System32', 'cmd.exe'))
  expect(signature.status).toBe('Valid')
  expect(signature.thumbprint).toMatch(/^[A-F\d]{40}$/iu)
}, 70_000)

it('preserves only identical, valid runtime copies and records verification without signing', async () => {
  const sourceRoot = await realpath(await fixture(['python.exe']))
  const destinationRoot = await realpath(await fixture(['python.exe']))
  const run = createPackagingRun(join(sourceRoot, 'records'), {})
  const inspect = vi.fn(async () => valid)
  const options = { sourceRoot, destinationRoot, runDirectory: run.directory, inspect }
  const path = join(destinationRoot, 'python.exe')
  expect(await preserveWindowsRuntimeSignature(join(`${destinationRoot}-other`, 'python.exe'), options)).toBe(false)
  expect(inspect).not.toHaveBeenCalled()
  expect(await preserveWindowsRuntimeSignature(path, options)).toBe(true)
  expect(await readFile(join(run.directory, 'events.jsonl'), 'utf8')).toContain('primary-runtime-copy-verified')
  inspect.mockResolvedValueOnce({ ...valid, status: 'NotSigned' })
  await expect(preserveWindowsRuntimeSignature(path, options)).rejects.toThrow('copied signature is NotSigned')
  await writeFile(path, 'changed executable')
  await expect(preserveWindowsRuntimeSignature(path, options)).rejects.toThrow('copied executable changed')
  await rm(path)
  await symlink(sourceRoot, join(destinationRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(sourceRoot, 'linked'))
  await writeFile(join(sourceRoot, 'linked', 'python.exe'), await readFile(join(sourceRoot, 'python.exe')))
  await expect(preserveWindowsRuntimeSignature(join(destinationRoot, 'linked', 'python.exe'), options)).rejects.toThrow('linked copy')
})

it('rejects a newly added unsigned dependency in the final artifact audit', async () => {
  const root = await fixture(['new-dependency.node', 'vendor.dll'])
  await expect(verifyWindowsCode(root, async path => path.endsWith('.node') ? unsigned : valid)).rejects.toThrow('NotSigned')
  await expect(verifyWindowsCode(root, async () => valid)).resolves.toBeUndefined()
})

it('records signed dependency bytes before smoke and rejects changes after smoke', async () => {
  const root = await fixture(['dependency.node'])
  runtimeFixture(root)
  let signed = false
  const options = { thumbprint, record: () => {},
    inspect: async () => signed ? valid : unsigned,
    sign: async ({ path }: { path: string }) => {
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('signature')]))
      signed = true
    },
    smoke: vi.fn(async () => { await verifyDesktopRuntime(root, '1.0.0') }),
  }
  await signWindowsDesktopRuntime(root, '1.0.0', options)
  expect(options.smoke).toHaveBeenCalledOnce()
  await expect(signWindowsDesktopRuntime(root, '1.0.0', { ...options,
    smoke: async () => { await writeFile(join(root, 'dependency.node'), 'mutated') },
  })).rejects.toThrow('integrity')
})

it('bounds public-key inspection to four files and drains a failed batch before returning', async () => {
  const root = await fixture(['a.node', 'b.node', 'c.node', 'd.node', 'e.node'])
  const started = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  let active = 0
  let maximum = 0
  const calls: string[] = []
  const inspect = async (path: string) => {
    calls.push(path)
    active += 1
    maximum = Math.max(maximum, active)
    if (active === 4) started.resolve(undefined)
    try {
      await finish.promise
      if (path.endsWith('a.node')) throw new Error('inspection failed')
      return unsigned
    } finally { active -= 1 }
  }
  const sign = vi.fn()
  const pending = signWindowsCode(root, { thumbprint, inspect, sign, record: () => {} })
  const rejected = expect(pending).rejects.toThrow('inspection failed')
  try {
    await started.promise
    expect(calls).toHaveLength(4)
    expect(sign).not.toHaveBeenCalled()
  } finally { finish.resolve(undefined); await rejected }
  expect(maximum).toBe(4)
  expect(active).toBe(0)
  expect(calls).toHaveLength(4)
  expect(sign).not.toHaveBeenCalled()
})
