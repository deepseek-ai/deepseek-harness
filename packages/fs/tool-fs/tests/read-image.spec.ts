/**
 * The `read_image` tool over the REAL local filesystem and attachment store:
 * extension routing, extension-less content sniffing (attachment object paths
 * included), the strict image-modality gate (every refusal arm), durable
 * commit + image-block rendering, attachment admission failures, and the
 * regression that `read` keeps its text-only contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { ToolCallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Config as ToolConfig } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { AttachmentError, AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import {
  applyReadImageTool,
  formatImageReadOutput,
  imageMediaTypeForPath,
  imageRefFromValue,
  sniffImageMediaType,
} from '../src/read-image.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
/** 3x3 red PNG used to trip a tiny configured pixel limit. */
const PNG_3X3 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==', 'base64')
/** 1x1 red GIF (GIF89a). */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const testToolSignal = new AbortController().signal

/** Exact-route fake adapter; `stream` is unreachable in these tests. */
class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly models: LlmModelInfo[],
    private readonly resolvedModels: LlmModelInfo[] = models,
  ) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = this.resolvedModels.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: resolved?.name ?? model,
      ...resolved?.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('read_image tests never stream')
  }
}

/** In-process PTC mode seam fake that invokes the real registry bindings. */
class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-image-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-read-image-home-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

interface SetupOptions {
  models?: LlmModelInfo[]
  resolvedModels?: LlmModelInfo[]
  attachments?: boolean
  llm?: boolean
  storeConfig?: { maxImageBytes?: number; maxImagePixels?: number; maxImageDimension?: number; maxMessageImageBytes?: number }
  toolMode?: ToolConfig['mode']
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: options.toolMode ?? 'native' })
  if (options.toolMode === 'ptc' || options.toolMode === 'both') {
    await ctx.plugin(FakeRuntime)
  }
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  if (options.attachments !== false) {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home, ...options.storeConfig })
  }
  if (options.llm !== false) {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['visual'], new CatalogAdapter(options.models ?? [
      { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
      { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
      { provider: 'visual', id: 'legacy-model', name: 'Legacy' },
    ], options.resolvedModels))
  }
  await ctx.plugin(ToolFs)
  return ctx
}

