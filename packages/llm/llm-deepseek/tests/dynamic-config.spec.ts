import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { createUserMessage, INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import AttachmentStore, { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const configurations = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()
const KEY_REF = credentialRef('DEEPSEEK_API_KEY')
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}
const HOST_IMAGE_PATH = '/host/.dsh/attachments/objects/aa/object'
const MODEL_IMAGE_PATH = '/model/.dsh/attachments/objects/aa/object'

class MappedFileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return hostPath === HOST_IMAGE_PATH ? MODEL_IMAGE_PATH : undefined
  }
}

class StaticAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 64,
    maxImagePixels: 4,
    maxImageDimension: 4,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(IMAGE_REF)
  }

  readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) })
  }

  override imageHostPath(_ref: ImageAttachmentRef): string {
    return HOST_IMAGE_PATH
  }

  override readImageRequest(
    ref: ImageAttachmentRef,
    _target: ImageRequestTarget,
    _signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
      attachment: ref,
      data: Uint8Array.of(1, 2, 3),
      mediaType: ref.mediaType,
      bytes: 3,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: true,
    })
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
}

/**
 * Real dynamic composition: llm + profile Config edits + credentials-local +
 * llm-deepseek over one temp harness home. `watch: false` keeps every change
 * flowing through the in-process write path, which is deterministic; external
 * file watching is the providers' own covered concern.
 */
async function boot(dir: string, config: object): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(StaticAttachmentStore)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  configurations.set(ctx, await liveConfig(ctx, LlmDeepSeek, config))
  return { ctx }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with the freshly resolved base URL and credential', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: first-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.headers[0]?.['x-api-key']).toBe('first-key')

    await configurations.get(ctx)!.update({ baseURL: serverB.url })
    await ctx.credentials.set(KEY_REF, 'second-key')

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved both facts.
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.['x-api-key']).toBe('second-key')
  })

  it('starts keyless and serves the next request once the key arrives', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    const keyless = await prompt(ctx)
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    await expect(access(join(dir, '.anonymous-user-id'))).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.credentials.set(KEY_REF, 'sk-arrived')
    await prompt(ctx)
    expect(server.headers[0]?.['x-api-key']).toBe('sk-arrived')
    await expect(access(join(dir, '.anonymous-user-id'))).resolves.toBeUndefined()
  })

  it('rejects a stored credential no header can carry, never echoing it in the failure', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })
    const secret = 'sk-\u{1F600}supersecret'

    // The real credentials seam (the path the web Models page writes through),
    // not a hand-built stub: this package's own dynamic-config harness already
    // boots one, and round-tripping the value through its actual store/read
    // path is stronger evidence than a canned in-memory return would be.
    await ctx.credentials.set(KEY_REF, secret)
    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: INVALID_CREDENTIAL_CODE } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).not.toContain(secret)
    expect(result.finish.failure.message).not.toContain('supersecret')
    expect(result.finish.failure.message).not.toContain('ByteString')
  })

  it('advertises a live settings catalog without re-registration', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'catalog-fixture-key')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(2)
    await configurations.get(ctx)!.update({
      models: [{ id: 'settings-model', name: 'From Settings', inputModalities: ['text', 'image'] }],
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'settings-model', name: 'From Settings', inputModalities: ['text', 'image'] },
    ])
  })

  it('applies changed request file limits to the next request', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const dir = await home()
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const { ctx } = await boot(dir, { baseURL: server.url })
    await ctx.plugin(MappedFileSystem)
    const messages = [createUserMessage({
      content: [
        { type: 'image', attachment: IMAGE_REF },
        { type: 'image', attachment: IMAGE_REF },
      ],
      source: { kind: 'test' },
    })]

    await assemble(ctx, { model: 'deepseek-flash', messages })
    await configurations.get(ctx)!.update({ maxRequestFilesBytes: 4, imageOffloadByteQuantum: 2 })
    // A request whose retained exact bytes exceed the tightened budget names the occurrences to offload.
    const rejected = await assemble(ctx, { model: 'deepseek-flash', messages })
    expect(rejected.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 },
    })
    await assemble(ctx, {
      model: 'deepseek-flash',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: IMAGE_REF, offloaded: true },
          { type: 'image', attachment: IMAGE_REF },
        ],
        source: { kind: 'test' },
      })],
    })

    const first = (server.requests[0] as { messages: Array<{ content: unknown }> }).messages[0]?.content
    const second = (server.requests[1] as { messages: Array<{ content: unknown }> }).messages[0]?.content
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(first).match(/"type":"image"/g)).toHaveLength(2)
    expect(JSON.stringify(second)).toContain('[image omitted to fit request image limits')
    expect(JSON.stringify(second)).toContain(MODEL_IMAGE_PATH)
    expect(JSON.stringify(second).match(/"type":"image"/g)).toHaveLength(1)
  })
  it('re-registers the route in place when the captured retry policy changes, without an empty-registry window', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Observing the topology event, not just the end state: disposing and
    // re-registering also lands on the right final registry, but publishes an
    // empty route set in between, so an observer sees the provider disappear.
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await configurations.get(ctx)!.update({
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    expect(observed).toEqual([['deepseek-official']])
  })

  it('fails catalog reads while a stored snapshot fails beyond-schema validation, and recovers on repair', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'catalog-fixture-key')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    // Schema-valid but resolver-invalid: duplicate catalog ids pass the array
    // schema; the profile stores them and every resolve step fails until the row is repaired.
    await configurations.get(ctx)!.update({ models: [{ id: 'dup' }, { id: 'dup' }] })
    await expect(ctx.llm.listModels('deepseek-official')).rejects.toThrow('duplicate')
    await configurations.get(ctx)!.update({ models: [{ id: 'recovered' }] })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'recovered', name: 'recovered', inputModalities: ['text'] },
    ])
  })

  it('sends nothing while a stored snapshot fails beyond-schema validation', async () => {
    const dir = await home()
    const good = await mockServer([{ kind: 'sse', events: textEvents }])
    const rejected = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_API_KEY', 'good-key')
    const { ctx } = await boot(dir, { baseURL: good.url })

    // One snapshot moves the endpoint and fails the resolve step beyond the
    // schema (duplicate catalog ids): no request reaches either endpoint.
    await configurations.get(ctx)!.update({ baseURL: rejected.url, models: [{ id: 'dup' }, { id: 'dup' }] })
    expect(JSON.stringify((await prompt(ctx)).finish)).toContain('duplicate catalog model')
    expect(rejected.requests).toHaveLength(0)
    expect(good.requests).toHaveLength(0)

    await configurations.get(ctx)!.update({ models: [{ id: 'deepseek-v4-flash' }] })
    await prompt(ctx)
    expect(rejected.requests).toHaveLength(1)
    expect(rejected.headers[0]?.['x-api-key']).toBe('good-key')
  })

  it.each(['messages', 'chat-completions'])('refuses a stored protocol=%s when the adapter mounts', async (protocol) => {
    const dir = await home()
    await expect(boot(dir, { baseURL: 'http://127.0.0.1:1', protocol })).rejects.toThrow(/protocol/)
  })

})
