/**
 * The Office tools over the real local filesystem, attachment store, and tool pipeline, with a
 * controlled Office service: model-visible content, canonical values, argument rules, output-path refusals, render
 * bounds, read authority, Office service failures, cancellation, PTC dispatch, and disposal.
 */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import OfficeKit, { OfficeKitError, type OfficeKitErrorCode, type OfficeImagesRequest, type OfficeImagesResult, type OfficeKitSource } from '@deepseek-ai/dsh-office-kit'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import * as ToolOffice from '../src/index.ts'
import { renderImagesContent } from '../src/content.ts'

vi.mock('../../office-kit/src/locate.ts', async original => ({
  ...await original<typeof import('../../office-kit/src/locate.ts')>(),
  resolveKitModule: () => ({ kind: 'available', entry: new URL('fixtures/fake-kit.ts', import.meta.url).href, resolveEnginePackage: () => '' }),
}))

/** 1x1 red PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal

/** Encode a square single-color 8-bit PNG: opaque RGB, or half-transparent RGBA when `translucent` is set. */
function solidPng(size: number, translucent: boolean): Buffer {
  const channels = translucent ? 4 : 3
  const pixel = translucent ? [200, 30, 30, 128] : [200, 30, 30]
  const row = Buffer.from([0, ...Array.from({ length: size }, () => pixel).flat()])
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, channels === 3 ? 2 : 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

/** Declared input modalities by model id; `legacy` declares none. */
const MODALITIES: Partial<Record<string, readonly ('text' | 'image')[]>> = { vision: ['text', 'image'], text: ['text'] }

class CatalogAdapter extends LlmAdapter {
  override listModels(): Promise<readonly LlmModelInfo[]> { return Promise.resolve([]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const inputModalities = MODALITIES[model]
    return Promise.resolve({
      provider, id: model, name: model, ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] },
    })
  }
  /* v8 ignore next 3 -- office tests never stream */
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('unused') }
}

class FakeRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ output: [] })
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(request: PtcRunRequest): Promise<PtcRunResult> { return this.behavior(request) }
}

async function readSource(source: OfficeKitSource): Promise<Uint8Array> {
  return (await source.read(signal, 1024)).bytes
}

interface FileResult {
  path: string
  bytes: number
  pageCount?: number
  missingFonts: string[]
}

async function fileResult(request: { source: OfficeKitSource; output: { name: string } }): Promise<FileResult> {
  const data = await readSource(request.source)
  return { path: join(home, 'outputs', request.output.name), bytes: data.byteLength, missingFonts: [] }
}

function fakeOfficeKit() {
  return {
    renderImages: vi.fn(async (request: OfficeImagesRequest, _signal?: AbortSignal): Promise<OfficeImagesResult> => {
      await readSource(request.source)
      return { images: [{ png: PNG, width: 1, height: 1, page: 2 }], pageCount: 3, dpi: request.dpi ?? 144, missingFonts: [] }
    }),
    outputDirectory: join(home, 'outputs'),
    convertTo: vi.fn(async (
      request: { source: OfficeKitSource; output: { name: string } }, _signal?: AbortSignal,
    ) => fileResult(request)),
    recalculate: vi.fn(async (
      request: { source: OfficeKitSource; output: { name: string } }, _signal?: AbortSignal,
    ) => fileResult(request)),
  }
}

let dir: string
let home: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-office-')))
  home = await mkdtemp(join(tmpdir(), 'dsh-tool-office-home-'))
  await writeFile(join(dir, 'deck.pptx'), 'pptx bytes')
  await writeFile(join(dir, 'book.xlsx'), 'xlsx bytes')
  await writeFile(join(dir, 'report.docx'), 'docx bytes')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

interface SetupOptions {
  ptc?: boolean
  attachments?: boolean | { normalizedImageMaxPixels: number }
  llm?: boolean
  kit?: boolean
  config?: Partial<ToolOffice.Config>
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  provideWorkingDirectoryFixture(ctx, dir)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(options.ptc === true ? PtcToolExecutor : NativeToolExecutor)
  if (options.ptc === true) await ctx.plugin(FakeRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  if (options.attachments !== false) {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home, ...typeof options.attachments === 'object' ? options.attachments : {} })
  }
  if (options.llm !== false) {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['visual'], new CatalogAdapter())
  }
  const kit = fakeOfficeKit()
  if (options.kit !== false) ctx.provide('officeKit', kit as never)
  const fiber = await ctx.plugin(ToolOffice, options.config ?? {})
  return { ctx, kit, fiber }
}

let sessions = 0
function agentOn(model: string | undefined, options: { provider?: string; model?: string } = {}) {
  const id = SessionId(`office-session-${++sessions}`)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: dir, isSeeded: false })
  vi.spyOn(session, 'requestHeader').mockReturnValue(model === undefined ? undefined : { config: { provider: 'visual', model } })
  return { options, session }
}

