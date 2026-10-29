// @vitest-environment jsdom
// ConversationController scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { reportMessageSubmission } from '../src/client/input/submission-analytics.ts'
import { ConversationController } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

const IMAGE_REF = {
  attachmentId: 'image-stored-1' as never,
  mediaType: 'image/png' as const,
  bytes: 1,
  width: 1,
  height: 1,
}

/** `createDrafts` mode of an ordinary Session draft, which uploads its images when added. */
const UPLOAD_IMAGES = true
/** `createDrafts` mode of a draft whose images travel inline, as a subagent continuation's do. */
const INLINE_IMAGES = false

async function bench(maxConcurrentFileUploads = 2) {
  const runtime = await SlotTestRuntime.create()
  runtime.fileUpload.upload = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as {
      uploadFile?: (...input: unknown[]) => Promise<unknown>
    }
    if (session.uploadFile === undefined) throw new Error('test file upload has no Session override')
    return session.uploadFile(...args)
  }
  runtime.fileUpload.uploadImage = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as {
      uploadImage?: (...input: unknown[]) => Promise<unknown>
    }
    if (session.uploadImage === undefined) throw new Error('test image upload has no Session override')
    return session.uploadImage(...args)
  }
  const prompt = vi.fn((
    _content?: unknown, _mode?: unknown, _signal?: AbortSignal, _rpcId?: string,
  ) => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: { prompt, updateQueue, cancel, loadOlder },
  })
  const reference = runtime.sessions.retain('s1' as SessionId)
  await reference.ready
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
    maxConcurrentFileUploads,
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationController
  const shell = hub.shellFor(runtime.sessions.binding('s1')!)
  return { runtime, fiber, root, scoped, hub, shell, prompt, updateQueue, cancel, loadOlder, reference }
}

