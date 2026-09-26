/** Real attachments, filesystem recovery, Node PTC, and DeepSeek image request bytes without a desktop or API key. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import {
  createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, LlmRuntime,
  resolveImageAttachmentAccess, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { deepSeekImageRequestPricing, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { prepareImages } from '@deepseek-ai/dsh-llm-deepseek/src/images.ts'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import sharp from 'sharp'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as SpillPolicy from '../src/index.ts'

const CAP = 12500
const MODEL = 'vision-fixture'
const LONG = `${'X'.repeat(100)}\n`.repeat(600)
const SMALL = 'S'.repeat(36000)
const connection = resolveAdapterOptions({ models: [{ id: MODEL, inputModalities: ['text', 'image'] }] })
const text = (value: string): ContentBlock => ({ type: 'text', text: value })
const textOf = (content: readonly ContentBlock[]): string => content.filter(block => block.type === 'text').map(block => block.text).join('')
const imagesOf = (content: readonly ContentBlock[]): ImageBlock[] => content.filter((block): block is ImageBlock => block.type === 'image')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-recovery-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'both' })
  await ctx.plugin(FileSystem, { cwd: root })
  await ctx.plugin(LocalAttachments, { dshHome: join(root, 'home') })
  await ctx.plugin(ToolFs)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const access = (ref: ImageAttachmentRef) => resolveImageAttachmentAccess(
    ctx.attachments, path => ctx.fs.processPathFromHostPath(path), ref,
  )
  const pricing = deepSeekImageRequestPricing(connection, MODEL, access)
  class VisionRoute extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] as Array<'text' | 'image'> }
    }
    override imageRequestPricing() { return pricing }
    stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('keyless fixture does not infer') }
  }
  ctx.llm.registerAdapter(['vision'], new VisionRoute())
  await ctx.plugin(SpillPolicy, { maxInlineTokens: CAP })
  const session = ctx.sessions.create(SessionId('recovery'), { meta: { cwd: root } })
  const agent = { session, options: { provider: 'vision', model: MODEL }, ctx } as Agent
  let ordinal = 0
  const execute = (name: string, args: JsonValue = {}) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`recovery-${++ordinal}`), agent, signal: new AbortController().signal,
  })
  const red = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const blue = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#0000ff' } }).png().toBuffer()
  const green = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#00ff00' } }).png().toBuffer()
  const image = (data: Buffer): JsonValue => ({ type: 'image', mimeType: 'image/png', data: data.toString('base64') })
  const originals: Record<string, JsonValue[]> = {
    ends: [{ type: 'text', text: 'A' }, image(red), { type: 'text', text: LONG }, image(blue), { type: 'text', text: 'C' }],
    middle: [{ type: 'text', text: LONG }, image(green), { type: 'text', text: LONG }],
    small: [{ type: 'text', text: SMALL }],
  }
  const gates = new Map<string, () => Promise<void>>()
  for (const [name, content] of Object.entries(originals)) {
    ctx.tools.register({
      ...createMcpToolDefinition(ctx, {
        name, rawName: name, description: 'Return a fixed text and image sequence.', inputSchema: { type: 'object' },
        call: async () => { await gates.get(name)?.(); return { content } },
      }),
      isConcurrencySafe: () => true,
    })
  }
  const cost = (content: ContentBlock[]) => estimateContent(content.filter(block => block.type === 'text'))
    + pricing.priceImages(imagesOf(content)).reduce((sum, price) => sum + price.visualTokens + estimateContent([text(price.text)]), 0)
  const requestImages = async (content: ContentBlock[], contexts: UserMessage[] = []) => {
    const callId = ToolCallId('visible-result')
    const history = [
      createUserMessage({ source: { kind: 'user' }, content: [text('Inspect the supplied images.')] }),
      createAssistantMessage({ source: { provider: 'vision', model: MODEL }, content: [
        { type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' },
      ] }),
      createToolResultMessage({ callId, content, isError: false }),
      ...contexts,
    ]
    const prepared = await prepareImages(history, connection, MODEL, ctx.attachments, access, new AbortController().signal)
    const body = serialize({ provider: 'vision', model: MODEL, messages: history }, connection, prepared.messages, prepared.versions, access)
    const blocks = body.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? block.content : [block]))
    const images = blocks.filter(block => block.type === 'image')
    return Promise.all(images.map(async (block) => {
      if (block.source.type !== 'base64') throw new Error('expected prepared inline image bytes')
      const data = Buffer.from(block.source.data, 'base64')
      const { dominant } = await sharp(data).stats()
      return dominant.r > 200 ? 'red' : dominant.g > 200 ? 'green' : dominant.b > 200 ? 'blue' : 'unexpected'
    }))
  }
  return { ctx, root, session, execute, originals, green, cost, requestImages, gates }
}

describe('multimodal recovery through real providers', () => {
  it('keeps a large single-image read inside a fresh 12500-token budget', async () => {
    const { ctx, root, green, execute, cost, requestImages } = await setup()
    const saves = vi.spyOn(ctx.spillStore, 'saveText')
    const path = join(root, 'large.png')
    await writeFile(path, green)
    const result = await execute('read_image', { file_path: path })
    expect(result.isError).toBe(false)
    expect(imagesOf(result.content)).toHaveLength(1)
    expect(cost(result.content)).toBeLessThanOrEqual(CAP)
    expect(saves).not.toHaveBeenCalled()
    expect(await requestImages(result.content)).toEqual(['green'])
  })

  it('retains two distinct end images in both the tool result and DeepSeek request', async () => {
    const { execute, originals, cost, requestImages } = await setup()
    const result = await execute('ends')
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ content: originals.ends })
    expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
    expect(textOf(result.content)).toContain('Omitted')
    expect(cost(result.content)).toBeLessThanOrEqual(CAP)
    expect(await requestImages(result.content)).toEqual(['red', 'blue'])
  })

  it('recovers an omitted middle image through read and read_image into the next request', async () => {
    const { ctx, execute, cost, requestImages } = await setup()
    const saves = vi.spyOn(ctx.spillStore, 'saveText')
    const omitted = await execute('middle')
    expect(omitted.isError).toBe(false)
    expect(textOf(omitted.content)).toContain('Omitted 1 images.')
    expect(await requestImages(omitted.content)).toEqual([])
    const locator = /Full formatted result stored at: (.+?)\. Use read/.exec(textOf(omitted.content))?.[1]
    if (locator === undefined) throw new Error('missing complete result locator')
    const full = await readFile(locator, 'utf8')
    expect(full.startsWith(LONG)).toBe(true)
    expect(full.endsWith(LONG)).toBe(true)
    expect(full).not.toContain('base64')
    const read = await execute('read', { file_path: locator, offset: 600, limit: 8 })
    expect(read.isError).toBe(false)
    const address = /\[Image: ("[^"\n]+")/.exec(textOf(read.content))?.[1]
    if (address === undefined) throw new Error('read did not expose the omitted image address')
    const path = JSON.parse(address) as string
    const recovered = await execute('read_image', { file_path: path })
    expect(recovered.isError).toBe(false)
    const images = imagesOf(recovered.content)
    expect(images).toHaveLength(1)
    const stored = await ctx.attachments.readImage(images[0]!.attachment)
    expect(Buffer.from(stored.data)).toEqual(await readFile(path))
    expect(cost(recovered.content)).toBeLessThanOrEqual(CAP)
    expect(saves).toHaveBeenCalledTimes(1)
    expect(await requestImages(recovered.content)).toEqual(['green'])
  })

  it.each(['sequential', 'parallel'] as const)('keeps budgets and image identities separate across %s Node PTC calls', async (mode) => {
    const { ctx, session, execute, cost, requestImages, gates } = await setup()
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
    await ctx.plugin(NodeRuntime)
    if (mode === 'parallel') {
      const overlap = Promise.withResolvers<undefined>()
      onTestFinished(() => { overlap.resolve(undefined) })
      let entered = 0
      const gate = () => { if (++entered === 2) overlap.resolve(undefined); return overlap.promise }
      gates.set('ends', gate)
      gates.set('middle', gate)
    }
    const calls = mode === 'parallel'
      ? 'await Promise.all([tools.ends({}), tools.middle({}), tools.small({})])'
      : '[await tools.ends({}), await tools.middle({}), await tools.small({})]'
    const result = await execute('run_code', {
      code: `const [ends, middle, small] = ${calls}; return { ends: ends.content[2].text.length, middle: middle.content[0].text.length, small: small.content[0].text.length };`,
      description: 'Inspect independent image result budgets',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ result: { ends: LONG.length, middle: LONG.length, small: SMALL.length } })
    const dispatches = session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data)
    expect(dispatches).toHaveLength(3)
    for (const dispatch of dispatches) expect(cost(dispatch.content)).toBeLessThanOrEqual(CAP)
    expect(dispatches.find(event => event.name === 'ends')?.content.filter(block => block.type === 'image')).toHaveLength(2)
    expect(textOf(dispatches.find(event => event.name === 'middle')!.content)).toContain('Omitted 1 images.')
    expect(dispatches.find(event => event.name === 'small')?.content).toEqual([text(SMALL)])
    expect(result.additionalContexts).toHaveLength(2)
    expect(await requestImages(result.content, result.additionalContexts)).toEqual(['red', 'blue'])
  })
})