let calls = 0
async function loadOffice(ctx: Context, agent: object): Promise<void> {
  const dispose = ctx.tools.register(defineTool({
    name: 'skill', description: 'Fixture skill', parameters: { name: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'Office instructions',
  }))
  try {
    await executeToolFixture(ctx, { signal, name: 'skill', callId: ToolCallId(`skill-${++calls}`), arguments: { name: 'office' }, agent: agent as never })
  } finally { dispose() }
}

async function office(ctx: Context, args: Record<string, unknown>, agent: object | null = agentOn('vision'), callSignal = signal) {
  const { operation, ...parameters } = args
  if (agent !== null) await loadOffice(ctx, agent)
  const toolSet = agent === null ? undefined : await ctx.tools.resolve({ agent: agent as never,
    modelSelection: { provider: 'visual', model: 'vision' }, signal: callSignal })
  try {
    return await executeToolFixture(ctx, {
      signal: callSignal, callId: ToolCallId(`office-${++calls}`), name: `office_${String(operation)}`, arguments: parameters,
      ...agent === null ? {} : { agent: agent as never }, ...toolSet === undefined ? {} : { toolSet },
    })
  } finally { toolSet?.dispose() }
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

describe('office schema', () => {
  it('declares the model-facing description and parameters', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name)).toEqual(['office_render', 'office_convert', 'office_recalculate'])
    expect(schemas.map(schema => Object.keys(schema.parameters.properties ?? {}))).toEqual([
      ['input', 'pages', 'sheet', 'range', 'dpi'], ['input', 'format', 'sheet'], ['input', 'format'],
    ])
    expect(schemas.map(schema => schema.parameters.required)).toEqual([['input'], ['input', 'format'], ['input', 'format']])
    expect(schemas[0]?.description).toBe('Render document pages, slides, or worksheet areas as images you can view.')
    expect(schemas[1]?.parameters).toMatchObject({ properties: { format: { enum: ['pdf', 'docx', 'odt', 'txt', 'xlsx', 'ods', 'csv', 'pptx', 'odp'] } } })
    expect(schemas[2]?.parameters).toMatchObject({ properties: { format: { enum: ['xlsx', 'ods'] } } })
    const outputs = ctx.tools.definitions().map(definition => definition.output.schema)
    expect(outputs[0]).toMatchObject({ properties: { images: { items: { properties: { mediaType: { enum: ['image/png', 'image/jpeg', 'image/webp'] } } } } } })
    expect(outputs[1]).toMatchObject({ properties: { format: { enum: ['pdf', 'docx', 'odt', 'txt', 'xlsx', 'ods', 'csv', 'pptx', 'odp'] } } })
    expect(outputs[2]).toMatchObject({ properties: { format: { enum: ['xlsx', 'ods'] } } })
    for (const definition of ctx.tools.definitions()) {
      expect(definition.output.schema).toMatchObject({ type: 'object', properties: { operation: { const: definition.name.replace('office_', '') } } })
      expect(definition.output.schema).not.toHaveProperty('oneOf')
    }
  })

  it('removes the tool when its plugin fiber is disposed', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.definitions()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.tools.definitions()).toHaveLength(0)
  })

  it.each([
    ['office_render', { input: 'deck.pptx' }],
    ['office_convert', { input: 'book.xlsx', format: 'csv' }],
    ['office_recalculate', { input: 'book.xlsx', format: 'xlsx' }],
  ])('refuses a direct %s body call without an Agent', async (name, args) => {
    const { ctx, kit } = await setup()
    const definition = ctx.tools.get(name)!
    const call = { signal, callId: ToolCallId(`agentless-${name}`), name, arguments: args, deferContext: vi.fn(), concludeTurn: vi.fn() }
    await expect(definition.execute(args as never, call as never)).rejects.toThrow('Office tools run only in an Agent step')
    expect(kit.renderImages).not.toHaveBeenCalled()
    expect(kit.convertTo).not.toHaveBeenCalled()
    expect(kit.recalculate).not.toHaveBeenCalled()
  })

  it('presents pending calls with their files', async () => {
    const { ctx } = await setup()
    const render = ctx.tools.get('office_render')!
    const convert = ctx.tools.get('office_convert')!
    const recalculate = ctx.tools.get('office_recalculate')!
    expect(render.presentCall?.({ input: 'deck.pptx' }))
      .toEqual({ card: 'generic', title: 'Render deck.pptx', kind: 'read', locations: [{ path: 'deck.pptx' }] })
    expect(convert.presentCall?.({ input: 'deck.pptx', format: 'pdf' }))
      .toEqual({ card: 'generic', title: 'Convert deck.pptx to pdf', kind: 'other', locations: [{ path: 'deck.pptx' }] })
    expect(recalculate.presentCall?.({ input: 'book.xlsx', format: 'xlsx' })).toMatchObject({ title: 'Recalculate book.xlsx' })
    expect(render.isConcurrencySafe?.({ input: 'deck.pptx' })).toBe(true)
    expect(convert.isConcurrencySafe?.({ input: 'deck.pptx', format: 'pdf' })).toBe(false)
    expect(recalculate.isConcurrencySafe?.({ input: 'book.xlsx', format: 'xlsx' })).toBe(false)
  })
})