describe('ConversationController', () => {
  it('does not revive a withdrawn generation when an old input submits before scoped cleanup', async () => {
    const b = await bench()
    try {
      b.shell.setDraft('old draft')
      b.reference.release()
      const retain = vi.spyOn(b.runtime.sessions, 'retain')
      b.shell.submit()
      b.shell.steerQueue()
      expect(b.runtime.sessions.binding('s1')).toBeUndefined()
      expect(retain).not.toHaveBeenCalled()
      await b.runtime.flush()
      expect(b.prompt).not.toHaveBeenCalled()
      retain.mockRestore()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello')
    await b.scoped.updateQueue('item-1' as never, { kind: 'remove' })
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    expect(b.updateQueue).toHaveBeenCalledWith('item-1', { kind: 'remove' })
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    await b.runtime.dispose()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }) } as never)
    await expect(b.scoped.send('x')).rejects.toThrow('conversation.send failed: session/agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'nope', {}) } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: gateway/internal: nope')
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'broken', {}),
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' }))
      .rejects.toThrow('conversation.updateQueue failed: gateway/internal: broken')
    await b.runtime.dispose()
  })

  it('treats QueueDock Steer pre-admission races as converged Queue delivery', async () => {
    const b = await bench()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-2' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-3' as never, { kind: 'remove' }))
      .rejects.toThrow('conversation.updateQueue failed: session/queue-item-not-found: claimed')
    await b.runtime.dispose()
  })

  it('releases draft previews when their session scope is disposed', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.root.input.for(b.runtime.sessions.scope('s1')!).addAttachments([attachment.id])
      b.reference.release()
      await b.runtime.flush()
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('releases an unsettled send preview during structural Session teardown', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:detached')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'detached.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.shell.addAttachments([attachment.id])
      b.shell.submit()
      expect(b.shell.snapshot).toMatchObject({ phase: 'sending', attachmentIds: [attachment.id] })
      await b.runtime.sessions.disposeScopes()
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:detached')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('classifies image MIME drafts as images and other files as file drafts, uploading images only where accepted', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    const session = b.runtime.sessions.binding('s1')!.session
    const uploadFile = vi.fn((_data: Blob | Uint8Array) => Promise.resolve({
      ok: true as const,
      value: {
        receiptId: 'receipt-1' as never,
        file: { attachmentId: 'sha256:1' as never, name: 'notes.pdf', bytes: 2 },
      },
    }))
    const uploadImage = vi.fn((_data: Blob, _mediaType: string, _name?: string) => Promise.resolve({
      ok: true as const,
      value: { receiptId: 'image-receipt-1' as never, image: IMAGE_REF },
    }))
    Object.assign(session, { uploadFile, uploadImage })
    const drafts = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'notes.pdf', { type: 'application/pdf' }),
    ], UPLOAD_IMAGES)
    expect(drafts.map(draft => draft.kind)).toEqual(['image', 'file'])
    expect(created).toHaveBeenCalledTimes(1)
    const [imageDraft, fileDraft] = [drafts[0]!, drafts[1]!]
    expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('uploading')
    expect(b.root.fileUploads.getSnapshot()[imageDraft.id]?.status).toBe('uploading')
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('ready')
      expect(b.root.fileUploads.getSnapshot()[imageDraft.id])
        .toEqual({ status: 'ready', receiptId: 'image-receipt-1' })
    })
    expect(uploadFile).toHaveBeenCalledOnce()
    expect(uploadFile.mock.calls[0]?.[0]).toBe(fileDraft.file)
    expect(uploadImage.mock.calls[0]?.slice(0, 3)).toEqual([imageDraft.file, 'image/png', 'valid.png'])
    const [inline] = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(3)], 'child.png', { type: 'image/png' }),
    ], INLINE_IMAGES)
    expect(b.root.fileUploads.getSnapshot()[inline!.id]).toBeUndefined()
    expect(uploadImage).toHaveBeenCalledOnce()
    created.mockRestore()
    await b.runtime.dispose()
  })

  it('retries a failed image upload and aborts it with its draft', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      const signals: AbortSignal[] = []
      const uploadImage = vi.fn((_data: Blob, _mediaType: string, _name: string | undefined, signal: AbortSignal) => {
        signals.push(signal)
        return signals.length === 1
          ? Promise.resolve({ ok: false, error: new RemoteError('session/attachment-invalid', 'too big', { reason: 'IMAGE_TOO_LARGE' }) })
          : new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
      })
      ;(session as { uploadImage?: unknown }).uploadImage = uploadImage
      const [draft] = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(1)], 'big.png', { type: 'image/png' }),
      ], UPLOAD_IMAGES)
      // A Host refusal keeps its reason; retrying stays available to the service.
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[draft!.id])
          .toEqual({ status: 'error', message: 'too big', reason: 'IMAGE_TOO_LARGE' })
      })
      b.root.retryFileUpload(session.sessionId, draft!.id)
      await vi.waitFor(() => { expect(uploadImage).toHaveBeenCalledTimes(2) })
      expect(b.root.fileUploads.getSnapshot()[draft!.id]?.status).toBe('uploading')
      b.root.releaseDraftAttachment(draft!.id)
      expect(signals[1]?.aborted).toBe(true)
      expect(b.root.fileUploads.getSnapshot()[draft!.id]).toBeUndefined()
      expect(revoked).toHaveBeenCalledWith('blob:retry')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('keeps no refusal reason when an image upload fails in transport', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:flaky')
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      ;(session as { uploadImage?: unknown }).uploadImage = vi.fn(() => Promise.resolve({
        ok: false, error: new RemoteError('gateway/internal', 'connection reset', {}),
      }))
      const [draft] = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(1)], 'flaky.png', { type: 'image/png' }),
      ], UPLOAD_IMAGES)
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[draft!.id]).toEqual({ status: 'error', message: 'connection reset' })
      })
    } finally {
      created.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('serializes command files as staged receipts without reading their bytes again', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn((_file: Blob | Uint8Array, name?: string) =>
      Promise.resolve({
        ok: true as const,
        value: {
          receiptId: `receipt-${name}` as never,
          file: { attachmentId: `file-${name}` as never, name: name ?? 'file', bytes: 1 },
        },
      }))
    const drafts = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(1)], 'one.txt', { type: 'text/plain' }),
      new File([Uint8Array.of(2)], 'two.txt', { type: 'text/plain' }),
    ], UPLOAD_IMAGES)
    await vi.waitFor(() => {
      expect(drafts.every(draft => b.root.fileUploads.getSnapshot()[draft.id]?.status === 'ready')).toBe(true)
    })
    function RejectingFileReader(): never {
      throw new Error('generic file bytes were reread')
    }
    vi.stubGlobal('FileReader', RejectingFileReader)
    try {
      await expect(b.root.serializeDraftAttachments(drafts.map(draft => draft.id))).resolves.toEqual({
        attachments: [
          { type: 'file', receiptId: 'receipt-one.txt' },
          { type: 'file', receiptId: 'receipt-two.txt' },
        ],
      })
    } finally {
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('bounds upload Workers, advances on settlement, and skips a queued file removed by the user', async () => {
    const b = await bench(2)
    const session = b.runtime.sessions.binding('s1')!.session
    type UploadResult = {
      ok: true
      value: { receiptId: never; file: { attachmentId: never; name: string; bytes: number } }
    }
    const gates = new Map<string, { resolve: (value: UploadResult) => void }>()
    let active = 0
    let maxActive = 0
    const uploadFile = vi.fn((_file: Blob | Uint8Array, name?: string) => {
      const fileName = name ?? 'unnamed'
      const gate = Promise.withResolvers<UploadResult>()
      gates.set(fileName, gate)
      active += 1
      maxActive = Math.max(maxActive, active)
      return gate.promise.finally(() => { active -= 1 })
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const drafts = b.root.createDrafts(session.sessionId, ['one', 'two', 'three', 'four', 'removed'].map(name =>
      new File([Uint8Array.of(1)], `${name}.txt`, { type: 'text/plain' })), UPLOAD_IMAGES)

    await vi.waitFor(() => { expect(uploadFile.mock.calls.map(call => call[1])).toEqual(['one.txt', 'two.txt']) })
    await expect(b.root.serializeDraftAttachments([drafts[2]!.id]))
      .rejects.toThrow('one or more files have not finished uploading')
    b.root.releaseDraftAttachment(drafts[4]!.id)

    const complete = (name: string) => gates.get(name)?.resolve({
      ok: true,
      value: {
        receiptId: `receipt-${name}` as never,
        file: { attachmentId: `file-${name}` as never, name, bytes: 1 },
      },
    })
    complete('one.txt')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledTimes(3) })
    complete('two.txt')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledTimes(4) })
    complete('three.txt')
    complete('four.txt')
    await vi.waitFor(() => {
      expect(drafts.slice(0, 4).every(draft =>
        b.root.fileUploads.getSnapshot()[draft.id]?.status === 'ready')).toBe(true)
    })
    expect(maxActive).toBe(2)
    expect(uploadFile.mock.calls.map(call => call[1])).not.toContain('removed.txt')
    expect(b.root.fileUploads.getSnapshot()[drafts[4]!.id]).toBeUndefined()
    await b.runtime.dispose()
  })

  it('keeps one upload alive and observable while another Session is open', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    const settled = Promise.withResolvers<{
      ok: true
      value: { receiptId: never; file: { attachmentId: never; name: string; bytes: number } }
    }>()
    let reportProgress: ((progress: { loaded: number; total?: number }) => void) | undefined
    const uploadFile = vi.fn((
      _file: Blob | Uint8Array,
      _name?: string,
      _signal?: AbortSignal,
      onProgress?: (progress: { loaded: number; total?: number }) => void,
    ) => {
      reportProgress = onProgress
      return settled.promise
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([new Uint8Array(8)], 'background.bin', { type: 'application/octet-stream' }),
    ], UPLOAD_IMAGES)
    if (attachment === undefined) throw new Error('file draft missing')
    b.shell.addAttachments([attachment.id])
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce() })

    await b.runtime.sessions.add({
      id: 's2',
      session: {
        prompt: b.prompt, updateQueue: b.updateQueue, cancel: b.cancel, loadOlder: b.loadOlder,
      },
    })
    using other = b.runtime.sessions.retain('s2' as SessionId)
    await other.ready
    reportProgress?.({ loaded: 3, total: 8 })
    expect(b.root.fileUploads.getSnapshot()[attachment.id]).toEqual({
      status: 'uploading', loaded: 3, total: 8,
    })
    expect(b.shell.snapshot.attachmentIds).toEqual([attachment.id])

    settled.resolve({
      ok: true,
      value: {
        receiptId: 'background-receipt' as never,
        file: { attachmentId: 'background-file' as never, name: 'background.bin', bytes: 8 },
      },
    })
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]?.status).toBe('ready')
    })
    expect(b.shell.snapshot.attachmentIds).toEqual([attachment.id])
    await b.runtime.dispose()
  })

  it('drops a carried image upload when the target Session sends images inline', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:carry')
    try {
      const source = b.runtime.sessions.binding('s1')!.session
      let sourceSignal: AbortSignal | undefined
      ;(source as { uploadImage?: unknown }).uploadImage = vi.fn(
        (_data: Blob, _mediaType: string, _name: string | undefined, signal: AbortSignal) => {
          sourceSignal = signal
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        },
      )
      const [image] = b.root.createDrafts(source.sessionId, [
        new File([Uint8Array.of(5)], 'carry.png', { type: 'image/png' }),
      ], UPLOAD_IMAGES)
      await vi.waitFor(() => { expect(sourceSignal).toBeDefined() })
      const targetUpload = vi.fn()
      await b.runtime.sessions.add({ id: 's2', session: { uploadImage: targetUpload } })
      using _target = b.runtime.sessions.retain('s2' as SessionId)
      await _target.ready
      b.root.rebindDraftFiles(b.runtime.sessions.binding('s2')!.session.sessionId, [image!.id], INLINE_IMAGES)
      expect(sourceSignal?.aborted).toBe(true)
      expect(b.root.fileUploads.getSnapshot()[image!.id]).toBeUndefined()
      expect(targetUpload).not.toHaveBeenCalled()
    } finally {
      created.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('cancels a superseded upload and stages the carried draft on the target Session', async () => {
    const b = await bench()
    const source = b.runtime.sessions.binding('s1')!.session
    let sourceSignal: AbortSignal | undefined
    const sourceUpload = vi.fn((_data: Blob | Uint8Array, _name?: string, signal?: AbortSignal) => {
      sourceSignal = signal
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { message: 'aborted' } })
        }, { once: true })
      })
    })
    ;(source as { uploadFile?: unknown }).uploadFile = sourceUpload
    const [attachment] = b.root.createDrafts(source.sessionId, [
      new File([Uint8Array.of(4)], 'carry.pdf', { type: 'application/pdf' }),
    ], UPLOAD_IMAGES)
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => { expect(sourceUpload).toHaveBeenCalledOnce() })

    const target = {
      uploadFile: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'target-receipt' as never,
          file: { attachmentId: 'target-file' as never, name: 'carry.pdf', bytes: 1 },
        },
      })),
    }
    await b.runtime.sessions.add({ id: 's2', session: target })
    using _target = b.runtime.sessions.retain('s2' as SessionId)
    await _target.ready
    b.root.rebindDraftFiles(b.runtime.sessions.binding('s2')!.session.sessionId, [attachment.id], UPLOAD_IMAGES)

    expect(sourceSignal?.aborted).toBe(true)
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]).toEqual({
        status: 'ready', receiptId: 'target-receipt',
        file: { attachmentId: 'target-file', name: 'carry.pdf', bytes: 1 },
      })
    })
    await b.runtime.dispose()
  })

  it('cancels a file upload when its draft is removed', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let uploadSignal: AbortSignal | undefined
    const uploadFile = vi.fn((_data: Blob | Uint8Array, _name?: string, signal?: AbortSignal) => {
      uploadSignal = signal
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { message: 'aborted' } })
        }, { once: true })
      })
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(5)], 'removed.pdf', { type: 'application/pdf' }),
    ], UPLOAD_IMAGES)
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce() })

    b.root.releaseDraftAttachment(attachment.id)

    expect(uploadSignal?.aborted).toBe(true)
    expect(b.root.fileUploads.getSnapshot()[attachment.id]).toBeUndefined()
    await b.runtime.dispose()
  })

  it('keeps the accepted file draft until its rpcId appears in the Host queue', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let retire: ((retirement: unknown) => void) | undefined
    ;(session as unknown as { beginSubmission: (input: { onRetire?: (retirement: unknown) => void }) => unknown })
      .beginSubmission = (input) => {
        retire = input.onRetire
        return { requestId: 'file-rpc-id', abandon: vi.fn() }
      }
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: {
        receiptId: 'send-receipt' as never,
        file: { attachmentId: 'send-file' as never, name: 'sent.pdf', bytes: 1 },
      },
    }))
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(6)], 'sent.pdf', { type: 'application/pdf' }),
    ], UPLOAD_IMAGES)
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]?.status).toBe('ready')
    })

    const sending = b.root.sendSession(session, 'read', [attachment.id], 'queue')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })

    expect(b.prompt).toHaveBeenCalledWith([
      { type: 'file', receiptId: 'send-receipt' },
      { type: 'text', text: 'read' },
    ], 'queue', undefined, expect.any(String))
    expect(b.root.resolveDraftAttachments([attachment.id])).toHaveLength(1)
    expect(b.prompt.mock.calls[0]?.[3]).toBe('file-rpc-id')
    retire?.({
      reason: 'observed',
      attachments: [{ attachmentId: 'send-file', name: 'sent.pdf', bytes: 1 }],
    })
    await expect(sending).resolves.toEqual({ kind: 'success' })
    expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
    await b.runtime.dispose()
  })

  it('awaits an aborted upload before disposing the service', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let uploadSignal: AbortSignal | undefined
    let finishUpload: (() => void) | undefined
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(
      (_data: Uint8Array, _name?: string, signal?: AbortSignal) => {
        uploadSignal = signal
        return new Promise((resolve) => {
          finishUpload = () => { resolve({ ok: false, error: { message: 'aborted' } }) }
        })
      },
    )
    b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(7)], 'dispose.pdf', { type: 'application/pdf' }),
    ], UPLOAD_IMAGES)
    await vi.waitFor(() => { expect(uploadSignal).toBeDefined() })

    let disposed = false
    const disposal = b.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(uploadSignal?.aborted).toBe(true) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finishUpload?.()
    await disposal
    expect(disposed).toBe(true)
    await b.runtime.dispose()
  })

  it('fails loudly from the root scope, on an unbound session, or without Client Sessions', async () => {
    const b = await bench()
    await expect(b.root.send('x')).rejects.toThrow(/requires a session scope/)
    b.reference.release()
    await b.runtime.flush()
    await expect(b.scoped.send('x')).rejects.toThrow(/resolved no binding/)
    await b.runtime.dispose()
    // No Client Sessions service at all: a bare context lacks the assembled controller.
    const bare = new Context()
    await bare.plugin(ConversationController, {
      input: new InputHub(bare, makeTranslate(zh, {})),
      blocks: new ComposerBlockRegistry(),
      maxConcurrentFileUploads: 2,
    }).await()
    const orphan = bare.get('conversation') as ConversationController
    await expect(orphan.send('x')).rejects.toThrow(/sessions service unavailable/)
  })
})

