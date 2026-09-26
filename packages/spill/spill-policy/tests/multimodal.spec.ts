/** MCP admission, token retention, recovery files, and PTC forwarding together. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ImageBlock, LlmImageRequestPricing, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { deepSeekImageTokens } from '@deepseek-ai/dsh-llm-deepseek'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunSpec, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as SpillPolicy from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')

class TestAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024, maxImagesPerMessage: 10, maxMessageImageBytes: 10240,
    maxImagePixels: 1024, maxImageDimension: 1024,
    mediaTypes: ['image/png'] as const,
  }
  private ordinal = 0
  constructor(ctx: Context, readonly root: string) { super(ctx) }
  validateImage(): Promise<void> { return Promise.resolve() }
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${String(++this.ordinal).padStart(64, '0')}`),
      mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1,
    }
    await writeFile(this.imageHostPath(ref), input.data, { flag: 'wx' })
    return ref
  }
  override imageHostPath(ref: ImageAttachmentRef): string {
    return join(this.root, `${ref.attachmentId.slice(7)}.png`)
  }
  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return { ref, data: await readFile(this.imageHostPath(ref)) }
  }
}

class VisionAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  override imageRequestPricing(): LlmImageRequestPricing {
    return { priceImages: images => images.map(({ attachment }) => ({
      visualTokens: deepSeekImageTokens(attachment.width, attachment.height), text: '',
    })) }
  }
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('fixture does not stream') }
}

async function setup(content: JsonValue[], maxInlineTokens: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multimodal-spill-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'both' })
  const fsFiber = await ctx.plugin(FileSystem, { cwd: root })
  await ctx.plugin(TestAttachments, root)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['vision'], new VisionAdapter())
  await ctx.plugin(SpillPolicy, { maxInlineTokens })
  ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'inspect', rawName: 'inspect', description: 'Return text and screenshots',
    inputSchema: { type: 'object' }, call: async () => ({ content }),
  }))
  const session = Session.create(SessionId('mixed-spill'))
  const agent = { session, options: { provider: 'vision', model: 'vision' } } as Agent
  const execute = (name = 'inspect') => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('mixed-call'), name,
    arguments: name === 'run_code' ? { code: 'return await tools.inspect({})', description: 'Inspect a window' } : {}, agent,
  })
  return { ctx, execute, session, fsFiber }
}

const image = (): JsonValue => ({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' })
const text = (value: string): JsonValue => ({ type: 'text', text: value })

async function savedResult(content: readonly { type: string; text?: string }[]): Promise<string> {
  const flattened = content.map(block => block.text ?? '').join('')
  const match = /Full formatted result stored at: (.+?)\. Use read/.exec(flattened)
  if (match === null) throw new Error('missing spill path')
  return readFile(match[1]!, 'utf8')
}

describe('multimodal spill', () => {
  it('retains ordered end images and saves readable image addresses among the complete text', async () => {
    const original = [text('A'), image(), text('B'.repeat(20000)), image(), text('C')]
    const { execute } = await setup(original, 1000)
    const result = await execute()
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: original })
    expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
    const saved = await savedResult(result.content)
    expect(saved).toContain('B'.repeat(20000))
    expect(saved).not.toContain(PNG.toString('base64'))
    const paths = [...saved.matchAll(/\[Image: ("[^"\n]+")/g)].map(match => JSON.parse(match[1]!) as string)
    expect(paths).toHaveLength(2)
    for (const path of paths) expect(await readFile(path)).toEqual(PNG)
    const visual = result.content.filter((block): block is ImageBlock => block.type === 'image')
      .reduce((total, block) => total + deepSeekImageTokens(block.attachment.width, block.attachment.height) + 4, 0)
    expect(visual + estimateContent(result.content.filter(block => block.type === 'text'))).toBeLessThanOrEqual(1000)
  })

  it('omits a middle image as a whole and leaves its address in the complete result', async () => {
    const { execute } = await setup([text('A'.repeat(4000)), image(), text('C'.repeat(4000))], 200)
    const result = await execute()
    expect(result.content.every(block => block.type === 'text')).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Omitted 1 images.')
    expect(await savedResult(result.content)).toContain('[Image:')
  })

  it('keeps original images when their recovery paths cannot be resolved', async () => {
    const { ctx, execute } = await setup([text('A'.repeat(4000)), image()], 200)
    vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await execute()
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no readable attachment path'))
  })

  it('keeps original images when the route has no visual token calculator', async () => {
    const { ctx, execute } = await setup([text('A'.repeat(4000)), image()], 200)
    vi.spyOn(ctx.llm, 'imageRequestPricing').mockReturnValue(undefined)
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await execute()
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no image token calculator'))
  })

  it('preserves images after the execution filesystem is unmounted', async () => {
    const { ctx, execute, fsFiber } = await setup([text('A'.repeat(4000)), image()], 200)
    await fsFiber.dispose()
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await execute()
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no readable attachment path'))
  })

  it('preserves direct programmatic image results without an active model route', async () => {
    const { ctx } = await setup([], 200)
    const attachment = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png' })
    ctx.tools.register(defineContentToolFixture({
      name: 'offline_image', description: 'Read a durable image', parameters: {},
      async execute() { return [{ type: 'image', attachment }] },
    }))
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('offline'), name: 'offline_image', arguments: {} })
    expect(result.content).toEqual([{ type: 'image', attachment }])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('no image token calculator'))
  })

  it('preserves content when the image calculator loses an occurrence', async () => {
    const { ctx, execute } = await setup([text('A'.repeat(4000)), image()], 200)
    vi.spyOn(ctx.llm, 'imageRequestPricing').mockReturnValue({ priceImages: () => [] })
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const result = await execute()
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('inconsistent occurrence count'))
  })

  it.each([false, true])('forwards omitted-image recovery only for successful PTC results (failure: %s)', async (failure) => {
    const original = [text('A'.repeat(4000)), image(), text('C'.repeat(4000))]
    const { ctx, execute, session } = await setup(original, 200)
    if (failure) {
      const attachment = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png' })
      ctx.on('tools/execute', async (exec, next) => {
        if (exec.name !== 'inspect') return next()
        await next()
        return { isError: true, error: { message: 'capture failed' }, content: [
          { type: 'text', text: 'A'.repeat(4000) }, { type: 'image', attachment },
          { type: 'text', text: 'C'.repeat(4000) },
        ] }
      })
    }
    class BindingRuntime extends PtcRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fixture'
      resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: 120000 } }
      async run(spec: PtcRunSpec): Promise<PtcRunResult> {
        const binding = spec.bindings.find(item => item.global === 'tools')?.functions.inspect
        if (binding === undefined) throw new Error('missing inspect binding')
        if (failure) await expect(binding({})).rejects.toThrow('capture failed')
        else expect(await binding({})).toEqual({ content: original })
        return { logs: [], value: 'complete' }
      }
    }
    await ctx.plugin(BindingRuntime)
    const result = await execute('run_code')
    expect(result.isError).toBe(false)
    if (failure) {
      expect(result.additionalContexts).toBeUndefined()
      return
    }
    expect(result.additionalContexts).toHaveLength(1)
    const context = result.additionalContexts?.[0]
    expect(context?.content.every(block => block.type === 'text')).toBe(true)
    expect(JSON.stringify(context?.content)).toContain('Omitted 1 images.')
    const logged = session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')
    if (logged?.type !== 'tool/ptc-dispatch') throw new Error('missing dispatch')
    expect(logged.data.content).toEqual(context?.content)
  })
})