/** A fake calling agent pinned to one routed provider/model. */
function agentOn(model: string | undefined, provider = 'visual', messages: readonly Message[] = []): object {
  return {
    options: {},
    session: {
      header: { cwd: dir },
      requestHeader: () => (model === undefined ? undefined : { config: { provider, model } }),
      deriveMessages: () => [...messages],
      append: () => undefined,
    },
  }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`img-call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

function readImage(ctx: Context, args: unknown, agent?: object) {
  return call(ctx, 'read_image', args, agent)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('imageMediaTypeForPath', () => {
  it('maps the four extensions case-insensitively and rejects everything else', () => {
    expect(imageMediaTypeForPath('a.png')).toBe('image/png')
    expect(imageMediaTypeForPath('a.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('b.jpeg')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('c.webp')).toBe('image/webp')
    expect(imageMediaTypeForPath('d.Gif')).toBe('image/gif')
    expect(imageMediaTypeForPath('note.txt')).toBeUndefined()
    expect(imageMediaTypeForPath('png')).toBeUndefined()
  })
})

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('sniffImageMediaType', () => {
  it('identifies each supported container from its complete signature', () => {
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png')
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMediaType(ascii('GIF87a...'))).toBe('image/gif')
    expect(sniffImageMediaType(ascii('GIF89a...'))).toBe('image/gif')
    expect(sniffImageMediaType(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('returns undefined for other bytes, incomplete signatures, and non-WebP RIFF containers', () => {
    expect(sniffImageMediaType(new Uint8Array())).toBeUndefined()
    expect(sniffImageMediaType(ascii('plain text'))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8]))).toBeUndefined()
    expect(sniffImageMediaType(ascii('GIF90a'))).toBeUndefined()
    expect(sniffImageMediaType(ascii('RIFF\0\0\0\0WAVE'))).toBeUndefined()
    expect(sniffImageMediaType(ascii('RIFF\0\0\0'))).toBeUndefined()
  })
})

describe('imageRefFromValue', () => {
  it('re-brands with and without the optional display name', () => {
    const base = { attachmentId: 'sha256:00', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    expect(imageRefFromValue(base)).toEqual(base)
    expect(imageRefFromValue({ ...base, name: 'a.png' })).toEqual({ ...base, name: 'a.png' })
    expect(imageRefFromValue({ ...base, originalDimensions: { width: 4, height: 2 } }))
      .toEqual({ ...base, originalDimensions: { width: 4, height: 2 } })
  })
})

describe('read_image happy path', () => {
  it('commits the bytes durably and renders the envelope beside an image block', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))

    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(2)
    const image = result.content[1] as { type: string; attachment: ImageAttachmentRef }
    expect(image.type).toBe('image')
    expect(image.attachment.mediaType).toBe('image/png')
    expect(image.attachment.width).toBe(1)
    expect(image.attachment.height).toBe(1)
    expect(image.attachment.bytes).toBe(PNG_1X1.length)
    expect(image.attachment.name).toBe('red.png')
    expect(image.attachment.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(text(result)).toBe(formatImageReadOutput(join(dir, 'red.png'), {
      attachmentId: image.attachment.attachmentId,
      mediaType: 'image/png',
      bytes: PNG_1X1.length,
      width: 1,
      height: 1,
    }))

    // The committed object must read back verbatim through the store.
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('expected the attachment service')
    const stored = await attachments.readImage(image.attachment)
    expect(Buffer.from(stored.data)).toEqual(PNG_1X1)
  })

  it('commits a GIF durably and renders the normalized envelope beside an image block', async () => {
    await writeFile(join(dir, 'red.gif'), GIF_1X1)
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'red.gif' }, agentOn('vision-model'))

    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(2)
    const image = result.content[1] as { type: string; attachment: ImageAttachmentRef }
    expect(image.type).toBe('image')
    // Normalization re-encodes this transparent 1x1 GIF as WebP: the bytes do
    // not pass through unchanged, only the source file name survives.
    expect(image.attachment.mediaType).toBe('image/webp')
    expect(image.attachment.width).toBe(1)
    expect(image.attachment.height).toBe(1)
    expect(image.attachment.bytes).toBe(72)
    expect(image.attachment.name).toBe('red.gif')
    expect(image.attachment.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(text(result)).toBe(formatImageReadOutput(join(dir, 'red.gif'), {
      attachmentId: image.attachment.attachmentId,
      mediaType: 'image/webp',
      bytes: 72,
      width: 1,
      height: 1,
    }))

    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('expected the attachment service')
    const stored = await attachments.readImage(image.attachment)
    expect(Buffer.from(stored.data).subarray(0, 4).toString()).toBe('RIFF')
  })

  it('emits fs/observed for the read image', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const observed: string[] = []
    ctx.on('fs/observed', target => void observed.push(target.displayPath))
    await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(observed).toEqual([join(dir, 'red.png')])
  })

  it('falls back to agent options when no request header exists yet', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const agent = {
      options: { provider: 'visual', model: 'vision-model' },
      session: { header: { cwd: dir }, requestHeader: () => undefined },
    }
    const result = await readImage(ctx, { file_path: 'red.png' }, agent)
    expect(result.isError).toBe(false)
  })

  it('forwards a nested PTC mode image through the outer run_code context', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ toolMode: 'ptc' })
    const runtime = ctx.codeRuntime as FakeRuntime
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.read_image!({ file_path: 'red.png' })
      return { logs: [], value }
    }

    const result = await call(ctx, RUN_CODE_NAME, {
      code: 'return await tools.read_image({ file_path: "red.png" })',
      description: 'Read the image through PTC mode',
    }, agentOn('vision-model'))

    expect(result.isError).toBe(false)
    expect(result.content.every(block => block.type === 'text')).toBe(true)
    expect(result.additionalContexts).toHaveLength(1)
    const forwarded = result.additionalContexts?.[0]?.content
    expect(forwarded).toHaveLength(2)
    expect(forwarded?.[0]?.type).toBe('text')
    expect(forwarded?.[0]?.type === 'text' ? forwarded[0].text : '').toContain('<type>image</type>')
    expect(forwarded?.[1]).toMatchObject({
      type: 'image',
      attachment: { mediaType: 'image/png', width: 1, height: 1 },
    })
  })
})

/** The mounted attachment service, asserted present for direct store calls. */
function mountedStore(ctx: Context): AttachmentStore {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('expected the attachment service')
  return attachments
}

/** The host object path behind a reference, asserted present for the local store. */
function objectPathOf(attachments: AttachmentStore, ref: ImageAttachmentRef): string {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) throw new Error('expected a host-file-backed store')
  return hostPath
}

describe('extension-less paths', () => {
  it('reads a normalized attachment object path directly and dedups to the stored reference', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const first = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(first.isError).toBe(false)
    const ref = (first.content[1] as { attachment: ImageAttachmentRef }).attachment
    const attachments = mountedStore(ctx)
    const objectPath = objectPathOf(attachments, ref)

    const second = await readImage(ctx, { file_path: objectPath }, agentOn('vision-model'))
    expect(second.isError).toBe(false)
    const reread = (second.content[1] as { attachment: ImageAttachmentRef }).attachment
    expect(reread.attachmentId).toBe(ref.attachmentId)
    expect(reread.mediaType).toBe('image/png')
    expect(text(second)).toContain(`<path>${objectPath}</path>`)
  })

  it('reads an ordinary extension-less image file by sniffing its content', async () => {
    await writeFile(join(dir, 'avatar'), PNG_1X1)
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'avatar' }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    const image = result.content[1] as { attachment: ImageAttachmentRef }
    expect(image.attachment.mediaType).toBe('image/png')
    expect(image.attachment.name).toBe('avatar')
  })

  it('pins the trailing-dot refusal and reads a dotfile through sniffing', async () => {
    await writeFile(join(dir, '.hidden'), PNG_1X1)
    const ctx = await setup()
    const trailingDot = await readImage(ctx, { file_path: 'foo.' }, agentOn('vision-model'))
    expect(trailingDot.isError).toBe(true)
    expect(text(trailingDot)).toContain('cannot read "foo.": the . extension does not declare a supported image format')

    const dotfile = await readImage(ctx, { file_path: '.hidden' }, agentOn('vision-model'))
    expect(dotfile.isError).toBe(false)
    const image = dotfile.content[1] as { attachment: ImageAttachmentRef }
    expect(image.attachment.mediaType).toBe('image/png')
    expect(image.attachment.name).toBe('.hidden')
  })

  it('refuses extension-less bytes that are not a supported image', async () => {
    await writeFile(join(dir, 'notes'), 'plain text, not an image')
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'notes' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`cannot read "${join(dir, 'notes')}": the file content is not a supported image format`)
  })

  it('explains extension-less bytes that sniff as an image but do not decode', async () => {
    await writeFile(join(dir, 'broken'), PNG_1X1.subarray(0, 16))
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'broken' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('do not decode as a supported PNG/JPEG/WebP/GIF image')
  })

  it('applies the deployment media-type policy to the sniffed format', async () => {
    /** Store whose deployment accepts JPEG only; sniffed PNG bytes must refuse before any save. */
    class JpegOnlySniffStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/jpeg'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        throw new Error('unreachable: the sniffed-format policy refuses before validation')
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        throw new Error('unreachable: the sniffed-format policy refuses before save')
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    await writeFile(join(dir, 'avatar'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    await ctx.plugin(JpegOnlySniffStore)
    const result = await readImage(ctx, { file_path: 'avatar' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('image/png images are not accepted by this deployment')
  })

  it('names a signature/decoded-format disagreement on an extension-less path', async () => {
    /** Store whose admission reports a media-type mismatch; the tool cannot blame an extension. */
    class MismatchStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/png'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.resolve()
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    await writeFile(join(dir, 'sniffed'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    await ctx.plugin(MismatchStore)
    const result = await readImage(ctx, { file_path: 'sniffed' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the file signature claims image/png, but the bytes decode as a different image format')
  })
})

describe('strict image-modality gate', () => {
  it('accepts an exact visual route even when the advisory model catalog omits it', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({
      models: [],
      resolvedModels: [
        { provider: 'visual', id: 'hidden-vision', name: 'Hidden Vision', inputModalities: ['text', 'image'] },
      ],
    })
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('hidden-vision'))
    expect(result.isError).toBe(false)
  })

  it.each([
    ['a text-only model', 'text-model'],
    ['a model without declared modalities', 'legacy-model'],
    ['a model absent from the catalog', 'unknown-model'],
  ])('refuses on %s', async (_label, model) => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn(model))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not declare image input')
  })

  it('refuses when the route cannot be resolved (no agent, or no header and no options)', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const noAgent = await readImage(ctx, { file_path: 'red.png' })
    expect(noAgent.isError).toBe(true)
    expect(text(noAgent)).toContain('route could not be resolved')

    const noRoute = await readImage(ctx, { file_path: 'red.png' }, agentOn(undefined))
    expect(noRoute.isError).toBe(true)
    expect(text(noRoute)).toContain('route could not be resolved')
  })

  it('refuses when no llm service is mounted', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ llm: false })
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('route could not be resolved')
  })
})

describe('argument and service preconditions', () => {
  it('rejects an empty path and a non-image extension', async () => {
    const ctx = await setup()
    const empty = await readImage(ctx, { file_path: '   ' }, agentOn('vision-model'))
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('non-empty')

    const nonImage = await readImage(ctx, { file_path: 'notes.txt' }, agentOn('vision-model'))
    expect(nonImage.isError).toBe(true)
    expect(text(nonImage)).toContain('the .txt extension does not declare a supported image format')
  })

  it('refuses when no attachment service is mounted', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    expect(ctx.tools.get('read_image')).toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('read_image')
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "read_image"')
  })

  it('defensively refuses execution without an attachment service', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    applyReadImageTool(ctx)
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no attachment service is mounted')
  })

  it('refuses a media type the deployment does not accept', async () => {
    /** Store whose deployment accepts JPEG only. */
    class JpegOnlyStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/jpeg'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        throw new Error('unreachable: admission refuses before validation')
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        throw new Error('unreachable: admission refuses before save')
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    const ctx = await setup({ attachments: false })
    await ctx.plugin(JpegOnlyStore)
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('image/png images are not accepted by this deployment')
  })
})

describe('image admission failures', () => {
  it('explains how to repair a declared/actual media-type mismatch', async () => {
    await writeFile(join(dir, 'wrong.jpg'), PNG_1X1)
    const ctx = await setup()
    const result = await readImage(ctx, { file_path: 'wrong.jpg' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the .jpg extension declares image/jpeg')
    expect(text(result)).toContain('rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats')
  })

  it('caps an extension-less read at maxImageBytes before format detection', async () => {
    await writeFile(join(dir, 'red'), PNG_1X1)
    const ctx = await setup({ storeConfig: { maxImageBytes: PNG_1X1.length - 1 } })
    const result = await readImage(ctx, { file_path: 'red' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeds')
  })

  it('honors the tighter per-message aggregate byte bound', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ storeConfig: { maxMessageImageBytes: PNG_1X1.length - 1 } })
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeds')
  })

  it('surfaces the pixel limit from the attachment admission', async () => {
    await writeFile(join(dir, 'big.png'), PNG_3X3)
    const ctx = await setup({ storeConfig: { maxImagePixels: 4 } })
    const result = await readImage(ctx, { file_path: 'big.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeds the 4-pixel decoded-size limit')
    expect(text(result)).toContain('downscale the image and read the smaller copy')
  })

  it('surfaces the per-side limit from attachment admission', async () => {
    await writeFile(join(dir, 'wide.png'), PNG_3X3)
    const ctx = await setup({ storeConfig: { maxImageDimension: 2 } })
    const result = await readImage(ctx, { file_path: 'wide.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at least one image side exceeds the 2px limit')
    expect(text(result)).toContain('downscale the image and read the smaller copy')
  })

  it('passes storage faults and non-attachment failures through unchanged', async () => {
    /** Store whose commit fails with a configurable error; admission itself passes. */
    class FailingStore extends AttachmentStore {
      static failure: unknown
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/png'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.resolve()
      }

      async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        throw FailingStore.failure
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    await ctx.plugin(FailingStore)

    FailingStore.failure = new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED')
    const storageFault = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(storageFault.isError).toBe(true)
    expect(text(storageFault)).toContain('Unable to persist image attachment.')

    FailingStore.failure = new AttachmentError(
      'The 16-bit PNG could not be converted to the normalized 8-bit sRGB form.',
      'ATTACHMENT_WRITE_FAILED',
    )
    const sixteenBit = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(text(sixteenBit)).toContain(
      `cannot read "${join(dir, 'red.png')}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`,
    )

    FailingStore.failure = new AttachmentError('Image cannot be encoded within the configured normalized-image byte cap.', 'IMAGE_TOO_LARGE')
    const overBudget = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(overBudget.isError).toBe(true)
    expect(text(overBudget)).toContain('cannot be stored within the deployment\'s byte limits; downscale the image and read the smaller copy')

    FailingStore.failure = new Error('unrelated infrastructure failure')
    const unrelated = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(unrelated.isError).toBe(true)
    expect(text(unrelated)).toContain('unrelated infrastructure failure')
  })

  it('reports a missing image file and a directory target through the fs vocabulary', async () => {
    await mkdir(join(dir, 'folder.png'))
    const ctx = await setup()
    const observed: { path: string; kind: string }[] = []
    ctx.on('fs/observed', (target, observation) => void observed.push({ path: target.displayPath, kind: observation.kind }))
    const missing = await readImage(ctx, { file_path: 'absent.png' }, agentOn('vision-model'))
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('not found')
    expect(observed).toEqual([{ path: join(dir, 'absent.png'), kind: 'absent' }])

    const directory = await readImage(ctx, { file_path: 'folder.png' }, agentOn('vision-model'))
    expect(directory.isError).toBe(true)
    expect(text(directory)).toContain('not a regular file')
  })

  it('omits the display name when the store returns a reference without one', async () => {
    /** Store echoing a fixed nameless reference; deployments may strip names entirely. */
    class NamelessStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/png'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.resolve()
      }

      async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return { attachmentId: AttachmentId('sha256:feed'), mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    await ctx.plugin(NamelessStore)
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    const image = result.content[1] as { attachment: ImageAttachmentRef }
    expect(image.attachment.name).toBeUndefined()
  })

  it('names the on-disk dimensions and coordinate multiplier when storage downscales', async () => {
    /** Store whose normalized image halves the input on both sides. */
    class DownscalingStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = Object.freeze({
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 100,
        maxImageDimension: 2000,
        mediaTypes: Object.freeze(['image/png'] as const),
      })

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.resolve()
      }

      async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return {
          attachmentId: AttachmentId('sha256:feed'),
          mediaType: input.mediaType,
          bytes: 7,
          width: 2,
          height: 1,
          originalDimensions: { width: 4, height: 2 },
        }
      }

      readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        throw new Error('unreachable in this test')
      }
    }
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup({ attachments: false })
    await ctx.plugin(DownscalingStore)
    const result = await readImage(ctx, { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('image/png image, 2x1 px, 7 bytes (downscaled from 4x2 px; multiply coordinates by 2.00 to locate features in the original file)')
  })

  it('names per-axis multipliers when integer rounding makes the ratios differ', () => {
    const envelope = formatImageReadOutput('/img/photo.jpg', {
      attachmentId: 'sha256:feed', mediaType: 'image/jpeg', bytes: 9, width: 2, height: 1,
      originalDimensions: { width: 5, height: 2 },
    })
    expect(envelope).toContain('downscaled from 5x2 px; multiply x coordinates by 2.50 and y coordinates by 2.00 to locate features in the original file')
  })
})