describe('sendSession submission echo', () => {
  /** Bench with an observable beginSubmission on the session face. */
  async function echoBench() {
    const b = await bench()
    const retire: { onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined } = {}
    const abandon = vi.fn()
    const begun = Promise.withResolvers<BeginSubmissionInput>()
    const beginSubmission = vi.fn((input: BeginSubmissionInput) => {
      retire.onRetire = input.onRetire
      begun.resolve(input)
      return { requestId: 'req-echo' as never, abandon }
    })
    await b.runtime.sessions.updateSessionSnapshot('s1', () => {})
    const face = b.runtime.sessions.binding('s1')!.session as unknown as Record<string, unknown>
    face['beginSubmission'] = beginSubmission
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:echo-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const restore = () => {
      created.mockRestore()
      revoked.mockRestore()
    }
    return { ...b, beginSubmission, begun: begun.promise, abandon, retire, revoked, restore }
  }

  it('registers the echo before serialization and prompts with its identity', async () => {
    const b = await echoBench()
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1, 2, 3)], 'a.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '带图', [attachment!.id], 'queue')
      const echo = await b.begun
      expect(echo?.mode).toBe('queue')
      expect(echo?.text).toBe('带图')
      expect(echo?.attachments).toHaveLength(1)
      expect(echo?.attachments[0]?.type).toBe('image')
      expect(echo?.attachments[0]?.value).toMatchObject({ previewUrl: 'blob:echo-1', name: 'a.png' })
      expect(b.prompt).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt).toHaveBeenCalledWith(
        [
          { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'a.png' },
          { type: 'text', text: '带图' },
        ],
        'queue',
        undefined,
        'req-echo',
      )
      // The draft stays registered until the echo's observed retirement.
      expect(b.root.resolveDraftAttachments([attachment!.id])).toHaveLength(1)
      b.retire.onRetire?.({ reason: 'observed', attachments: [] })
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(b.root.resolveDraftAttachments([attachment!.id])).toEqual([])
      expect(b.revoked).toHaveBeenCalledWith('blob:echo-1')
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('preserves mixed image/file selection order through echo, prompt, and observed retirement', async () => {
    const b = await echoBench()
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'mixed-file-receipt' as never,
          file: { attachmentId: 'mixed-file' as never, name: 'notes.txt', bytes: 1 },
        },
      }))
      const drafts = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(1)], 'first.png', { type: 'image/png' }),
        new File([Uint8Array.of(2)], 'notes.txt', { type: 'text/plain' }),
        new File([Uint8Array.of(3)], 'last.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[drafts[1]!.id]?.status).toBe('ready')
      })
      const sending = b.root.sendSession(session, 'ordered', drafts.map(draft => draft.id), 'steer')
      const echo = await b.begun
      expect(echo?.mode).toBe('steer')
      expect(echo?.attachments.map(attachment => attachment.type === 'image'
        ? { type: attachment.type, name: attachment.value.name }
        : { type: attachment.type, value: attachment.value })).toEqual([
        { type: 'image', name: 'first.png' },
        { type: 'file', value: { attachmentId: 'mixed-file', name: 'notes.txt', bytes: 1 } },
        { type: 'image', name: 'last.png' },
      ])
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt.mock.calls[0]?.[0]).toEqual([
        { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'first.png' },
        { type: 'file', receiptId: 'mixed-file-receipt' },
        { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'last.png' },
        { type: 'text', text: 'ordered' },
      ])
      b.retire.onRetire?.({
        reason: 'observed',
        attachments: [
          {
            attachmentId: 'image-first' as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
          { attachmentId: 'mixed-file' as never, name: 'notes.txt', bytes: 1 },
          {
            attachmentId: 'image-last' as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        ],
      })
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(b.root.resolveDraftAttachments(drafts.map(draft => draft.id))).toEqual([])
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('reports success once the Session accepts the prompt, ahead of a receipt that later fails', async () => {
    const b = await echoBench()
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      const receipt = Promise.withResolvers<{ ok: true; value: { accepted: true } }>()
      b.prompt.mockImplementationOnce(() => receipt.promise)
      const accept = vi.fn()
      const sending = b.root.sendSession(session, '收件箱先到', [], 'queue', undefined, accept)
      const echo = await b.begun
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      echo.onAccept?.()
      // The composer settles inside the Session's acceptance, before the echo renders.
      expect(accept).toHaveBeenCalledOnce()
      await expect(sending).resolves.toEqual({ kind: 'success' })
      // The Host already holds the message, so a receipt lost afterwards changes nothing.
      receipt.reject(new Error('connection closed after the Host accepted the prompt'))
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('sends an uploaded image draft by its receipt and holds a send while it uploads', async () => {
    const b = await echoBench()
    const readAsDataURL = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      const uploaded = Promise.withResolvers<unknown>()
      ;(session as { uploadImage?: unknown }).uploadImage = vi.fn(() => uploaded.promise)
      const [draft] = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(1)], 'shot.png', { type: 'image/png' }),
      ], UPLOAD_IMAGES)
      await expect(b.root.sendSession(session, 'look', [draft!.id], 'queue'))
        .rejects.toThrow('one or more files have not finished uploading')
      expect(b.beginSubmission).not.toHaveBeenCalled()
      uploaded.resolve({ ok: true, value: { receiptId: 'image-receipt-1', image: IMAGE_REF } })
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft!.id]?.status).toBe('ready') })
      const sending = b.root.sendSession(session, 'look', [draft!.id], 'queue')
      const echo = await b.begun
      expect(echo.attachments[0]).toMatchObject({ type: 'image', value: { previewUrl: 'blob:echo-1', name: 'shot.png' } })
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt.mock.calls[0]?.[0]).toEqual([
        { type: 'file', receiptId: 'image-receipt-1' },
        { type: 'text', text: 'look' },
      ])
      expect(readAsDataURL).not.toHaveBeenCalled()
      b.retire.onRetire?.({ reason: 'observed', attachments: [IMAGE_REF] })
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(b.root.fileUploads.getSnapshot()[draft!.id]).toBeUndefined()
    } finally {
      readAsDataURL.mockRestore()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('passes each delivery mode before image serialization', async () => {
    const b = await echoBench()
    try {
      await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.running = true })
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, '立即纠偏', [], 'steer'))
        .resolves.toEqual({ kind: 'success' })
      expect(b.beginSubmission).toHaveBeenLastCalledWith(expect.objectContaining({
        mode: 'steer',
        text: '立即纠偏',
      }))
      await expect(b.root.sendSession(session, '稍后处理', [], 'queue'))
        .resolves.toEqual({ kind: 'success' })
      expect(b.beginSubmission).toHaveBeenLastCalledWith(expect.objectContaining({
        mode: 'queue',
        text: '稍后处理',
      }))
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('hands the preview URL to the image cache on observed retirement instead of revoking it', async () => {
    const b = await echoBench()
    try {
      const seedImageUrl = vi.fn(() => true)
      b.runtime.ctx.provide('uiConversation')
      b.runtime.ctx.set('uiConversation', { seedImageUrl })
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(9)], 'seeded.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '', [attachment!.id], 'queue')
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      const ref = {
        attachmentId: 'att-1' as never,
        mediaType: 'image/png' as const,
        bytes: 1,
        width: 1,
        height: 1,
      }
      b.retire.onRetire?.({ reason: 'observed', attachments: [ref] })
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(seedImageUrl).toHaveBeenCalledWith('s1', ref, 'blob:echo-1')
      expect(b.root.resolveDraftAttachments([attachment!.id])).toEqual([])
      expect(b.revoked).not.toHaveBeenCalled()
      // Failed retirement keeps nothing to do; a second retire of released ids is a no-op.
      b.retire.onRetire?.({ reason: 'observed', attachments: [ref] })
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('keeps mixed image and file drafts when the echo retires as failed', async () => {
    const b = await echoBench()
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'kept-file-receipt' as never,
          file: { attachmentId: 'kept-file' as never, name: 'kept.txt', bytes: 1 },
        },
      }))
      b.prompt.mockResolvedValueOnce({
        ok: false, error: new RemoteError('session/attachment-invalid', 'nope', { reason: 'nope' }),
      } as never)
      const attachments = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(7)], 'kept.png', { type: 'image/png' }),
        new File([Uint8Array.of(8)], 'kept.txt', { type: 'text/plain' }),
      ], INLINE_IMAGES)
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[attachments[1]!.id]?.status).toBe('ready')
      })
      await expect(b.root.sendSession(session, '失败', attachments.map(attachment => attachment.id), 'queue'))
        .resolves.toEqual({ kind: 'error' })
      b.retire.onRetire?.({ reason: 'failed' })
      expect(b.root.resolveDraftAttachments(attachments.map(attachment => attachment.id))).toHaveLength(2)
      expect(b.revoked).not.toHaveBeenCalled()
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('abandons the echo when encoding fails before the prompt', async () => {
    const b = await echoBench()
    class FailingReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      error = new Error('read failed')
      readAsDataURL(): void {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', FailingReader)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'broken.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, 'x', [attachment!.id], 'queue'))
        .rejects.toThrow('read failed')
      expect(b.abandon).toHaveBeenCalledOnce()
      expect(b.prompt).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('yields through the macrotask fallback where no frame clock exists', async () => {
    const b = await echoBench()
    vi.stubGlobal('requestAnimationFrame', undefined)
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, '纯文本', [], 'queue')).resolves.toEqual({ kind: 'success' })
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '纯文本' }], 'queue', undefined, 'req-echo')
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('bounds the paint yield when the frame clock is throttled', async () => {
    const b = await echoBench()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '后台标签', [], 'queue')
      expect(b.prompt).not.toHaveBeenCalled()
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '后台标签' }], 'queue', undefined, 'req-echo')
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('echoes a subagent continuation and sends it under the echo request id', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    const snapshot = session.getSnapshot()
    const beginSubmission = vi.spyOn(session, 'beginSubmission')
    vi.spyOn(session, 'getSnapshot').mockReturnValue({
      ...snapshot,
      subagent: {
        address: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } as never,
      },
    })
    const prompt = vi.spyOn(session, 'prompt').mockResolvedValue({ ok: true, value: { accepted: true } })
    await expect(b.root.sendSession(session, '继续', [], 'queue')).resolves.toEqual({ kind: 'success' })
    expect(beginSubmission).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'queue', text: '继续' }))
    const echo = beginSubmission.mock.results[0]
    const requestId = echo?.type === 'return' ? echo.value.requestId : undefined
    expect(requestId).toEqual(expect.any(String))
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续' }], 'queue', undefined, requestId)
    await b.runtime.dispose()
  })
})

