// @vitest-environment jsdom
// ConversationController scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, QueuedMessage,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

async function bench(maxConcurrentFileUploads = 2) {
  const runtime = await SlotTestRuntime.create()
  runtime.fileUpload.available = true
  runtime.fileUpload.upload = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as {
      uploadFile?: (...input: unknown[]) => Promise<unknown>
    }
    if (session.uploadFile === undefined) throw new Error('test file upload has no Session override')
    return session.uploadFile(...args)
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
  return { runtime, fiber, root, scoped, hub, shell, prompt, updateQueue, cancel, loadOlder }
}

describe('ConversationController', () => {
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
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as QueuedMessage['id'] }),
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as QueuedMessage['id'] }),
    } as never)
    await expect(b.scoped.updateQueue('item-2' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as QueuedMessage['id'] }),
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
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.root.input.for(b.runtime.sessions.scope('s1')!).addAttachments([attachment.id])
      await b.runtime.sessions.remove('s1')
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('releases an image removed from the rail by an unsettled optimistic send', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:detached')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'detached.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.shell.addAttachments([attachment.id])
      b.shell.submit()
      expect(b.shell.snapshot.attachmentIds).toEqual([])
      await b.runtime.sessions.remove('s1')
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:detached')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('classifies image MIME drafts as images and every other file as an uploading file draft', async () => {
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
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const drafts = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'notes.pdf', { type: 'application/pdf' }),
    ])
    expect(drafts.map(draft => draft.kind)).toEqual(['image', 'file'])
    expect(created).toHaveBeenCalledTimes(1)
    const fileDraft = drafts[1]!
    expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('uploading')
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('ready')
    })
    expect(uploadFile).toHaveBeenCalledOnce()
    expect(uploadFile.mock.calls[0]?.[0]).toBe((fileDraft as { file: File }).file)
    created.mockRestore()
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
    ])
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
      new File([Uint8Array.of(1)], `${name}.txt`, { type: 'text/plain' })))

    expect(uploadFile.mock.calls.map(call => call[1])).toEqual(['one.txt', 'two.txt'])
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
    ])
    if (attachment === undefined) throw new Error('file draft missing')
    b.shell.addAttachments([attachment.id])
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce() })

    await b.runtime.sessions.add({
      id: 's2',
      session: {
        prompt: b.prompt, updateQueue: b.updateQueue, cancel: b.cancel, loadOlder: b.loadOlder,
      },
    })
    b.runtime.sessions.open('s2' as never)
    reportProgress?.({ loaded: 3, total: 8 })
    expect(b.root.fileUploads.getSnapshot()[attachment.id]).toEqual({
      status: 'uploading', loaded: 3, total: 8,
    })
    expect(b.shell.snapshot.attachmentIds).toEqual([attachment.id])

    b.runtime.sessions.open('s1' as never)
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
    ])
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
    b.root.rebindDraftFiles(b.runtime.sessions.binding('s2')!.session.sessionId, [attachment.id])

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
    ])
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
    ])
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
    ])
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
    await b.runtime.sessions.remove('s1')
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
    const beginSubmission = vi.fn((input: BeginSubmissionInput) => {
      retire.onRetire = input.onRetire
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
    return { ...b, beginSubmission, abandon, retire, revoked, restore }
  }

  it('registers the echo before serialization and prompts with its identity', async () => {
    const b = await echoBench()
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1, 2, 3)], 'a.png', { type: 'image/png' }),
      ])
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '带图', [attachment!.id], 'queue')
      // Synchronous: the echo is registered before any encoding starts.
      const echo = b.beginSubmission.mock.calls[0]?.[0]
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
      ])
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[drafts[1]!.id]?.status).toBe('ready')
      })
      const sending = b.root.sendSession(session, 'ordered', drafts.map(draft => draft.id), 'steer')
      const echo = b.beginSubmission.mock.calls[0]?.[0]
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
      ])
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
      ])
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
      ])
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

  it('sends a subagent continuation without registering an unobservable echo', async () => {
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
    expect(beginSubmission).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续' }], 'queue', undefined)
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
      ])
      expect(probed).toMatchObject({ width: 640, height: 480 })
      vi.stubGlobal('Image', undefined)
      const [unprobed] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(2)], 'unprobed.png', { type: 'image/png' }),
      ])
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
  const row = (id: string): QueuedMessage => ({
    id: id as never,
    messageId: `message-${id}` as never,
    placement: 'queued',
    content: [{ type: 'text', text: id }],
    preview: id,
    text: id,
  })

  it('steers every queued row in FIFO order and leaves steering rows alone', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), { ...row('q-2'), placement: 'steering' }, row('q-3')]
    })
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
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
    // The turn closes before the second row: the flush stops, silently.
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as QueuedMessage['id'] }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(1) })
    expect(b.shell.notices.getSnapshot()).toBeNull()

    // A row the host already claimed (e.g. a repeated empty-draft chord):
    // the duplicate Steer is a silent no-op.
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.queue = [row('q-3')]
    })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as QueuedMessage['id'] }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(2) })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('surfaces one notice on a genuine steer failure and stops', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
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