describe('registration surface', () => {
  it('withdraws read_image when the tool-fs fiber or the attachment store is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    const attachmentsFiber = await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    const toolFsFiber = await ctx.plugin(ToolFs)
    const names = () => ctx.tools.schemas().map(schema => schema.name).sort()
    expect(names()).toEqual(['edit', 'read', 'read_image', 'write'])

    // Disposing only the attachment store tears down the scoped inject fiber:
    // read_image withdraws while the unconditional tools stay registered.
    await attachmentsFiber.dispose()
    expect(names()).toEqual(['edit', 'read', 'write'])

    // Remounting the store restores the conditional registration.
    const remounted = await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    expect(names()).toEqual(['edit', 'read', 'read_image', 'write'])

    // Disposing the whole plugin withdraws every tool, read_image included.
    await toolFsFiber.dispose()
    expect(names()).toEqual([])
    await remounted.dispose()
  })

  it('declares read_image parallel-safe and presents a read-family card', async () => {
    const ctx = await setup()
    expect(ctx.tools.executionMode({
      signal: testToolSignal, callId: ToolCallId('img-parallel'), name: 'read_image', arguments: { file_path: 'a.png' },
    })).toEqual({ kind: 'parallel' })
    expect(ctx.tools.get('read_image')?.presentCall?.({ file_path: 'shot.png' })).toEqual({
      card: 'generic',
      title: 'Read image shot.png',
      kind: 'read',
      locations: [{ path: 'shot.png' }],
    })
  })
})