describe('draft image dimension probe', () => {
  it('fills intrinsic dimensions from the header probe and skips runtimes without Image', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe')
    class InstantImage {
      onload: (() => void) | null = null
      naturalWidth = 0
      naturalHeight = 0
      set src(_value: string) {
        this.naturalWidth = 640
        this.naturalHeight = 480
        this.onload?.()
      }
    }
    vi.stubGlobal('Image', InstantImage)
    try {
      const [probed] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'probed.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      expect(probed).toMatchObject({ width: 640, height: 480 })
      vi.stubGlobal('Image', undefined)
      const [unprobed] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(2)], 'unprobed.png', { type: 'image/png' }),
      ], INLINE_IMAGES)
      expect(unprobed?.kind).toBe('image')
      if (unprobed?.kind !== 'image') throw new Error('image draft missing')
      expect(unprobed.width).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      created.mockRestore()
    }
    await b.runtime.dispose()
  })
})

describe('InputHub queue steering (empty-draft accelerated Enter)', () => {
  const row = (id: string): UserMessage => ({
    id: id as never,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: id }],
  })

  it('steers every queued row in FIFO order and leaves steering rows alone', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-3')], 'next-step': [row('q-2')] })
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.updateQueue).toHaveBeenCalledTimes(2)
    })
    expect(b.updateQueue).toHaveBeenNthCalledWith(1, 'q-1', { kind: 'steer' })
    expect(b.updateQueue).toHaveBeenNthCalledWith(2, 'q-3', { kind: 'steer' })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('converges silently when the turn closes or a row is claimed mid-steer', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-2')], 'next-step': [] })
    // The turn closes before the second row: the flush stops, silently.
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as MessageId }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(1) })
    expect(b.shell.notices.getSnapshot()).toBeNull()

    // A row the host already claimed (e.g. a repeated empty-draft chord):
    // the duplicate Steer is a silent no-op.
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-3')], 'next-step': [] })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(2) })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('surfaces one notice on a genuine steer failure and stops', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-2')], 'next-step': [] })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'broken', {}),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.shell.notices.getSnapshot()).toEqual(
        expect.objectContaining({ level: 'error', text: '插话发送失败，请重试。' }),
      )
    })
    expect(b.updateQueue).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('no-ops without queued rows', async () => {
    const b = await bench()
    b.shell.steerQueue()
    expect(b.updateQueue).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })
})


