/** PE discovery keeps content checks and drains bounded file reads before failure. */
import { mkdir, mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { windowsRuntimeCode } from '../scripts/windows-runtime-signature.mjs'

const hooks = vi.hoisted(() => ({
  opened: undefined as ((handle: FileHandle) => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      hooks.opened?.(handle)
      return handle
    },
  }
})

const roots: string[] = []

async function fixture(entries: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'windows-runtime-code-'))
  roots.push(root)
  for (const [name, contents] of Object.entries(entries)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  return root
}

function executable(): Buffer {
  const bytes = Buffer.alloc(128)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64)
  return bytes
}

afterEach(async () => {
  hooks.opened = undefined
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('discovers extensionless PE files in nested directories and excludes foreign native modules', async () => {
  const root = await fixture({
    'nested/deeper/extensionless': executable(),
    'nested/runtime.node': executable(),
    'a.exe': executable(),
    'nested/deeper/foreign.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    'readme.txt': 'ordinary data',
  })
  expect(await windowsRuntimeCode(root)).toEqual([
    'nested/deeper/extensionless', 'nested/runtime.node', 'a.exe',
  ].map(name => join(root, name)).sort())
})

it.each([
  ['broken.exe', Buffer.from('not PE')],
  ['nested/extensionless', Buffer.from('MZ')],
  ['nested/broken.node', Buffer.from('MZ')],
  ['nested/deeper/broken.dll', Buffer.alloc(64)],
])('rejects malformed Windows code at %s', async (name, contents) => {
  const root = await fixture({ [name]: contents })
  await expect(windowsRuntimeCode(root)).rejects.toThrow(`Windows code: invalid PE file: ${join(root, name)}`)
})

it('limits open files to eight and drains pending closes before rejecting a read failure', async () => {
  const root = await fixture(Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
    `${String(index).padStart(2, '0')}.txt`, 'ordinary data',
  ])))
  const releaseReads = Promise.withResolvers<undefined>()
  const releaseCloses = Promise.withResolvers<undefined>()
  const failedClosed = Promise.withResolvers<undefined>()
  const failure = new Error('controlled PE header read failure')
  let opened = 0
  let active = 0
  let peak = 0
  let settled = false
  hooks.opened = (handle) => {
    const index = opened++
    active++
    peak = Math.max(peak, active)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'read').mockImplementationOnce(async () => {
      await releaseReads.promise
      if (index === 0) throw failure
      return { bytesRead: 0, buffer: Buffer.alloc(64) }
    })
    vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
      if (index !== 0) await releaseCloses.promise
      await close()
      active--
      if (index === 0) failedClosed.resolve(undefined)
    })
  }
  const operation = windowsRuntimeCode(root).then(
    (result) => { settled = true; return result },
    (error: unknown) => { settled = true; return error },
  )
  try {
    await vi.waitFor(() => { expect(opened).toBe(8) })
    expect(active).toBe(8)
    releaseReads.resolve(undefined)
    await failedClosed.promise
    await setImmediate()
    expect(settled).toBe(false)
    expect(opened).toBe(8)
    expect(active).toBe(7)
    releaseCloses.resolve(undefined)
    expect(await operation).toBe(failure)
    expect(opened).toBe(8)
    expect(peak).toBe(8)
    expect(active).toBe(0)
  } finally {
    hooks.opened = undefined
    releaseReads.resolve(undefined)
    releaseCloses.resolve(undefined)
    await operation
  }
})