describe('read keeps its text-only contract', () => {
  it('still refuses a PNG as a binary file and line-numbers text', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    await writeFile(join(dir, 'note.txt'), 'hello\nworld')
    const ctx = await setup()

    const png = await call(ctx, 'read', { file_path: 'red.png' }, agentOn('vision-model'))
    expect(png.isError).toBe(true)
    expect(text(png)).toContain('binary file')

    const txt = await call(ctx, 'read', { file_path: 'note.txt' }, agentOn('text-model'))
    expect(txt.isError).toBe(false)
    expect(text(txt)).toContain('1: hello')
    expect(text(txt)).toContain('<type>file</type>')
  })
})

describe('image result presentation', () => {
  /** A canonical committed reference, shaped like a real saveImage outcome. */
  const REF = {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png' as const,
    bytes: 24_588,
    width: 1496,
    height: 260,
    name: 'card.png',
  }
  const VALUE = { path: '/w/app/shots/card.png', image: REF }

  it('persists the path only, leaving the reference to the result content', async () => {
    // The settled content already carries the image block with the complete
    // reference, so copying it into meta would keep two records of one fact and a
    // post-execute content replacement would strand the stale copy.
    const ctx = await setup()
    const meta = ctx.tools.get('read_image')?.output.presentationMeta?.({ file_path: 'shots/card.png' }, VALUE)
    expect(meta).toEqual({ path: VALUE.path })
  })

  it('carries the committed reference in the result content, not in meta', async () => {
    // Proves the single source of truth on the path a live call actually takes.
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const ctx = await setup()
    const result = await call(ctx, 'read_image', { file_path: 'red.png' }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(result.meta).toEqual({ path: join(dir, 'red.png') })
    const image = result.content.find(block => block.type === 'image')
    expect(image?.attachment.width).toBe(1)
    expect(image?.attachment.height).toBe(1)
    expect(image?.attachment.attachmentId).toMatch(/^sha256:/u)
  })
})
