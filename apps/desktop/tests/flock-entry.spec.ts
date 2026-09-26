import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createFlockEntryLoader } from '../scripts/flock-entry.ts'

type Entry = Awaited<ReturnType<ReturnType<typeof createFlockEntryLoader>>>

const entry = { tryLockExclusive: vi.fn() } as Entry
const BUILD_TEXT = 'pnpm run build:native-system && pnpm --dir native/system run build:ts'

function notFound(): NodeJS.ErrnoException {
  return Object.assign(new Error("Cannot find module 'lib/flock.js'"), { code: 'ERR_MODULE_NOT_FOUND' })
}

function steps(overrides: Partial<Parameters<typeof createFlockEntryLoader>[0]> = {}) {
  return {
    importEntry: vi.fn(overrides.importEntry ?? (async () => entry)),
    hostAddonBuilt: vi.fn(overrides.hostAddonBuilt ?? (() => true)),
    build: vi.fn(overrides.build ?? (async () => {})),
  }
}

function quietStderr(): () => void {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  return () => { spy.mockRestore() }
}

it('returns the imported entry without building and memoizes it', async () => {
  const used = steps()
  const load = createFlockEntryLoader(used)
  expect(await load()).toBe(entry)
  expect(await load()).toBe(entry)
  expect(used.importEntry).toHaveBeenCalledTimes(1)
  expect(used.hostAddonBuilt).toHaveBeenCalledTimes(1)
  expect(used.build).not.toHaveBeenCalled()
})

it('builds once and imports again when the JavaScript entry is missing', async () => {
  const order: string[] = []
  const used = steps({
    importEntry: async () => {
      order.push('import')
      if (order.length === 1) throw notFound()
      return entry
    },
    build: async () => { order.push('build') },
  })
  const written: string[] = []
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
  try {
    const load = createFlockEntryLoader(used)
    expect(await load()).toBe(entry)
    expect(await load()).toBe(entry)
  } finally { stderr.mockRestore() }
  expect(order).toEqual(['import', 'build', 'import'])
  expect(written).toEqual([expect.stringContaining(BUILD_TEXT)])
})

it('builds when the entry imports but the host addon binary is missing', async () => {
  const used = steps({ hostAddonBuilt: () => false })
  const restore = quietStderr()
  try {
    expect(await createFlockEntryLoader(used)()).toBe(entry)
  } finally { restore() }
  expect(used.build).toHaveBeenCalledTimes(1)
  expect(used.importEntry).toHaveBeenCalledTimes(2)
})

it('propagates other import errors without building', async () => {
  const used = steps({ importEntry: async () => { throw new Error('addon binding failed') } })
  await expect(createFlockEntryLoader(used)()).rejects.toThrow('addon binding failed')
  expect(used.build).not.toHaveBeenCalled()
})

it('propagates a build failure, does not import again, and retries on the next call', async () => {
  const used = steps({
    importEntry: async () => { throw notFound() },
    build: async () => { throw new Error('tsc exited with 2') },
  })
  const restore = quietStderr()
  try {
    const load = createFlockEntryLoader(used)
    await expect(load()).rejects.toThrow('tsc exited with 2')
    expect(used.importEntry).toHaveBeenCalledTimes(1)
    used.importEntry.mockResolvedValueOnce(entry)
    expect(await load()).toBe(entry)
  } finally { restore() }
  expect(used.build).toHaveBeenCalledTimes(1)
})

it('loads the proxy module where the addon package cannot be resolved', async () => {
  // A directory outside every node_modules tree stands in for a checkout whose native/system is unbuilt.
  const root = await mkdtemp(join(tmpdir(), 'flock-entry-test-'))
  try {
    for (const name of ['macos-notarization-proxy.ts', 'flock-entry.ts']) {
      await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, name))
    }
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const module = await import(${JSON.stringify(pathToFileURL(join(root, 'macos-notarization-proxy.ts')).href)});
      process.stdout.write(Object.keys(module).sort().join(','));
    `], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    const [code] = await once(child, 'close') as [number | null]
    expect(code, stderr).toBe(0)
    expect(stdout).toBe('restoreMacOSNotarizationProxy,withMacOSNotarizationProxy')
  } finally { await rm(root, { recursive: true, force: true }) }
})
