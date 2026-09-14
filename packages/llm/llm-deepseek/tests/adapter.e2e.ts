import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, ToolCallId, ReasoningEffortId, createMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import AttachmentStore, { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginPackageInventoryDeepSeek from '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
import * as SessionLogDeepSeek from '@deepseek-ai/dsh-session-log-deepseek'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { Config } from '@deepseek-ai/dsh-llm-deepseek'
import type { WireMessage, WireRequest } from '../src/protocols/chat-completions/types.ts'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the direct-fetch adapter: V4 Flash across thinking modes
 * and a max-effort tool round trip with reasoning passback. The suite skips
 * entirely without $DEEPSEEK_API_KEY; the pre-release vision smoke additionally
 * requires $DEEPSEEK_VISION_E2E=1, and the Flash image/system-update smoke
 * requires $DEEPSEEK_FLASH_E2E=1 (see vitest.e2e.config.ts).
 */

const FLASH = 'deepseek-v4-flash'
const VISION = 'deepseek-v4-flash-vision-exp'
const VISION_E2E_ENABLED = process.env.DEEPSEEK_VISION_E2E === '1'
/** A model whose endpoint reads the latest `system` message at any position; unset skips the in-history smoke. */
const IN_HISTORY_MODEL = process.env.DEEPSEEK_IN_HISTORY_MODEL
const TEST_PNG = Uint8Array.from(readFileSync(
  new URL('../../llm-pi-ai/tests/fixtures/qr-code.png', import.meta.url),
))
const contexts: Context[] = []
let identityHome: string

class E2eAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: TEST_PNG.byteLength,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: TEST_PNG.byteLength,
    maxImagePixels: 256 * 256,
    maxImageDimension: 256,
    mediaTypes: ['image/png'],
  }
  readonly ref: ImageAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${randomBytes(32).toString('hex')}`),
    mediaType: 'image/png',
    bytes: TEST_PNG.byteLength,
    width: 256,
    height: 256,
    name: 'files-api-e2e.png',
  }
  readonly version: RequestImageAttachment = {
    variantId: ImageVariantId(`sha256:${randomBytes(32).toString('hex')}`),
    attachment: this.ref,
    data: TEST_PNG,
    mediaType: 'image/png',
    bytes: TEST_PNG.byteLength,
    width: 256,
    height: 256,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(this.ref)
  }

  readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: TEST_PNG })
  }

  override readImageRequest(
    _ref: ImageAttachmentRef,
    _target: ImageRequestTarget,
    _signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return Promise.resolve(this.version)
  }
}

beforeEach(async () => {
  identityHome = await mkdtemp(join(tmpdir(), 'dsh-e2e-user-id-'))
  vi.stubEnv('DSH_HOME', identityHome)
})

async function harness(model: string, config: Partial<Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(E2eAttachmentStore)
  await ctx.plugin(LlmDeepSeek, {
    protocol: 'chat-completions',
    baseURL: LlmDeepSeek.PUBLIC_BASE_URL,
    ...model === VISION ? { models: [{ id: VISION, inputModalities: ['text', 'image'] }] } : {},
    ...config,
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(identityHome, { recursive: true, force: true })
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-deepseek e2e (real API)', () => {
  it.skipIf(process.env.DEEPSEEK_FLASH_E2E !== '1')('deepseek-flash accepts images and retains system updates', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalAttachments)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: LlmDeepSeek.PUBLIC_BASE_URL, maxTokens: 4096 })
    const model = 'deepseek-flash'
    await expect(ctx.llm.resolveModelInfo('deepseek-official', model)).resolves.toMatchObject({
      inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
    })
    const attachment = await ctx.attachments.saveImage({ data: readFileSync(new URL('fixtures/red.png', import.meta.url)), mediaType: 'image/png' })
    const message = ask('What is the dominant color of this image?')[0]!
    const history: Message[] = [
      createSystemMessage('Answer with one English color word.', 'test'),
      { ...message, content: [...message.content, { type: 'image', attachment }] },
    ]
    const reply = async () => {
      const response = await assemble(ctx, { model, messages: history, reasoningEffort: ReasoningEffortId('high') })
      expect(response.finish.kind, JSON.stringify(response.finish)).toBe('stop')
      history.push(response.message)
      return textOf(response).trim().toLowerCase()
    }
    expect(await reply()).toMatch(/^red[.!]?$/)
    history.push(createSystemMessage('Reply to every user message with exactly banana.', 'test'), ...ask('Answer now.'))
    expect(await reply()).toBe('banana')
    history.push(...ask('Answer again.'))
    expect(await reply()).toBe('banana')
  })

  it.skipIf(!VISION_E2E_ENABLED)('uses the built-in official route to upload, reference, and delete one image', async () => {
    const key = process.env.DEEPSEEK_API_KEY
    if (key === undefined) throw new Error('e2e ran without DEEPSEEK_API_KEY')
    const baseURL = LlmDeepSeek.PUBLIC_BASE_URL
    const ctx = await harness(VISION, { baseURL })
    await ctx.plugin(E2eAttachmentStore)
    const attachments = ctx.attachments as E2eAttachmentStore
    let uploadedFile: LlmDeepSeek.DeepSeekFileIdType | undefined
    const nativeFetch = globalThis.fetch
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await nativeFetch(input, init)
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method === 'POST' && url.pathname.endsWith('/files') && response.ok) {
        const value = await response.clone().json() as { id?: unknown }
        if (typeof value.id === 'string') uploadedFile = LlmDeepSeek.DeepSeekFileId(value.id)
      }
      return response
    }
    vi.stubGlobal('fetch', observedFetch)
    const files = new LlmDeepSeek.DeepSeekFilesClient({ protocol: 'chat-completions', baseURL, apiKey: key })

    try {
      const result = await assemble(ctx, {
        model: VISION,
        messages: [createUserMessage({
          content: [
            { type: 'text', text: 'Briefly describe this image.' },
            { type: 'image', attachment: attachments.ref },
          ],
          source: { kind: 'plugin', plugin: 'test' },
        })],
        maxTokens: 100,
      })
      expect(
        result.finish.kind,
        `DeepSeek vision result: ${JSON.stringify(result.finish)}`,
      ).toBe('stop')
      expect(textOf(result).trim().length).toBeGreaterThan(0)
      expect(uploadedFile).toMatch(/^file-api-/u)
    } finally {
      if (uploadedFile !== undefined) await files.delete(uploadedFile)
    }
  })

  it('accepts the session-log and plugin-package request extension fields', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(SessionLogDeepSeek, { enabled: true })
    await ctx.plugin(PluginPackageInventoryDeepSeek)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: LlmDeepSeek.PUBLIC_BASE_URL, thinking: 'disabled' })
    const session = ctx.sessions.create(SessionId('real-extension-fields'))
    session.append('turn/start', { turn: 1 })

    const result = await assemble(ctx, {
      model: FLASH,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
      sessionId: session.id,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
    expect(SessionLogDeepSeek.acceptedThrough(session)).toBe(0)
  })

  it('serves a real request with the key held only by a credentials-local document', async () => {
    const key = process.env.DEEPSEEK_API_KEY
    if (key === undefined) throw new Error('e2e ran without DEEPSEEK_API_KEY')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-e2e-credentials-'))
    try {
      // JSON.stringify quotes the value: YAML is a JSON superset, so a real
      // key survives whatever characters it happens to carry.
      await writeFile(join(dir, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${JSON.stringify(key)}\n`, { mode: 0o600 })
      // Scrub the ambient variable so only the credential seam can supply the
      // key: this request proves the per-request resolution path end to end.
      vi.stubEnv('DEEPSEEK_API_KEY', '')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: LlmDeepSeek.PUBLIC_BASE_URL })

      const result = await assemble(ctx, {
        model: FLASH,
        messages: ask('Reply with exactly the word: pong'),
        maxTokens: 50,
      })
      expect(result.finish.kind).toBe('stop')
      expect(textOf(result).toLowerCase()).toContain('pong')
    } finally {
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flash dynamically switches from off to low', async () => {
    const ctx = await harness(FLASH, { reasoningEffort: 'off' })
    const withoutThinking = await assemble(ctx,{
      model: FLASH,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(withoutThinking.finish.kind).toBe('stop')
    expect(textOf(withoutThinking).toLowerCase()).toContain('pong')
    expect(withoutThinking.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(withoutThinking.usage?.inputTokens).toBeGreaterThan(0)
    expect(withoutThinking.usage?.outputTokens).toBeGreaterThan(0)

    const withThinking = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('low'),
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(withThinking.finish.kind).toBe('stop')
    expect(withThinking.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(withThinking)).toContain('9.8')
    expect(withThinking.usage?.reasoningTokens).toBeGreaterThan(0)
  })

  it(
    'flash + thinking enabled (effort max): tool-call round trip with reasoning passback',
    async () => {
      const ctx = await harness(FLASH, { thinking: 'enabled' })

      // Turn 1: the model must call the tool (and think before it).
      const first = await assemble(ctx,{
        model: FLASH,
        reasoningEffort: ReasoningEffortId('max'),
        messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
        tools: [weatherTool],
        maxTokens: 2000,
      })
      expect(
        first.finish.kind,
        `DeepSeek Flash tool-call turn finished as ${JSON.stringify(first.finish)}`,
      ).toBe('tool-calls')
      const call = first.message.content.find(block => block.type === 'tool-call')
      expect(call).toBeDefined()
      expect(call!.name).toBe('get_weather')
      expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

      // Turn 2: send the tool result back WITH the assistant's reasoning
      // block in history (the official thinking+tools passback rule).
      const second = await assemble(ctx,{
        model: FLASH,
        reasoningEffort: ReasoningEffortId('max'),
        messages: [
          ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
          createMessage({
            role: 'assistant', content: first.message.content,
            source: { kind: 'plugin', plugin: 'test' },
          }),
          createUserMessage({
            content: [{
              type: 'tool-result',
              toolCallId: ToolCallId(call!.id),
              content: [{ type: 'text', text: 'Sunny, 22°C' }],
            }],
            source: { kind: 'plugin', plugin: 'test' },
          }),
        ],
        tools: [weatherTool],
        maxTokens: 2000,
      })
      expect(
        second.finish.kind,
        `DeepSeek Flash tool-result turn finished as ${JSON.stringify(second.finish)}`,
      ).toBe('stop')
      expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
    },
  )

  it.skipIf(IN_HISTORY_MODEL === undefined)(
    'an in-history model follows a mid-history system message and keeps the cached prefix',
    async () => {
      const model = IN_HISTORY_MODEL as string
      const ctx = await harness(model, {
        thinking: 'disabled',
        models: [{ id: model, systemPromptUpdate: 'in-history' }],
      })
      await expect(ctx.llm.resolveModelInfo('deepseek-official', model))
        .resolves.toMatchObject({ systemPromptUpdate: 'in-history' })
      const system = (text: string) => createSystemMessage(text, 'test')
      // A nonce before the padding isolates the provider cache across runs and retries.
      const nonce = randomBytes(16).toString('hex')
      const padding = Array.from({ length: 40 }, (_, index) => `Rule ${String(index + 1)}: keep every answer short and factual.`).join('\n')
      // Both update strategies use identical prompt bytes, with the changed instruction near the head.
      const prompt = (word: string) => `Test ${nonce}. When the user says ping, reply with exactly the word: ${word}\n${padding}`
      const initial = prompt('pong')
      const latest = prompt('banana')
      const history = [system(initial), ...ask('ping')]
      const wireRequests: WireMessage[][] = []
      const nativeFetch = globalThis.fetch
      const observedFetch: typeof fetch = async (input, init) => {
        if (init?.method !== 'POST' || typeof init.body !== 'string') return nativeFetch(input, init)
        const body = JSON.parse(init.body) as WireRequest
        if (body.model === model) {
          wireRequests.push(body.messages)
          if (wireRequests.length === 1) {
            expect(body.messages).toEqual([
              { role: 'system', content: initial }, { role: 'user', content: 'ping' },
            ])
          } else if (wireRequests.length === 2) {
            expect(JSON.stringify(body.messages)).toBe(JSON.stringify(wireRequests[0]))
          } else if (wireRequests.length === 3) {
            expect(JSON.stringify(body.messages.slice(0, history.length)))
              .toBe(JSON.stringify(wireRequests[0]))
            expect(body.messages[3]).toEqual({ role: 'system', content: latest })
          } else if (wireRequests.length === 4) {
            expect(body.messages[0]).toEqual(wireRequests[2]![3])
            expect(body.messages.slice(1)).toEqual([
              wireRequests[2]![1], wireRequests[2]![2], wireRequests[2]![4],
            ])
          }
        }
        return nativeFetch(input, init)
      }
      vi.stubGlobal('fetch', observedFetch)
      try {
        const first = await assemble(ctx, { model, messages: history, maxTokens: 50 })
        expect(first.finish.kind).toBe('stop')
        expect(textOf(first).trim()).toBe('pong')
        const initialTokens = first.usage?.inputTokens ?? 0
        expect(initialTokens).toBeGreaterThan(0)

        // Measure reusable tokens rather than assuming a provider cache-block size.
        const warm = await assemble(ctx, { model, messages: history, maxTokens: 50 })
        expect(warm.finish.kind).toBe('stop')
        expect(textOf(warm).trim()).toBe('pong')
        const reusableTokens = warm.usage?.cacheReadTokens ?? 0
        expect(reusableTokens).toBeLessThanOrEqual(initialTokens)
        expect(reusableTokens).toBeGreaterThan(0)
        const assistant = createMessage({
          role: 'assistant', content: first.message.content, source: { kind: 'plugin', plugin: 'test' },
        })

        const updated = await assemble(ctx, {
          model,
          messages: [...history, assistant, system(latest), ...ask('ping')],
          maxTokens: 50,
        })
        expect(updated.finish.kind).toBe('stop')
        expect(textOf(updated).trim()).toBe('banana')

        const replaced = await assemble(ctx, {
          model,
          messages: [system(latest), ...ask('ping'), assistant, ...ask('ping')],
          maxTokens: 50,
        })
        expect(replaced.finish.kind).toBe('stop')
        expect(textOf(replaced).trim()).toBe('banana')
        expect(wireRequests).toHaveLength(4)

        const cached = updated.usage?.cacheReadTokens ?? 0
        expect(replaced.usage?.cacheReadTokens).toBeDefined()
        const baselineCached = replaced.usage?.cacheReadTokens ?? 0
        expect(cached).toBeGreaterThanOrEqual(reusableTokens)
        expect(cached).toBeGreaterThan(baselineCached)
      } finally {
        vi.stubGlobal('fetch', nativeFetch)
      }
    },
  )

  it('streams raw chunks in protocol order', async () => {
    const ctx = await harness(FLASH, { thinking: 'disabled' })
    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek-official',
      model: FLASH,
      messages: ask('Count from 1 to 5, digits only.'),
      maxTokens: 50,
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds[0]).toBe('block-start')
    expect(kinds.at(-1)).toBe('finish')
    expect(kinds.filter(kind => kind === 'finish')).toHaveLength(1)
    // usage precedes finish (deferred-emit contract)
    expect(kinds.indexOf('usage')).toBeLessThan(kinds.indexOf('finish'))
  })
})