describe('render', () => {
  it('returns the rendered images to the model with their locations and bounded request limits', async () => {
    const { ctx, kit } = await setup({ config: { maxImages: 5, maxImagePixels: 1000, maxImageDimension: 100, maxImageBytes: 4096 } })
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx', pages: [2], dpi: 96 })
    expect(result.isError).toBe(false)
    expect(kit.renderImages).toHaveBeenCalledWith(expect.objectContaining({
      extension: 'pptx', pages: [2], dpi: 96, maxImages: 5, maxPixels: 1000, maxDimension: 100, maxBytes: 4096,
    }), expect.any(AbortSignal))
    expect(text(result)).toBe(`Rendered 1 image of ${join(dir, 'deck.pptx')} (3 in the document) at 96 DPI.\nPage 2: 1x1 px`)
    expect(result.content[2]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png', width: 1, height: 1 } })
    if (result.isError) throw new Error('render failed')
    expect(result.value).toMatchObject({ operation: 'render', path: join(dir, 'deck.pptx'), pageCount: 3, dpi: 96,
      images: [{ page: 2, mediaType: 'image/png', width: 1, height: 1 }], missingFonts: [] })
    expect(result.meta).toEqual({ path: join(dir, 'deck.pptx') })
  })

  it('applies lower deployment attachment limits to the complete result', async () => {
    const { ctx, kit } = await setup()
    const limits = ctx.get('attachments')!.imageLimits
    await office(ctx, { operation: 'render', input: 'deck.pptx' })
    expect(kit.renderImages.mock.calls[0]![0]).toMatchObject({
      maxImages: Math.min(20, limits.maxImagesPerMessage), maxBytes: Math.min(32 * 1024 * 1024, limits.maxMessageImageBytes),
      maxPixels: Math.min(8_388_608, limits.maxImagePixels), maxDimension: Math.min(8192, limits.maxImageDimension),
    })
  })

  it('passes worksheet selections and reports substituted fonts', async () => {
    const { ctx, kit } = await setup()
    kit.renderImages.mockResolvedValueOnce({ images: [
      { png: PNG, width: 1, height: 1, sheet: 'Data', range: 'A1:B2' }, { png: PNG, width: 1, height: 1, sheet: 'Data' },
    ], pageCount: 2, dpi: 144, missingFonts: ['Aptos'] })
    const result = await office(ctx, { operation: 'render', input: 'book.xlsx', sheet: 'Data', range: 'A1:B2' })
    expect(kit.renderImages.mock.calls[0]![0]).toMatchObject({ extension: 'xlsx', sheet: 'Data', range: 'A1:B2' })
    expect(text(result)).toBe(`Rendered 2 images of ${join(dir, 'book.xlsx')} (2 in the document) at 144 DPI.\n`
      + 'Fonts not installed and substituted: Aptos.\nSheet "Data" A1:B2: 1x1 px\nSheet "Data": 1x1 px')
  })

  it.each([
    ['a text-only model', { model: 'text' }, 'model "text" does not accept images'],
    ['a model without declared input modalities', { model: 'legacy' }, 'model "legacy" does not accept images'],
    ['an unresolved route', { model: undefined }, 'the current model route could not be resolved'],
    ['no attachment service', { attachments: false }, 'no attachment service is mounted'],
    ['no model runtime', { llm: false }, 'the current model route could not be resolved'],
  ])('refuses %s before rendering', async (_label, options, message) => {
    const { model, ...setupOptions } = { model: 'vision' as string | undefined, ...options }
    const { ctx, kit } = await setup(setupOptions)
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' }, agentOn(model))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(kit.renderImages).not.toHaveBeenCalled()
  })

  it('falls back to the agent route when the Session has no request header', async () => {
    const { ctx, kit } = await setup()
    expect((await office(ctx, { operation: 'render', input: 'deck.pptx' }, agentOn(undefined, { provider: 'visual', model: 'vision' }))).isError).toBe(false)
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }, agentOn(undefined, { provider: 'visual', model: 'text' }))))
      .toBe(`Error: cannot render "${join(dir, 'deck.pptx')}": model "text" does not accept images`)
    expect(kit.renderImages).toHaveBeenCalledOnce()
  })

  it.each([
    ['an agent route without a provider', { model: 'vision' }],
    ['an agent route without a model', { provider: 'visual' }],
  ] as const)('refuses %s as an unresolved route', async (_label, route) => {
    const { ctx, kit } = await setup()
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' }, agentOn(undefined, route))
    expect(text(result)).toBe(`Error: cannot render "${join(dir, 'deck.pptx')}": the current model route could not be resolved`)
    expect(kit.renderImages).not.toHaveBeenCalled()
  })

  it('refuses an image above the per-image attachment byte limit', async () => {
    const { ctx, kit } = await setup()
    const limit = ctx.get('attachments')!.imageLimits.maxImageBytes
    kit.renderImages.mockResolvedValueOnce({ images: [{ png: new Uint8Array(limit + 1), width: 1, height: 1, page: 1 }],
      pageCount: 1, dpi: 144, missingFonts: [] })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toContain(`exceeds the ${limit}-byte image limit`)
  })

  it('reports attachment refusals and passes other storage failures through', async () => {
    const { ctx, kit } = await setup()
    kit.renderImages.mockResolvedValueOnce({ images: [{ png: Buffer.from('not a png'), width: 1, height: 1, page: 1 }],
      pageCount: 1, dpi: 144, missingFonts: [] })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toContain(`cannot render "${join(dir, 'deck.pptx')}": `)
    vi.spyOn(ctx.get('attachments')!, 'saveImages').mockRejectedValueOnce(new Error('disk failure'))
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toContain('disk failure')
  })

  it('projects written files and their presentation metadata', async () => {
    const { ctx } = await setup()
    const output = ctx.tools.get('office_recalculate')!.output
    const value = { operation: 'recalculate', path: '/w/book.xlsx', file: '/h/out/book.xlsx', format: 'xlsx', bytes: 9, missingFonts: ['Aptos'] }
    expect(output.render({}, value)).toEqual([{ type: 'text', text: 'Recalculated /w/book.xlsx to xlsx (9 bytes): /h/out/book.xlsx\n'
      + 'Copy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.\nFonts not installed and substituted: Aptos.' }])
    expect(output.render({}, { ...value, operation: 'convert', format: 'pdf', pageCount: 1, missingFonts: [] })).toEqual([{ type: 'text',
      text: 'Converted /w/book.xlsx to pdf (9 bytes, 1 page): /h/out/book.xlsx\nCopy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.' }])
    expect(output.render({}, { ...value, pageCount: 2 })[0]).toMatchObject({ text: expect.stringContaining('(9 bytes, 2 pages)') as string })
    expect(output.presentationMeta?.({}, value)).toEqual({ path: '/w/book.xlsx', file: '/h/out/book.xlsx' })
  })

  it('reserves the full input limit for a source without a known size', async () => {
    const { ctx, kit } = await setup()
    const stat = ctx.fs.stat.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'stat').mockImplementation(async (target, statSignal) => {
      const info = await stat(target, statSignal)
      return info === undefined ? undefined : { version: info.version, type: info.type }
    })
    await office(ctx, { operation: 'render', input: 'deck.pptx' })
    expect(kit.renderImages.mock.calls[0]![0].source).not.toHaveProperty('bytes')
  })

  it('records the normalized dimensions of a reduced image', () => {
    const blocks = renderImagesContent({ operation: 'render', path: '/a.pdf', pageCount: 1, dpi: 72, missingFonts: [],
      images: [{ attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1, originalDimensions: { width: 2, height: 2 } }] })
    expect(blocks[1]).toEqual({ type: 'text', text: 'Image: 1x1 px' })
    expect(blocks[2]).toMatchObject({ attachment: { originalDimensions: { width: 2, height: 2 } } })
  })

  it.each([
    ['an opaque render as JPEG', false, 'image/jpeg'],
    ['a transparent render as WebP', true, 'image/webp'],
  ] as const)('returns the stored encoding when attachment normalization re-encodes %s', async (_label, translucent, mediaType) => {
    const { ctx, kit } = await setup({ attachments: { normalizedImageMaxPixels: 16 } })
    kit.renderImages.mockResolvedValueOnce({ images: [{ png: solidPng(8, translucent), width: 8, height: 8, page: 1 }],
      pageCount: 1, dpi: 144, missingFonts: [] })
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' })
    if (result.isError) throw new Error('render failed')
    expect(result.value).toMatchObject({ images: [{ mediaType, width: 4, height: 4, originalDimensions: { width: 8, height: 8 } }] })
    const block = result.content[2]
    if (block?.type !== 'image') throw new Error('missing image block')
    expect(block.attachment.mediaType).toBe(mediaType)
    await expect(ctx.get('attachments')!.readImage(block.attachment)).resolves.toMatchObject({ ref: { mediaType } })
  })

  it('returns stored dimensions when attachment normalization reduced the image', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.get('attachments')!, 'saveImages').mockResolvedValueOnce([{
      attachmentId: 'stored' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1, originalDimensions: { width: 4, height: 4 },
    }])
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' })
    if (result.isError) throw new Error('render failed')
    expect(result.value).toMatchObject({ images: [{ originalDimensions: { width: 4, height: 4 } }] })
  })

  it('refuses a rendered image that attachment storage reports as GIF', async () => {
    const { ctx } = await setup()
    vi.spyOn(ctx.get('attachments')!, 'saveImages').mockResolvedValueOnce([{
      attachmentId: 'stored' as never, mediaType: 'image/gif', bytes: 1, width: 1, height: 1,
    }])
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' })))
      .toContain(`cannot render "${join(dir, 'deck.pptx')}": the attachment service stored a rendered PNG as GIF`)
  })
})

