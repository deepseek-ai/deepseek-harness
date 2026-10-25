import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionRequestId } from '../src/types.ts'

const SESSION = SessionId('upload-session')
const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 4,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 8,
  maxImagePixels: 64,
  maxImageDimension: 8,
  mediaTypes: ['image/png'],
}
const STAGED_IMAGE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'12'.repeat(32)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: 'shot.png',
}

async function* chunks(...parts: readonly number[][]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Uint8Array.from(part)
}

async function uploadHarness(origin?: 'subagent', imageLimits: ImageAttachmentLimits = IMAGE_LIMITS): Promise<{
  ctx: Context
  controller: SessionCommandController
  uploads: FileUploads
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  saveFile: ReturnType<typeof vi.fn>
  saveFileStream: ReturnType<typeof vi.fn>
  saveImages: ReturnType<typeof vi.fn>
  resolveModelInfo: ReturnType<typeof vi.fn>
  disposeAgent: () => Promise<void>
  uploadRoute: (request: Request) => Promise<Response>
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SESSION, {
    meta: { cwd: '/workspace', ...(origin === undefined ? {} : { origin }) },
  })
  const inbox = createInboxStub()
  const followup = vi.fn()
  const options = { provider: 'fixture', model: 'fixture-model' }
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const agent = {
    id: session.id,
    options,
    whenIdle: vi.fn(() => Promise.resolve()),
    runMaintenance: async () => { throw new Error('unexpected maintenance') },
    send: vi.fn(),
    inject: vi.fn(),
    session,
    model: new AgentModel(() => projection.stateOf(session), session, options),
    inbox,
    status: 'idle',
    ctx,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } satisfies Agent
  agent.ctx = createScope(ctx, agent).ctx
  const disposeAgent = await ctx.agents.register(agent)
  const saveFile = vi.fn((input: SaveFileAttachment): Promise<FileAttachmentRef> => Promise.resolve({
    attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
    name: input.name ?? 'file',
    bytes: input.data.byteLength,
  }))
  const saveFileStream = vi.fn(async (input: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return {
      attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
      name: input.name ?? 'file',
      bytes,
    }
  })
  const saveImages = vi.fn((_inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> =>
    Promise.reject(new Error('fixture did not expect image persistence')))
  ctx.provide('attachments', Object.setPrototypeOf(
    { saveFile, saveFileStream, saveImages, imageLimits },
    AttachmentStore.prototype,
  ) as never)
  let uploadRoute: ((request: Request) => Promise<Response>) | undefined
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly fetch: (request: Request) => Promise<Response> }) => {
        uploadRoute = route.fetch
        return () => {}
      },
    },
  } as never)
  const resolveModelInfo = vi.fn((): Promise<{
    readonly provider: string
    readonly id: string
    readonly name: string
    readonly inputModalities?: readonly string[]
  }> => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }))
  ctx.provide('llm', {
    listModels: async () => [{ id: 'fixture-model', name: 'Model' }],
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveModelInfo,
  } as never)
  const agents = new ApiSessionAgentController(ctx)
  vi.spyOn(agents, 'resolveAgent').mockResolvedValue({ agent })
  const uploads = new FileUploads(ctx)
  if (uploadRoute === undefined) throw new Error('file upload route was not registered')
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    uploads,
    agent,
    followup,
    saveFile,
    saveFileStream,
    saveImages,
    resolveModelInfo,
    disposeAgent,
    uploadRoute,
  }
}

/** The owner source `SessionController.prompt()` builds for {@link promptRequest}. */
const USER_SOURCE: MessageSource = { kind: 'user', rpcId: 'req-1' as SessionRequestId }

function promptRequest(content: Parameters<SessionCommandController['prompt']>[0]['content']) {
  return {
    requestId: 'req-1' as SessionRequestId,
    sessionId: SESSION,
    mode: 'queue' as const,
    content,
  }
}

