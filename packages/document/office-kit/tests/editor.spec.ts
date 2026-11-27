/** Runtime discovery and interactive editor document opening through the provider's Kit installation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConverterOptions, RuntimeInfo } from '@deepseek-ai/libreoffice-kit'
import type { EditorDocument, OpenDocumentOptions } from '@deepseek-ai/libreoffice-kit/editor'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import OfficeKit, { Config } from '../src/index.ts'
import { resolveKitModule, type KitModuleResolution } from '../src/locate.ts'
import { expectDefaultOutputsUntouched } from './default-outputs.ts'

const home = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return mkdtemp(`${tmpdir()}/dsh-office-kit-editor-home-`)
})
vi.mock('@deepseek-ai/dsh-home-paths', async (original) => {
  const path = await import('node:path')
  return { ...await original<typeof import('@deepseek-ai/dsh-home-paths')>(), dshHomePath: (...segments: string[]) => path.join(home, ...segments) }
})
expectDefaultOutputsUntouched(home)

vi.mock('../src/locate.ts', async (original) => {
  const actual = await original<typeof import('../src/locate.ts')>()
  return { ...actual, resolveKitModule: vi.fn(actual.resolveKitModule) }
})

const kit = vi.hoisted(() => {
  class FakeConversionError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
      this.name = 'ConversionError'
    }
  }
  return {
    ConversionError: FakeConversionError,
    createConverter: vi.fn<(options?: ConverterOptions) => Promise<never>>(),
    discoverRuntime: vi.fn<(options?: ConverterOptions) => Promise<RuntimeInfo>>(),
    openDocument: vi.fn<(options: OpenDocumentOptions) => Promise<EditorDocument>>(),
  }
})
vi.mock('@deepseek-ai/libreoffice-kit', () => ({
  ConversionError: kit.ConversionError,
  createConverter: kit.createConverter,
  discoverRuntime: kit.discoverRuntime,
}))
vi.mock('@deepseek-ai/libreoffice-kit/editor', () => ({
  openDocument: kit.openDocument,
}))

const runtimeInfo: RuntimeInfo = {
  version: '0.2.4',
  backend: 'native',
  nativePreview: true,
  cliPath: '/kit/cli.js',
  nodeApiPath: '/kit/index.js',
}
const absentKit = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })
let ctx: Context

beforeEach(() => {
  vi.mocked(resolveKitModule).mockClear()
  ctx = new Context()
  kit.createConverter.mockReset().mockRejectedValue(new Error('Unexpected createConverter call'))
  kit.discoverRuntime.mockReset().mockResolvedValue(runtimeInfo)
  kit.openDocument.mockReset()
})
afterEach(async () => { await ctx.fiber.dispose() })

async function mount(config: Partial<Config> = {}): Promise<OfficeKit> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-kit-editor-outputs-'))
  onTestFinished(() => rm(outputDirectory, { recursive: true, force: true }))
  await ctx.plugin(OfficeKit, { ...config, outputDirectory })
  return ctx.officeKit
}

function fakeDocument(): EditorDocument {
  const partial: Partial<EditorDocument> = { close: vi.fn(async () => {}) }
  return partial as EditorDocument
}

function resolutionAt(index: number): Extract<KitModuleResolution, { kind: 'available' }> {
  const result = vi.mocked(resolveKitModule).mock.results[index]
  if (result?.type !== 'return' || result.value.kind !== 'available') throw new Error(`Expected available resolution at ${index}`)
  return result.value
}

it('discovers runtime metadata using the provider Kit engine resolver and reuses the loaded Kit module', async () => {
  const provider = await mount()
  expect(await provider.discoverRuntime()).toEqual(runtimeInfo)
  expect(vi.mocked(resolveKitModule).mock.calls[0]?.[0]()).toBe(import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  expect(kit.discoverRuntime).toHaveBeenCalledExactlyOnceWith({ resolveEnginePackage: resolutionAt(0).resolveEnginePackage })
  expect(await provider.discoverRuntime()).toEqual(runtimeInfo)
  expect(resolveKitModule).toHaveBeenCalledOnce()
  expect(kit.createConverter).not.toHaveBeenCalled()
})

it.each([
  ['missing Kit', (): void => { vi.mocked(resolveKitModule).mockReturnValue({ kind: 'missing', error: absentKit }) }],
  ['unloadable Kit', (): void => {
    vi.mocked(resolveKitModule).mockReturnValue({
      kind: 'available', entry: new URL('./absent-kit.js', import.meta.url).href, resolveEnginePackage: () => { throw absentKit },
    })
  }],
  ['unavailable engine', (): void => {
    kit.discoverRuntime.mockRejectedValue(new kit.ConversionError('unavailable', 'missing native engine'))
  }],
] as const)('reports runtime discovery unavailable for %s and logs each distinct failure once', async (_label, arrange) => {
  arrange()
  onTestFinished(() => { vi.mocked(resolveKitModule).mockReset() })
  const warn = vi.fn()
  ctx.logger.warn = warn
  const provider = await mount()
  expect(await provider.discoverRuntime()).toBeUndefined()
  expect(await provider.discoverRuntime()).toBeUndefined()
  expect(warn).toHaveBeenCalledOnce()
})

it('propagates unexpected discovery failures and reports undefined after disposal', async () => {
  const provider = await mount()
  kit.discoverRuntime.mockRejectedValueOnce(new Error('broken discovery'))
  await expect(provider.discoverRuntime()).rejects.toThrow('broken discovery')
  kit.discoverRuntime.mockRejectedValueOnce(new kit.ConversionError('failed', 'engine crashed'))
  await expect(provider.discoverRuntime()).rejects.toThrow('engine crashed')
  await ctx.fiber.dispose()
  expect(await provider.discoverRuntime()).toBeUndefined()
})

it('opens an interactive document lazily with provider font/archive settings, caller overrides, and the anchored engine resolver', async () => {
  const fontDirectories = [join(home, 'fonts')]
  const fontFallbacks = [['sans-serif', 'Arial']]
  const provider = await mount({
    fontDirectories, fontFallbacks, maxArchiveEntries: 64, maxUncompressedBytes: 8192,
    maxFontFiles: 16, maxFontFileBytes: 4096, maxLoadedFontBytes: 8192,
    maxInputBytes: 1024, maxOutputBytes: 2048, timeoutMs: 5000,
  })
  const first = fakeDocument(), second = fakeDocument()
  kit.openDocument.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const onProgress = vi.fn()
  const request = {
    bytes: Uint8Array.of(1, 2, 3), format: 'docx' as const, renderBackend: 'ganesh' as const, onProgress,
    options: { maxInputBytes: 4096, maxOutputBytes: 16384, timeoutMs: 9000 },
  }
  expect(await provider.openDocument(request)).toBe(first)
  expect(vi.mocked(resolveKitModule).mock.calls[0]?.[0]()).toBe(import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  expect(vi.mocked(resolveKitModule).mock.calls[1]?.[0]()).toBe(import.meta.resolve('@deepseek-ai/libreoffice-kit/editor'))
  expect(kit.openDocument).toHaveBeenCalledExactlyOnceWith({
    ...request,
    options: {
      fontDirectories, fontFallbacks, maxArchiveEntries: 64, maxUncompressedBytes: 8192,
      maxFontFiles: 16, maxFontFileBytes: 4096, maxLoadedFontBytes: 8192, maxImageResolution: 192,
      maxInputBytes: 4096, maxOutputBytes: 16384, timeoutMs: 9000,
      resolveEnginePackage: resolutionAt(0).resolveEnginePackage,
    },
  })
  expect(await provider.openDocument({ bytes: Uint8Array.of(4), format: 'xlsx' })).toBe(second)
  expect(resolveKitModule).toHaveBeenCalledTimes(2)
  expect(kit.createConverter).not.toHaveBeenCalled()
})

it.each([
  ['missing editor', (): KitModuleResolution => ({ kind: 'missing', error: absentKit })],
  ['unloadable editor', (): KitModuleResolution => ({
    kind: 'available', entry: new URL('./absent-editor.js', import.meta.url).href, resolveEnginePackage: () => { throw absentKit },
  })],
] as const)('rejects openDocument as unavailable for %s and retries once available', async (_label, failure) => {
  const warn = vi.fn()
  ctx.logger.warn = warn
  const provider = await mount()
  const realResolve = vi.mocked(resolveKitModule).getMockImplementation()!
  vi.mocked(resolveKitModule)
    .mockImplementationOnce(realResolve)
    .mockReturnValueOnce(failure())
    .mockImplementationOnce(realResolve)
  const doc = fakeDocument()
  kit.openDocument.mockResolvedValueOnce(doc)
  await expect(provider.openDocument({ bytes: Uint8Array.of(1), format: 'docx' })).rejects.toMatchObject({
    name: 'OfficeKitError', code: 'unavailable',
  })
  expect(warn).toHaveBeenCalledOnce()
  expect(await provider.openDocument({ bytes: Uint8Array.of(1), format: 'docx' })).toBe(doc)
})

it('rejects openDocument on caller cancellation or provider disposal before starting the native engine', async () => {
  const provider = await mount()
  const reason = new Error('tab closed')
  await expect(provider.openDocument({
    bytes: Uint8Array.of(1), format: 'pptx', signal: AbortSignal.abort(reason),
  })).rejects.toBe(reason)
  expect(resolveKitModule).not.toHaveBeenCalled()
  expect(kit.openDocument).not.toHaveBeenCalled()

  await ctx.fiber.dispose()
  await expect(provider.openDocument({ bytes: Uint8Array.of(1), format: 'pptx' })).rejects.toMatchObject({
    name: 'OfficeKitError', code: 'unavailable',
  })
  expect(kit.openDocument).not.toHaveBeenCalled()
})