describe('Office service failures', () => {
  const unavailableHint = ' Tell the user this operation is unavailable, or retry later if the cause may be temporary; do not substitute system soffice, npx, or another converter.'

  it('stays registered without the Office service, fails each call as unavailable, and uses the service once it is provided', async () => {
    const { ctx, kit } = await setup({ kit: false })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['office_render', 'office_convert', 'office_recalculate'])
    for (const [args, verb] of [
      [{ operation: 'render', input: 'deck.pptx' }, 'render'],
      [{ operation: 'convert', input: 'deck.pptx', format: 'pdf' }, 'convert'],
      [{ operation: 'recalculate', input: 'book.xlsx', format: 'xlsx' }, 'recalculate'],
    ] as const) {
      const result = await office(ctx, args)
      expect(result.isError).toBe(true)
      expect(text(result)).toBe(`Error: cannot ${verb} "${args.input}": The document converter is unavailable.${unavailableHint}`)
    }
    expect(kit.renderImages).not.toHaveBeenCalled()
    const missing = await office(ctx, { operation: 'convert', input: 'missing.pptx', format: 'pdf' })
    expect(text(missing)).toBe(`Error: cannot convert "missing.pptx": The document converter is unavailable.${unavailableHint}`)
    ctx.provide('officeKit', kit as never)
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' })
    expect(result.isError).toBe(false)
    expect(kit.renderImages).toHaveBeenCalledOnce()
  })

  const officeError = (code: OfficeKitErrorCode, message: string) => new OfficeKitError(code, message)

  it.each<[OfficeKitErrorCode, string, string]>([
    ['unavailable', 'LibreOffice Kit is not installed.', `deck.pptx": LibreOffice Kit is not installed.${unavailableHint}`],
    ['busy', 'The document converter has reached its admission limit.', 'Retry after other document operations finish.'],
    ['output-too-large', 'Selected page count exceeds maxPages.', 'Select fewer pages, a smaller range, or a lower dpi.'],
    ['invalid-request', 'Selected page lies outside the 3-page document.', 'deck.pptx": Selected page lies outside the 3-page document.'],
  ])('reports a %s render failure', async (code, message, expected) => {
    const { ctx, kit } = await setup()
    kit.renderImages.mockRejectedValueOnce(officeError(code, message))
    const result = await office(ctx, { operation: 'render', input: 'deck.pptx' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('reports conversion failures without a render hint and passes unclassified failures through', async () => {
    const { ctx, kit } = await setup()
    kit.convertTo.mockRejectedValueOnce(officeError('output-too-large', 'The converter output exceeds its byte limit.'))
    expect(text(await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' })))
      .toBe(`Error: cannot convert "${join(dir, 'deck.pptx')}": The converter output exceeds its byte limit.`)
    kit.recalculate.mockRejectedValueOnce(new TypeError('unexpected'))
    expect(text(await office(ctx, { operation: 'recalculate', input: 'book.xlsx', format: 'xlsx' }))).toContain('unexpected')
    kit.renderImages.mockRejectedValueOnce('engine string')
    expect((await office(ctx, { operation: 'render', input: 'deck.pptx' })).isError).toBe(true)
  })

  it('refuses a source that changed or grew after authorization', async () => {
    const { ctx, kit } = await setup()
    kit.renderImages.mockImplementationOnce(async (request) => {
      await writeFile(join(dir, 'deck.pptx'), 'changed pptx bytes')
      await readSource(request.source)
      throw new Error('unreachable')
    })
    expect(await office(ctx, { operation: 'render', input: 'deck.pptx' })).toMatchObject({ isError: true })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toContain('Rendered 1 image')
    kit.renderImages.mockImplementationOnce(async (request) => {
      await request.source.read(signal, 1)
      throw new Error('unreachable')
    })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' })))
      .toBe(`Error: cannot render "${join(dir, 'deck.pptx')}": The source exceeds the reserved byte capacity.`)
    kit.renderImages.mockImplementationOnce(async (request) => {
      vi.spyOn(ctx.fs, 'readBytes').mockImplementationOnce(async () => {
        await writeFile(join(dir, 'deck.pptx'), 'pptx bytes, then more')
        return new Uint8Array()
      })
      await readSource(request.source)
      throw new Error('unreachable')
    })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toBe(`Error: cannot render "${join(dir, 'deck.pptx')}": The source changed.`)
    kit.renderImages.mockImplementationOnce(async (request) => {
      vi.spyOn(ctx.fs, 'readBytes').mockRejectedValueOnce(new Error('read failure'))
      await readSource(request.source)
      throw new Error('unreachable')
    })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' }))).toContain('read failure')
  })

  it.each([
    ['render', 'renderImages', 'deck.pptx'], ['convert', 'convertTo', 'deck.pptx'], ['recalculate', 'recalculate', 'book.xlsx'],
  ] as const)('forwards %s cancellation to the Office service', async (operation, method, input) => {
    const { ctx, kit } = await setup()
    const controller = new AbortController()
    kit[method].mockImplementationOnce(async (_request, callSignal?: AbortSignal) => {
      controller.abort(new Error('caller cancelled'))
      callSignal?.throwIfAborted()
      throw new Error('unreachable')
    })
    const result = await office(ctx, { operation, input, ...operation === 'render' ? {} : { format: operation === 'convert' ? 'pdf' : 'xlsx' } }, agentOn('vision'), controller.signal)
    expect(result.isError).toBe(true)
    expect(kit[method].mock.calls[0]![1]?.aborted).toBe(true)
  })
})

describe('arguments and paths', () => {
  /** Refuse `args` with `message` after exactly `resolveCalls` filesystem resolutions. */
  async function expectRefusal(args: Record<string, unknown>, message: string, resolveCalls: number): Promise<void> {
    await mkdir(join(dir, 'folder.pptx'))
    const { ctx, kit } = await setup()
    const resolve = vi.spyOn(ctx.fs, 'resolve')
    const result = await office(ctx, args)
    expect(resolve).toHaveBeenCalledTimes(resolveCalls)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(kit.renderImages).not.toHaveBeenCalled()
    expect(kit.convertTo).not.toHaveBeenCalled()
    expect(kit.recalculate).not.toHaveBeenCalled()
  }

  it.each([
    ...['pdf', 'docx', 'odt', 'txt'].map(format => ['report.docx', format]),
    ...['pdf', 'xlsx', 'ods', 'csv'].map(format => ['book.xlsx', format]),
    ...['pdf', 'pptx', 'odp'].map(format => ['deck.pptx', format]),
  ])('converts %s to %s', async (input, format) => {
    const { ctx } = await setup()
    expect(await office(ctx, { operation: 'convert', input, format })).toMatchObject({ isError: false, value: { operation: 'convert', format } })
  })

  it.each([
    [{ operation: 'render', input: 'notes.txt' }, 'render accepts doc, docx, odt, xls, xlsx, ods, ppt, pptx, odp, or pdf files'],
    [{ operation: 'convert', input: 'paper.pdf', format: 'docx' }, 'convert accepts doc, docx, odt, xls, xlsx, ods, ppt, pptx, or odp files'],
    [{ operation: 'recalculate', input: 'deck.pptx', format: 'xlsx' }, 'recalculate accepts xls, xlsx, or ods workbooks'],
    [{ operation: 'render', input: '.pptx' }, 'render accepts'],
    [{ operation: 'convert', input: 'deck.pptx' }, 'format'],
    [{ operation: 'recalculate', input: 'book.xlsx' }, 'format'],
    [{ operation: 'convert', input: 'book.xlsx', format: 'pdf', sheet: 'A' }, 'sheet applies only to CSV conversion'],
    [{ operation: 'convert', input: 'book.xlsx', format: 'csv', sheet: ' ' }, 'sheet must be an exact worksheet name'],
    [{ operation: 'render', input: 'deck.pptx', format: 'pdf' }, 'format applies only to office_convert or office_recalculate'],
    [{ operation: 'convert', input: 'deck.pptx', format: 'pdf', pages: [1] }, 'pages applies only to office_render'],
    [{ operation: 'convert', input: 'book.xlsx', format: 'pdf', range: 'A1:B2' }, 'range applies only to office_render'],
    [{ operation: 'convert', input: 'deck.pptx', format: 'pdf', dpi: 96 }, 'dpi applies only to office_render'],
    [{ operation: 'recalculate', input: 'book.xlsx', format: 'xlsx', sheet: 'Data' }, 'sheet applies only to office_render or office_convert'],
    [{ operation: 'recalculate', input: 'book.xlsx', format: 'xlsx', pages: [1] }, 'pages applies only to office_render'],
    [{ operation: 'render', input: 'deck.pptx', output: 'deck.pdf' }, 'office_render does not accept output'],
    [{ operation: 'render', input: 'book.xlsx', pages: [1] }, 'pages does not apply to spreadsheets'],
    [{ operation: 'render', input: 'deck.pptx', pages: [] }, 'pages must list distinct one-based page numbers'],
    [{ operation: 'render', input: 'deck.pptx', pages: [0] }, 'pages must list distinct one-based page numbers'],
    [{ operation: 'render', input: 'deck.pptx', pages: [1, 1] }, 'pages must list distinct one-based page numbers'],
    [{ operation: 'render', input: 'deck.pptx', sheet: 'A' }, 'sheet applies only to spreadsheets'],
    [{ operation: 'render', input: 'book.xlsx', range: 'A1' }, 'range requires sheet'],
    [{ operation: 'render', input: 'book.xlsx', sheet: ' ' }, 'sheet must be an exact worksheet name'],
    [{ operation: 'render', input: 'deck.pptx', dpi: 23 }, 'dpi must be an integer from 24 to 600'],
    [{ operation: 'render', input: 'deck.pptx', dpi: 601 }, 'dpi must be an integer from 24 to 600'],
    [{ operation: 'convert', input: 'deck.pptx', format: 'xlsx' }, 'deck.pptx" to xlsx: this file converts to pdf, pptx, odp'],
    [{ operation: 'recalculate', input: 'book.xlsx', format: 'pdf' }, 'format'],
  ])('refuses %j before reading the filesystem', async (args, message) => {
    await expectRefusal(args, message, 0)
  })

  it.each([
    [{ operation: 'render', input: 'missing.pptx' }, 'missing.pptx": not found'],
    [{ operation: 'render', input: 'folder.pptx' }, 'folder.pptx": not a regular file'],
  ])('refuses %j after resolving the input path', async (args, message) => {
    await expectRefusal(args, message, 1)
  })

  it('returns the temporary file and the copy instruction for conversions and recalculations', async () => {
    const { ctx, kit } = await setup()
    const converted = await office(ctx, { operation: 'convert', input: 'book.xlsx', format: 'csv', sheet: 'Data' })
    expect(kit.convertTo).toHaveBeenCalledWith(expect.objectContaining({ extension: 'xlsx', format: 'csv', sheet: 'Data',
      output: { owner: expect.stringMatching(/^office-session-/u) as string, name: 'book.csv' } }), expect.any(AbortSignal))
    expect(text(converted)).toBe(`Converted ${join(dir, 'book.xlsx')} to csv (10 bytes): ${join(home, 'outputs', 'book.csv')}\n`
      + 'Copy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.')
    if (converted.isError) throw new Error('convert failed')
    expect(converted.value).toEqual({ operation: 'convert', path: join(dir, 'book.xlsx'), file: join(home, 'outputs', 'book.csv'),
      format: 'csv', bytes: 10, missingFonts: [] })
    expect(converted.meta).toEqual({ path: join(dir, 'book.xlsx'), file: join(home, 'outputs', 'book.csv') })
    await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' })
    expect(kit.convertTo.mock.calls[1]![0]).not.toHaveProperty('sheet')
    kit.recalculate.mockResolvedValueOnce({ path: join(home, 'outputs', 'book.ods'), bytes: 3, pageCount: 1, missingFonts: [] })
    const recalculated = await office(ctx, { operation: 'recalculate', input: 'book.xlsx', format: 'ods' })
    expect(kit.recalculate).toHaveBeenCalledWith(expect.objectContaining({ extension: 'xlsx', format: 'ods' }), expect.any(AbortSignal))
    if (recalculated.isError) throw new Error('recalculate failed')
    expect(recalculated.value).toMatchObject({ pageCount: 1 })
  })

  it('reads an input outside the workspace as the read tool does', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-office-outside-')))
    onTestFinished(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'shared.docx'), 'docx bytes')
    const { ctx, kit } = await setup()
    const result = await office(ctx, { operation: 'convert', input: join(outside, 'shared.docx'), format: 'pdf' })
    expect(result.isError).toBe(false)
    expect(Buffer.from(await readSource(kit.convertTo.mock.calls[0]![0].source)).toString()).toBe('docx bytes')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an input the filesystem refuses to read', async () => {
    await writeFile(join(dir, 'locked.docx'), 'docx bytes', { mode: 0o000 })
    const { ctx, kit } = await setup()
    const result = await office(ctx, { operation: 'convert', input: 'locked.docx', format: 'pdf' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('permission denied')
    expect(kit.convertTo).not.toHaveBeenCalled()
  })

  it('refuses a source replaced while confirming read access', async () => {
    const { ctx, kit } = await setup()
    const readByteRange = ctx.fs.readByteRange.bind(ctx.fs)
    vi.spyOn(ctx.fs, 'readByteRange').mockImplementationOnce(async (target, range, readSignal) => {
      const bytes = await readByteRange(target, range, readSignal)
      await writeFile(join(dir, 'deck.pptx'), 'replaced pptx bytes')
      return bytes
    })
    expect(text(await office(ctx, { operation: 'render', input: 'deck.pptx' })))
      .toBe(`Error: cannot render "${join(dir, 'deck.pptx')}": The source changed.`)
    expect(kit.renderImages).not.toHaveBeenCalled()
  })

  it('refuses a cached result once content reads are denied while metadata stays readable', async () => {
    const { ctx } = await setup({ kit: false })
    await ctx.plugin(OfficeKit, { outputDirectory: join(home, 'office-outputs') })
    const agent = agentOn('vision')
    const args = { operation: 'convert', input: 'deck.pptx', format: 'pdf' }
    expect((await office(ctx, args, agent)).isError).toBe(false)
    const denied = Object.assign(new Error('permission denied'), { code: 'FS_PERMISSION_DENIED' })
    vi.spyOn(ctx.fs, 'readBytes').mockRejectedValue(denied)
    vi.spyOn(ctx.fs, 'readByteRange').mockRejectedValue(denied)
    const refused = await office(ctx, args, agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('permission denied')
    expect(text(refused)).not.toContain('Converted')
  })

  it('refuses conversions when the execution world cannot read Host files', async () => {
    const { ctx, kit } = await setup()
    vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    expect(text(await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' })))
      .toContain('converted files are not available when the workspace is on a remote host')
    expect(kit.convertTo).not.toHaveBeenCalled()
    expect((await office(ctx, { operation: 'render', input: 'deck.pptx' })).isError).toBe(false)
  })
})

describe('PTC dispatch', () => {
  it('records nested render images and applies execution policy to the nested call', async () => {
    const { ctx } = await setup({ ptc: true })
    const runtime = ctx.ptcRuntime as FakeRuntime
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.office_render!({ input: 'deck.pptx' })
      return { output: [] }
    }
    const agent = { ...agentOn('vision'), ctx }
    await loadOffice(ctx, agent)
    const toolSet = await ctx.tools.resolve({ agent: agent as never, modelSelection: { provider: 'visual', model: 'vision' }, signal })
    onTestFinished(() => { toolSet.dispose() })
    const run = (args: Record<string, unknown>) => executeModelToolFixture(ctx, {
      signal, callId: ToolCallId(`run-${++calls}`), name: RUN_CODE_NAME, arguments: args, agent: agent as never,
      toolSet,
    })
    const result = await run({ code: 'await tools.office_render({ input: "deck.pptx" })', description: 'Render' })
    expect(result.isError).toBe(false)
    const dispatch = agent.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')
    expect(dispatch?.data.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.some(block => block.type === 'image')).toBe(false)
    expect(result.additionalContexts).toHaveLength(1)
    expect(result.additionalContexts?.[0]).toMatchObject({
      source: { kind: 'ptc-mode' }, content: dispatch?.data.content,
    })

    const denied: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name !== 'office_render') return next()
      denied.push(exec.name)
      return Promise.resolve({ kind: 'deny' as const, reason: 'office denied by policy' })
    }, { prepend: true })
    const refused = await run({ code: 'await tools.office_render({ input: "deck.pptx" })', description: 'Render' })
    expect(denied).toEqual(['office_render'])
    expect(text(refused)).toContain('office denied by policy')
  })
})

describe('output lifetime', () => {
  it('keeps a subagent conversion until the root Session of its tree is disposed', async () => {
    const { ctx } = await setup({ kit: false })
    await ctx.plugin(OfficeKit, { outputDirectory: join(home, 'office-outputs') })
    const root = agentOn('vision')
    const child = agentOn('vision')
    ctx.provide('subagents', { rootOf: (agent: object) => agent === child ? root : agent } as never)
    const converted = await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' }, child)
    if (converted.isError) throw new Error(text(converted))
    const { file } = converted.value as { file: string }
    expect(text(converted)).toContain('it may be deleted after a retention period or to free space, and is deleted when this conversation ends')
    expect((await readFile(file, 'utf8')).startsWith('%PDF-')).toBe(true)
    const sessionOf = (agent: object) => (agent as { session: Session }).session
    ctx.emit('session/disposed', sessionOf(child))
    await new Promise(resolve => setTimeout(resolve, 20))
    await access(file)
    ctx.emit('session/disposed', sessionOf(root))
    await vi.waitFor(async () => { await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' }) })
  })

  it('gives a conversion to the calling Session when its tree root is no longer live', async () => {
    const { ctx } = await setup({ kit: false })
    await ctx.plugin(OfficeKit, { outputDirectory: join(home, 'office-outputs') })
    const child = agentOn('vision')
    ctx.provide('subagents', { rootOf: () => { throw new SubagentError('agent has no active runtime owner', 'UNAUTHORIZED') } } as never)
    const converted = await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' }, child)
    if (converted.isError) throw new Error(text(converted))
    const { file } = converted.value as { file: string }
    await access(file)
    ctx.emit('session/disposed', (child as { session: Session }).session)
    await vi.waitFor(async () => { await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' }) })
  })

  it('reports other subagent tree failures unchanged', async () => {
    const { ctx } = await setup()
    ctx.provide('subagents', { rootOf: () => { throw new SubagentError('subagent tree is unavailable', 'UNSUPPORTED_CAPABILITY') } } as never)
    const converted = await office(ctx, { operation: 'convert', input: 'deck.pptx', format: 'pdf' })
    expect(converted.isError).toBe(true)
    expect(text(converted)).toContain('subagent tree is unavailable')
  })
})
