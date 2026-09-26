import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiReplayResponse } from '../src/replay.ts'
import { assemble, type AssembledResult } from './assemble.ts'

interface ProviderCase {
  provider: 'openai' | 'anthropic'
  api: 'openai-responses' | 'anthropic-messages'
  model: string
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
}

const openAIBaseURL = process.env.DSH_PI_AI_OPENAI_BASE_URL
const azureOpenAIKey = process.env.AZURE_OPENAI_API_KEY
// Strictly ANTHROPIC_*: the DeepSeek endpoint does not serve the anthropic-messages
// protocol, so falling back to DEEPSEEK_API_KEY turns the keyless skip into a 404.
const anthropicApiKey = process.env.ANTHROPIC_API_KEY
const anthropicBaseURL = process.env.DSH_PI_AI_ANTHROPIC_BASE_URL

const providerCases: ProviderCase[] = [
  {
    provider: 'openai',
    api: 'openai-responses',
    model: process.env.DSH_PI_AI_OPENAI_MODEL ?? 'gpt-5.5',
    ...azureOpenAIKey
      ? { apiKey: azureOpenAIKey, headers: { 'api-key': azureOpenAIKey, Authorization: '' } }
      : {},
    ...openAIBaseURL ? { baseURL: openAIBaseURL } : {},
  },
  {
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: process.env.DSH_PI_AI_ANTHROPIC_MODEL ?? 'claude-opus-4-8',
    ...anthropicApiKey === undefined ? {} : { apiKey: anthropicApiKey },
    ...anthropicBaseURL === undefined ? {} : { baseURL: anthropicBaseURL },
  },
]

const contexts: Context[] = []

async function harness(image?: StoredImageAttachment): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: Object.fromEntries(providerCases.map(profile => [profile.provider, {
      ...profile.apiKey === undefined ? {} : { apiKey: profile.apiKey },
      ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
      ...profile.headers === undefined ? {} : { headers: profile.headers },
    }])),
  })
  if (image !== undefined) {
    const fixture = image
    class E2eAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: fixture.data.byteLength,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: fixture.data.byteLength,
        maxImagePixels: fixture.ref.width * fixture.ref.height,
        maxImageDimension: Math.max(fixture.ref.width, fixture.ref.height),
        mediaTypes: [fixture.ref.mediaType],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('e2e attachment fixture is read-only'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('e2e attachment fixture is read-only'))
      }

      readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        if (ref.attachmentId !== fixture.ref.attachmentId) {
          return Promise.reject(new Error('unknown e2e attachment fixture'))
        }
        return Promise.resolve(fixture)
      }

      override readImageRequest(ref: ImageAttachmentRef, _target: ImageRequestTarget): Promise<RequestImageAttachment> {
        if (ref.attachmentId !== fixture.ref.attachmentId) {
          return Promise.reject(new Error('unknown e2e attachment fixture'))
        }
        return Promise.resolve({
          variantId: ImageVariantId(`sha256:${'f'.repeat(64)}`),
          attachment: fixture.ref,
          data: fixture.data,
          mediaType: fixture.ref.mediaType,
          bytes: fixture.data.byteLength,
          width: fixture.ref.width,
          height: fixture.ref.height,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: fixture.ref.mediaType === 'image/png',
        })
      }
    }
    await ctx.plugin(E2eAttachmentStore)
  }
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function expectFinish(result: AssembledResult, expected: 'stop' | 'tool-calls'): void {
  if (result.finish.kind === 'error') {
    throw new Error(`provider request failed (${result.finish.failure.code}): ${result.finish.failure.message}`)
  }
  expect(result.finish.kind).toBe(expected)
}

function expectNativeReplay(result: AssembledResult, profile: ProviderCase): PiAiReplayResponse {
  const replayState = result.message.source.kind === 'model'
    ? result.message.source.replayState
    : undefined
  expect(replayState).toMatchObject({
    response: {
      kind: 'pi-ai',
      version: 2,
      api: profile.api,
      provider: profile.provider,
      model: profile.model,
    },
  })
  return (replayState as { response: PiAiReplayResponse }).response
}

const lookupTool: ToolSchema = {
  name: 'lookup_code',
  description: 'Look up the word represented by a short code.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'The code to look up.' } },
    required: ['code'],
  },
}

for (const profile of providerCases) {
  describe.skipIf(profile.apiKey === undefined)(
    `llm-pi-ai ${profile.provider} e2e (${profile.api})`,
    () => {
      it('streams text with usage and native replay metadata', async () => {
        const ctx = await harness()
        const result = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: ask('Reply with exactly the word: pong'),
          maxTokens: 1024,
        })

        expectFinish(result, 'stop')
        expect(textOf(result).toLowerCase()).toContain('pong')
        expect(result.usage?.inputTokens).toBeGreaterThan(0)
        expect(result.usage?.outputTokens).toBeGreaterThan(0)
        expect(expectNativeReplay(result, profile).stopReason).toBe('stop')
      })

      it('round-trips a tool call with provider-native replay metadata', async () => {
        const ctx = await harness()
        const prompt = ask('Use lookup_code with code "blue". Do not answer without calling the tool.')
        const first = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: prompt,
          tools: [lookupTool],
          maxTokens: 2048,
        })

        expectFinish(first, 'tool-calls')
        const call = first.message.content.find(block => block.type === 'tool-call')
        expect(call).toBeDefined()
        expect(call!.name).toBe('lookup_code')
        expect(JSON.parse(call!.arguments)).toMatchObject({ code: 'blue' })
        expect(expectNativeReplay(first, profile).stopReason).toBe('toolUse')

        const second = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: [
            ...prompt,
            first.message,
            createToolResultMessage({
              callId: ToolCallId(call!.id),
              content: [{ type: 'text', text: 'The code blue means ocean.' }],
              isError: false,
            }),
          ],
          tools: [lookupTool],
          maxTokens: 2048,
        })

        expectFinish(second, 'stop')
        expect(textOf(second).toLowerCase()).toContain('ocean')
        expect(expectNativeReplay(second, profile).stopReason).toBe('stop')
      })

      if (profile.provider === 'anthropic') {
        it('sends a real image through the authenticated Anthropic visual path', async () => {
          const data = new Uint8Array(await readFile(
            new URL('./fixtures/qr-code.png', import.meta.url),
          ))
          const ref: ImageAttachmentRef = {
            attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
            mediaType: 'image/png',
            bytes: data.byteLength,
            width: 256,
            height: 256,
            name: 'qr-code.png',
          }
          const ctx = await harness({ ref, data })
          const result = await assemble(ctx, {
            provider: profile.provider,
            model: profile.model,
            messages: [createUserMessage({
              content: [
                {
                  type: 'text',
                  text: 'What type of machine-readable symbol is shown in the attached image? Reply with exactly: QR code',
                },
                { type: 'image', attachment: ref },
              ],
              source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            })],
            maxTokens: 256,
          })

          expectFinish(result, 'stop')
          expect(textOf(result).toLowerCase()).toContain('qr code')
        })
      }
    },
  )
}