it('captures run mode and queue intent at submission before later projection changes', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'plan', { active: true, pending: false })
    await b.runtime.sessions.setProjection('s1', 'goal', { goal: { phase: 'active' } })
    await b.runtime.sessions.setProjection('s1', 'modelSelection', { next: { provider: 'fixture', model: 'model', reasoningEffort: 'high' }, lastUsed: null })
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = true; state.blank = false })
    b.shell.setDraft('private prompt')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      session_id: 's1', model_name: 'fixture/model', thinking_effort: 'high', run_mode: 'plan', msg_type: 'queue',
      is_new_session: false,
    }, expect.any(Number))
    await b.runtime.sessions.setProjection('s1', 'plan', { active: false, pending: false })
    expect(track).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(track.mock.calls)).not.toContain('private prompt')
  } finally { await b.runtime.dispose() }
})

it.each([
  { running: false, mode: 'queue', expected: 'default' },
  { running: true, mode: 'steer', expected: 'steer' },
] as const)('reports msg_type=$expected without gesture fields', async ({ running, mode, expected }) => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = running; state.blank = true })
    b.shell.setDraft('message')
    b.shell.submit(mode, 'enter')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      run_mode: 'default', msg_type: expected, is_new_session: true,
    }, expect.any(Number))
  } finally { await b.runtime.dispose() }
})