describe('Session file uploads', () => {
  it('registers an HTTP route bound to the upload service', async () => {
    const { uploadRoute } = await uploadHarness()
    await expect(uploadRoute(new Request('http://host/upload')))
      .resolves.toMatchObject({ status: 405 })
  })

  it('stages one verbatim upload and preserves its order with an admitted image', async () => {
    const { ctx, controller, uploads, agent, followup, saveFile, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA', name: 'notes.pdf' }, new AbortController().signal)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(receipt.file.name).toBe('notes.pdf')
    expect(receipt.file.bytes).toBe(3)
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
    expect(uploads.resolve(agent, 'missing' as FileUploadReceiptId)).toBeUndefined()
    const commandHandler = vi.fn((_invocation: unknown) => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'files', description: 'Use staged files', input: { hint: '<task>', attachments: true },
      handler: commandHandler,
    })
    await ctx.commands.execute(
      agent,
      '/files inspect',
      [{ type: 'file', receiptId: receipt.receiptId }],
      new AbortController().signal,
    )
    expect(commandHandler.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ type: 'file', attachment: receipt.file }],
    })
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    saveImages.mockResolvedValueOnce([image])
    await controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'read it' },
    ]), USER_SOURCE)
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: receipt.file },
      { type: 'image', attachment: image },
      { type: 'text', text: 'read it' },
    ])
  })

  it('stages a bounded byte stream and forwards cancellation to storage', async () => {
    const { controller, uploads, followup, saveFileStream } = await uploadHarness()
    const abort = new AbortController()
    const receipt = await uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
      signal: abort.signal,
      name: 'huge.bin',
    })
    expect(saveFileStream).toHaveBeenCalledWith(expect.objectContaining({
      signal: abort.signal,
      name: 'huge.bin',
    }))
    expect(receipt.file).toMatchObject({ name: 'huge.bin', bytes: 5 })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE)
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'file', attachment: receipt.file },
    ])
  })

  it('stages an uploaded image and admits its receipt as that image, which commands do not accept', async () => {
    const { ctx, controller, uploads, agent, followup, saveImages } = await uploadHarness()
    saveImages.mockResolvedValueOnce([STAGED_IMAGE])
    const receipt = await uploads.uploadImageStream({
      sessionId: SESSION, data: chunks([1, 2], [3, 4]), mediaType: 'image/png', name: 'shot.png',
    })
    expect(saveImages).toHaveBeenCalledWith([{ data: Uint8Array.of(1, 2, 3, 4), mediaType: 'image/png', name: 'shot.png' }])
    expect(receipt.image).toEqual(STAGED_IMAGE)
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual({ type: 'image', attachment: STAGED_IMAGE, encodedBytes: 4 })
    const commandHandler = vi.fn((_invocation: unknown) => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'files', description: 'Use staged files', input: { hint: '<task>', attachments: true },
      handler: commandHandler,
    })
    await ctx.commands.execute(
      agent,
      '/files inspect',
      [{ type: 'file', receiptId: receipt.receiptId }],
      new AbortController().signal,
    )
    expect(commandHandler).not.toHaveBeenCalled()
    await controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'text', text: 'look' },
    ]), USER_SOURCE)
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'image', attachment: STAGED_IMAGE },
      { type: 'text', text: 'look' },
    ])
    expect(saveImages).toHaveBeenCalledTimes(1)
  })

  it('refuses an uploaded image for a model without image input', async () => {
    const { controller, uploads, followup, saveImages, resolveModelInfo } = await uploadHarness()
    saveImages.mockResolvedValueOnce([STAGED_IMAGE])
    const receipt = await uploads.uploadImageStream({ sessionId: SESSION, data: chunks([1]), mediaType: 'image/png' })
    resolveModelInfo.mockResolvedValue({ provider: 'fixture', id: 'fixture-model', name: 'Fixture', inputModalities: ['text'] })
    await expect(controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
    expect(followup).not.toHaveBeenCalled()
  })

  it('refuses image receipts whose uploads together exceed the message image-byte limit', async () => {
    const { controller, uploads, followup, saveImages } = await uploadHarness(undefined, {
      ...IMAGE_LIMITS, maxMessageImageBytes: 5,
    })
    saveImages.mockResolvedValue([STAGED_IMAGE])
    const first = await uploads.uploadImageStream({ sessionId: SESSION, data: chunks([1, 2, 3]), mediaType: 'image/png' })
    const second = await uploads.uploadImageStream({ sessionId: SESSION, data: chunks([4, 5, 6]), mediaType: 'image/png' })
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: first.receiptId },
      { type: 'file', receiptId: second.receiptId },
    ]), USER_SOURCE)).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'IMAGES_TOO_LARGE' } })
    expect(followup).not.toHaveBeenCalled()
  })

  it('issues no receipt for an image upload cancelled after its last chunk or during storage', async () => {
    const { uploads, saveImages } = await uploadHarness()
    const afterBody = new AbortController()
    await expect(uploads.uploadImageStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2, 3)
        afterBody.abort()
      })(),
      mediaType: 'image/png',
      signal: afterBody.signal,
    })).rejects.toThrow('failed to store file upload: AbortError')
    expect(saveImages).not.toHaveBeenCalled()
    const duringStorage = new AbortController()
    const stored = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(stored.promise)
    const uploading = uploads.uploadImageStream({
      sessionId: SESSION, data: chunks([1, 2, 3]), mediaType: 'image/png', signal: duringStorage.signal,
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    duringStorage.abort()
    stored.resolve([STAGED_IMAGE])
    // The image whose storage began stays stored; only its receipt is withheld.
    await expect(uploading).rejects.toThrow('failed to store file upload: AbortError')
  })

  it('refuses an image past the per-image byte limit without reading further, and an unaccepted type', async () => {
    const { uploads, saveImages } = await uploadHarness()
    const overLimit = (async function* (): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(1, 2, 3)
      yield Uint8Array.of(4, 5)
      throw new Error('read past the limit')
    })()
    await expect(uploads.uploadImageStream({ sessionId: SESSION, data: overLimit, mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'IMAGE_TOO_LARGE' } })
    await expect(uploads.uploadImageStream({ sessionId: SESSION, data: chunks([1]), mediaType: 'image/bmp' }))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'UNSUPPORTED_IMAGE_TYPE' } })
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('stops reading an image at the message byte limit when it is below the per-image limit', async () => {
    const { uploads, saveImages } = await uploadHarness(undefined, {
      ...IMAGE_LIMITS, maxImageBytes: 8, maxMessageImageBytes: 3,
    })
    const overLimit = (async function* (): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(1, 2)
      yield Uint8Array.of(3, 4)
      throw new Error('read past the limit')
    })()
    await expect(uploads.uploadImageStream({ sessionId: SESSION, data: overLimit, mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'IMAGE_TOO_LARGE' } })
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('keeps the stream name optional and maps storage failures through the same error vocabulary', async () => {
    const { uploads, saveFileStream } = await uploadHarness()
    const stream = (async function* (): AsyncIterable<Uint8Array> {})()
    await expect(uploads.uploadStream({ sessionId: SESSION, data: stream }))
      .resolves.toMatchObject({ file: { name: 'file', bytes: 0 } })
    expect(saveFileStream).toHaveBeenLastCalledWith({ data: stream })
    saveFileStream.mockRejectedValueOnce('disk offline')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    }))
      .rejects.toMatchObject({
        code: 'gateway/internal', message: 'failed to store file upload: disk offline',
      })
  })

  it('rejects a prompt citing a file that was never staged for the session', async () => {
    const { controller, followup, saveImages } = await uploadHarness()
    await expect(controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'file', receiptId: 'missing-receipt' as FileUploadReceiptId },
    ]), USER_SOURCE)).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } })
    expect(followup).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('admits an image before the Agent has a model selection', async () => {
    const { ctx, controller, agent, followup, saveImages } = await uploadHarness()
    delete agent.options.provider
    delete agent.options.model
    expect(agent.model.current()).toBeUndefined()
    const resolveModel = vi.spyOn(ctx.llm, 'resolveModelInfo')
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }
    saveImages.mockResolvedValueOnce([image])

    await expect(controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]), USER_SOURCE)).resolves.toEqual({ accepted: true })

    expect(resolveModel).not.toHaveBeenCalled()
    expect(followup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content: [{ type: 'image', attachment: image }],
    }))
  })

  it('publishes no receipt when its exact Agent is disposed during storage', async () => {
    const { uploads, agent, saveFile, disposeAgent } = await uploadHarness()
    const saved = Promise.withResolvers<FileAttachmentRef>()
    saveFile.mockReturnValueOnce(saved.promise)
    const uploading = uploads.upload(agent, { data: 'AAAA', name: 'late.bin' }, new AbortController().signal)
    await vi.waitFor(() => { expect(saveFile).toHaveBeenCalledOnce() })
    await disposeAgent()
    saved.resolve({
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'late.bin', bytes: 3,
    })
    await expect(uploading).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('resolves a cold ordinary Agent and releases the resolver with its registering fiber', async () => {
    const { ctx, uploads, agent, disposeAgent } = await uploadHarness()
    await disposeAgent()
    const resolveAgent = vi.fn(async () => {
      await ctx.agents.register(agent)
      return agent
    })
    const resolverOwner = {
      name: 'resolver-owner',
      inject: ['fileUploads'],
      apply: (owner: Context) => {
        owner.effect(() => owner.fileUploads.registerAgentResolver(resolveAgent), 'test: Agent resolver')
      },
    }
    const first = ctx.plugin(resolverOwner)
    await first
    expect(() => { ctx.fileUploads.registerAgentResolver(resolveAgent) }).toThrow('already registered')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    })).resolves.toMatchObject({ file: { bytes: 1 } })
    expect(resolveAgent).toHaveBeenCalledWith(SESSION)
    await first.dispose()
    const second = ctx.plugin(resolverOwner)
    await second
    expect(second.state).toBe(FiberState.ACTIVE)
    await second.dispose()
    const disposeResolver = ctx.fileUploads.registerAgentResolver(resolveAgent)
    disposeResolver()
    const replacement = vi.fn(async () => agent)
    const disposeReplacement = ctx.fileUploads.registerAgentResolver(replacement)
    disposeResolver()
    expect(() => { ctx.fileUploads.registerAgentResolver(replacement) }).toThrow('already registered')
    disposeReplacement()
  })

  it('rejects a cold upload when no Agent resolver is registered', async () => {
    const { uploads, disposeAgent } = await uploadHarness()
    await disposeAgent()
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {})(),
    })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects subagent uploads before storing bytes', async () => {
    const child = await uploadHarness('subagent')
    await expect(child.uploads.upload(
      child.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'subagent/attachment-invalid',
      details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
    })
    expect(child.saveFile).not.toHaveBeenCalled()
    await expect(child.uploads.uploadImageStream({ sessionId: SESSION, data: chunks([1]), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'subagent/attachment-invalid', details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' } })
    expect(child.saveImages).not.toHaveBeenCalled()
  })

  it('isolates receipts by Session object even when Session ids match', async () => {
    const owner = await uploadHarness()
    const other = await uploadHarness()
    expect(other.agent.session.id).toBe(owner.agent.session.id)
    expect(other.agent.session).not.toBe(owner.agent.session)
    const receipt = await owner.uploads.upload(owner.agent, { data: 'AAAA' }, new AbortController().signal)
    const binding = owner.uploads.bindPrompt(owner.agent, [receipt.receiptId], 'owner-prompt')
    binding.commit()

    expect(owner.uploads.resolve(other.agent, receipt.receiptId)).toBeUndefined()
    expect(() => owner.uploads.bindPrompt(other.agent, [receipt.receiptId], 'other-prompt'))
      .toThrow(expect.objectContaining({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } }))
    owner.uploads.retirePrompt(other.agent, 'owner-prompt')
    expect(owner.uploads.resolve(owner.agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
    owner.uploads.retirePrompt(owner.agent, 'owner-prompt')
    expect(owner.uploads.resolve(owner.agent, receipt.receiptId)).toBeUndefined()
  })

  it('retires accepted receipts after their rpcId becomes observable', async () => {
    const { controller, uploads, agent } = await uploadHarness()
    uploads.retirePrompt(agent, 'not-staged')
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE)
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
    uploads.retirePrompt(agent, 'other-request')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('retires observed prompt receipts and drops staged state with the Session', async () => {
    const first = await uploadHarness()
    const observed = await first.uploads.upload(
      first.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    await first.controller.prompt(promptRequest([{ type: 'file', receiptId: observed.receiptId }]), USER_SOURCE)
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'extension event' }],
      source: { kind: 'user', rpcId: 1 } as never,
    }), { surfaceOp: 'append' })
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toEqual({ type: 'file', attachment: observed.file })
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'observed' }],
      source: { kind: 'user', rpcId: 'req-1' as SessionRequestId },
    }), { surfaceOp: 'append' })
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toBeUndefined()

    const second = await uploadHarness()
    const abandoned = await second.uploads.upload(
      second.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    second.ctx.emit('session/disposed', second.agent.session)
    expect(second.uploads.resolve(second.agent, abandoned.receiptId)).toBeUndefined()
  })

  it('deduplicates a retried rpcId already present in the Agent inbox', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request, USER_SOURCE)
    agent.inbox.append('next-turn', followup.mock.calls[0]?.[0] as UserMessage)
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('deduplicates a retried rpcId already present in the durable log', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unidentified' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'accepted' }],
      source: { kind: 'user', rpcId: request.requestId },
    }), { surfaceOp: 'append' })

    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects when the Agent disappears during prompt admission', async () => {
    const { controller, saveImages, disposeAgent } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]), USER_SOURCE)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    await disposeAgent()
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects when a previously bound receipt retires during image admission', async () => {
    const { controller, uploads, agent, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE)
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt({
      ...promptRequest([
        { type: 'file', receiptId: receipt.receiptId },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ]),
      requestId: 'req-2' as SessionRequestId,
    }, USER_SOURCE)
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    uploads.retirePrompt(agent, 'req-1')
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
  })

  it('keeps the prior receipt binding when a later prompt attempt fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE)
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt({
      ...promptRequest([{ type: 'file', receiptId: receipt.receiptId }]),
      requestId: 'req-2' as SessionRequestId,
    }, USER_SOURCE)).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('restores an unbound receipt after prompt delivery fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
    ]), USER_SOURCE)).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual({ type: 'file', attachment: receipt.file })
  })

  it('retires a prompt-bound receipt when its queued occurrence is removed', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]), USER_SOURCE)
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    agent.inbox.append('next-turn', queued)
    expect(await controller.updateQueue({
      sessionId: SESSION,
      itemId: queued.id,
      action: { kind: 'remove' },
    })).toEqual({ accepted: true })
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('keeps separate names for identical bytes uploaded more than once', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const first = await uploads.upload(agent, { data: 'AAAA', name: 'first.txt' }, new AbortController().signal)
    const second = await uploads.upload(agent, { data: 'AAAA', name: 'second.txt' }, new AbortController().signal)
    expect(first.file.attachmentId).toBe(second.file.attachmentId)
    expect(first.receiptId).not.toBe(second.receiptId)

    await controller.prompt(promptRequest([
      { type: 'file', receiptId: first.receiptId },
      { type: 'file', receiptId: second.receiptId },
    ]), USER_SOURCE)

    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: first.file },
      { type: 'file', attachment: second.file },
    ])
  })

  it('maps a non-canonical payload to the wire attachment error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    await expect(uploads.upload(agent, { data: 'not base64!!' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'INVALID_FILE_BASE64' } })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('maps an unexpected storage failure to the internal wire error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    saveFile.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'failed to store file upload: Error: disk unavailable',
      })
  })
})
