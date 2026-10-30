/** Plain-Node release checks resolve Kit from the runtime's skill package and reject incomplete artifacts. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { resolveKitCli } from '@deepseek-ai/dsh-office-kit/locate'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

vi.mock('@deepseek-ai/dsh-office-kit/locate', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-office-kit/locate')>()
  return { ...actual, resolveKitCli: vi.fn(actual.resolveKitCli) }
})
afterEach(() => { vi.resetAllMocks() })

function fixture(packed: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-office-smoke-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const runtime = join(root, packed ? 'app.asar/dsh' : 'dsh')
  const physical = join(root, packed ? 'app.asar.unpacked/dsh' : 'dsh')
  if (packed) writeFileSync(join(root, 'app.asar'), 'archive fixture')
  mkdirSync(physical, { recursive: true })
  return { root, runtime, physical }
}

function installKit(directory: string): string {
  const kit = join(directory, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  mkdirSync(join(kit, 'lib'), { recursive: true })
  writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit',
    exports: { '.': './lib/index.js', './cli': './lib/cli.js' } }))
  writeFileSync(join(kit, 'lib', 'index.js'), '')
  const cli = join(kit, 'lib', 'cli.js')
  writeFileSync(cli, '')
  return cli
}

it.each([false, true])('resolves the skill-owned Kit before the runtime smoke (ASAR=%s)', async (packed) => {
  const f = fixture(packed)
  installKit(f.root)
  const cli = installKit(f.physical)
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-office-kit/locate')>('@deepseek-ai/dsh-office-kit/locate')
  const checked = new Error('fixture stops after checking Kit discovery')
  vi.mocked(resolveKitCli).mockImplementationOnce((options) => {
    expect(options.root).toBe(f.runtime)
    expect(actual.resolveKitCli(options)).toEqual({ kind: 'available', node: process.execPath, cli })
    throw checked
  })
  await expect(smokeDesktopRuntime(f.runtime, process.execPath, {} as DesktopRuntimeDescriptor, {}, f.root)).rejects.toBe(checked)
})

it('prefers a Kit nested in skill-office rather than a Host dependency', async () => {
  const f = fixture(false)
  installKit(join(f.physical, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'))
  const skill = join(f.physical, 'node_modules', '@deepseek-ai', 'dsh-skill-office')
  const cli = installKit(skill)
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-office-kit/locate')>('@deepseek-ai/dsh-office-kit/locate')
  const checked = new Error('fixture stops after checking Kit discovery')
  vi.mocked(resolveKitCli).mockImplementationOnce((options) => {
    expect(actual.resolveKitCli(options)).toMatchObject({ kind: 'available', cli })
    throw checked
  })
  await expect(smokeDesktopRuntime(f.runtime, process.execPath, {} as DesktopRuntimeDescriptor, {}, f.root)).rejects.toBe(checked)
})

it.each([false, true])('rejects an ancestor Kit outside the runtime (ASAR=%s)', async (packed) => {
  const f = fixture(packed)
  installKit(f.root)
  const error = await smokeDesktopRuntime(f.runtime, process.execPath, {} as DesktopRuntimeDescriptor, {}, f.root)
    .then(() => undefined, (reason: unknown) => reason)
  expect(error).toHaveProperty('message', 'desktop runtime: LibreOffice Kit CLI is missing from the runtime')
  expect(error).toHaveProperty('cause.message', expect.stringContaining('outside root'))
})

it('strictly rejects a disabled CLI resolution', async () => {
  const f = fixture(false)
  vi.mocked(resolveKitCli).mockReturnValueOnce({ kind: 'disabled' })
  await expect(smokeDesktopRuntime(f.runtime, process.execPath, {} as DesktopRuntimeDescriptor, {}, dirname(f.runtime)))
    .rejects.toThrow('LibreOffice Kit CLI is missing from the runtime')
})