it('marks only a message sent from a blank Session as a new Session', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = false; state.blank = true })
    b.shell.setDraft('first message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenLastCalledWith('send_button_click', {
      run_mode: 'default', msg_type: 'default', is_new_session: true,
    }, expect.any(Number))
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.blank = false })
    b.shell.setDraft('second message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenLastCalledWith('send_button_click', {
      session_id: 's1', run_mode: 'default', msg_type: 'default', is_new_session: false,
    }, expect.any(Number))
    expect(track).toHaveBeenCalledTimes(2)
  } finally { await b.runtime.dispose() }
})

it.each([
  { preset: 'cordis', category: 'creator' },
  { preset: 'ptc', category: 'ptc' },
  { preset: 'minimal', category: 'minimal' },
  { preset: 'standard', category: 'standard' },
] as const)('reports the built-in $preset preset as $category', async ({ preset, category }) => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'agentPreset', preset)
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = false; state.blank = true })
    b.shell.setDraft('message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      run_mode: 'default', msg_type: 'default', is_new_session: true, agent_preset: category,
    }, expect.any(Number))
  } finally { await b.runtime.dispose() }
})

it('reports a custom preset as other without its id', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'agentPreset', 'private-preset')
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = false; state.blank = false })
    b.shell.setDraft('message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      session_id: 's1', run_mode: 'default', msg_type: 'default', is_new_session: false, agent_preset: 'other',
    }, expect.any(Number))
    expect(JSON.stringify(track.mock.calls)).not.toContain('private-preset')
  } finally { await b.runtime.dispose() }
})

it('omits the preset category while the Session records no preset', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'agentPreset', null)
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = false; state.blank = true })
    b.shell.setDraft('message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledOnce()
    expect(track.mock.calls[0]?.[1]).not.toHaveProperty('agent_preset')
  } finally { await b.runtime.dispose() }
})

it('reports an active goal and a model without an explicit effort', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'goal', { goal: { phase: 'active' } })
    await b.runtime.sessions.setProjection('s1', 'modelSelection', { next: null, lastUsed: { provider: 'fixture', model: 'model' } })
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = false; state.blank = false })
    b.shell.setDraft('message')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      session_id: 's1', model_name: 'fixture/model', run_mode: 'goal', msg_type: 'default', is_new_session: false,
    }, expect.any(Number))
  } finally { await b.runtime.dispose() }
})

it('reports nothing for a submission whose Session facts were not captured', () => {
  const ctx = new Context()
  const track = vi.fn()
  ctx.provide('productAnalytics', { enabled: true, track } as never)
  reportMessageSubmission(ctx, { timestamp: 1, mode: 'queue', source: 'click' })
  expect(track).not.toHaveBeenCalled()
})
