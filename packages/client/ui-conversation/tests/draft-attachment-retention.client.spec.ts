// @vitest-environment jsdom
// A draft with attachments holds its Session without the event connection, so leaving every view keeps the same
// composer and its attachments; a removed Session releases them, and a page unload reports what it discarded.
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

const SESSION = 's1'
const UNLOAD_MARK = `dsh.composer-draft-attachments-unloaded.${SESSION}`

function sessionId(): SessionId {
  return brandString<SessionId>(SESSION)
}

function uploadValue(name: string): FileUploadValue {
  return {
    receiptId: brandString<FileUploadValue['receiptId']>(`receipt-${name}`),
    file: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), name, bytes: 3 },
  }
}

interface UploadBehavior {
  uploadFile?: (...input: unknown[]) => Promise<unknown>
}

/** One retained Session with the production Conversation service and its input hub. */
async function bench(prepare?: () => void) {
  const runtime = await SlotTestRuntime.create()
  const upload = vi.fn((id: SessionId, ...args: unknown[]) => {
    const behavior = runtime.sessions.behavior(id) as UploadBehavior
    if (behavior.uploadFile === undefined) throw new Error('test file upload has no Session override')
    return behavior.uploadFile(...args)
  })
  runtime.fileUpload.upload = upload
  runtime.fileUpload.uploadImage = vi.fn(() => Promise.resolve({ ok: true as const, value: {
    receiptId: brandString<FileUploadValue['receiptId']>('receipt-image'),
    image: { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
  } }))
  await runtime.sessions.add({
    id: SESSION,
    session: {
      prompt: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      updateQueue: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      cancel: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      loadOlder: vi.fn(() => Promise.resolve()),
    },
  })
  prepare?.()
  let reference = runtime.sessions.retain(sessionId())
  await reference.ready
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  await runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
    maxConcurrentFileUploads: createSnapshotStore(2),
  }).await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const shellNow = () => hub.shellFor(runtime.sessions.binding(SESSION)!)
  const shell = shellNow()
  const behavior = () => runtime.sessions.behavior(SESSION) as UploadBehavior
  /** Release the viewing reference, as leaving every view of the Session does. */
  const switchAway = async (): Promise<void> => {
    reference.release()
    await runtime.flush()
  }
  /** Retain the Session for a view again. */
  const switchBack = async () => {
    reference = runtime.sessions.retain(sessionId())
    await reference.ready
    return shellNow()
  }
  return { runtime, hub, root, shell, upload, behavior, switchAway, switchBack }
}

function draftFile(name = 'notes.txt'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' })
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('draft attachments across a Session switch', () => {
  it('holds the Session without its connection and keeps the same composer and attachments', async () => {
    const b = await bench()
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const drafts = b.root.createDrafts(sessionId(), [draftFile(), new File([Uint8Array.of(9)], 'pic.png', { type: 'image/png' })], true)
      expect(b.shell.addAttachments(drafts.map(draft => draft.id))).toBe(true)
      await vi.waitFor(() => {
        for (const draft of drafts) expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('ready')
      })
      await b.switchAway()
      expect(b.runtime.sessions.retainInfo(sessionId()).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { draft: 1 } })
      const back = await b.switchBack()
      expect(back).toBe(b.shell)
      expect(back.snapshot.attachmentIds).toEqual(drafts.map(draft => draft.id))
      expect(b.root.resolveDraftAttachments(back.snapshot.attachmentIds)).toEqual(drafts)
      expect(b.upload).toHaveBeenCalledOnce()
      expect(revoked).not.toHaveBeenCalled()
      expect(back.notices.getSnapshot()).toBeNull()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('releases the hold once the draft has no attachments', async () => {
    const b = await bench()
    try {
      const [draft] = b.root.createDrafts(sessionId(), [new File([Uint8Array.of(9)], 'pic.png', { type: 'image/png' })], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await b.switchAway()
      expect(b.runtime.sessions.binding(SESSION)).toBeDefined()
      b.shell.removeAttachment(draft.id)
      await b.runtime.flush()
      expect(b.runtime.sessions.binding(SESSION)).toBeUndefined()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps an upload running while the Session is switched away', async () => {
    const b = await bench()
    try {
      let finish!: (value: unknown) => void
      b.behavior().uploadFile = vi.fn((...args: unknown[]) => new Promise((resolve) => {
        finish = resolve
        ;(args[2] as AbortSignal).addEventListener('abort', () => { resolve({ ok: false, error: new Error('aborted') }) })
      }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile('big.bin')], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('uploading') })
      await b.switchAway()
      finish({ ok: true, value: uploadValue('big.bin') })
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('ready') })
      const back = await b.switchBack()
      expect(back.snapshot.attachmentIds).toEqual([draft.id])
      expect(b.upload).toHaveBeenCalledOnce()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps a failed upload so it can be retried in place after returning', async () => {
    const b = await bench()
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.reject(new Error('network lost')))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile('big.bin')], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('error') })
      await b.switchAway()
      const back = await b.switchBack()
      expect(back.snapshot.attachmentIds).toEqual([draft.id])
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('big.bin') }))
      b.root.retryFileUpload(sessionId(), draft.id)
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('ready') })
    } finally {
      await b.runtime.dispose()
    }
  })
})

describe('removed Sessions', () => {
  it('releases the draft attachments of a Session removed while no view holds it', async () => {
    const b = await bench()
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await b.switchAway()
      await b.runtime.sessions.remove(SESSION)
      await b.runtime.flush()
      expect(b.runtime.sessions.binding(SESSION)).toBeUndefined()
      expect(b.root.resolveDraftAttachments([draft.id])).toEqual([])
    } finally {
      await b.runtime.dispose()
    }
  })

  it('releases the draft attachments when the last view of a removed Session closes', async () => {
    const b = await bench()
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await b.runtime.sessions.remove(SESSION)
      await b.switchAway()
      expect(b.root.resolveDraftAttachments([draft.id])).toEqual([])
    } finally {
      await b.runtime.dispose()
    }
  })
})

describe('page unload report', () => {
  it('marks Sessions whose attachments an unload discards, and reports them on the next page', async () => {
    const first = await bench()
    try {
      first.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = first.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      first.shell.addAttachments([draft.id])
      window.dispatchEvent(new Event('pagehide'))
      expect(localStorage.getItem(UNLOAD_MARK)).toBe('1')
    } finally {
      await first.runtime.dispose()
    }
    // A reload starts with an empty registry; the saved mark survives in browser storage.
    const second = await bench(() => { localStorage.setItem(UNLOAD_MARK, '1') })
    try {
      expect(second.shell.notices.getSnapshot()).toMatchObject({ level: 'error', text: zh['attachments.unavailable'] })
      expect(localStorage.getItem(UNLOAD_MARK)).toBeNull()
    } finally {
      await second.runtime.dispose()
    }
  })

  it('drops marks a back-forward restore made stale', async () => {
    const b = await bench()
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      window.dispatchEvent(new Event('pagehide'))
      const restore = new Event('pageshow') as PageTransitionEvent
      Object.defineProperty(restore, 'persisted', { value: false })
      window.dispatchEvent(restore)
      expect(localStorage.getItem(UNLOAD_MARK)).toBe('1')
      const cached = new Event('pageshow') as PageTransitionEvent
      Object.defineProperty(cached, 'persisted', { value: true })
      window.dispatchEvent(cached)
      expect(localStorage.getItem(UNLOAD_MARK)).toBeNull()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps working when browser storage refuses the marks', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = await bench(() => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    })
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      window.dispatchEvent(new Event('pagehide'))
      expect(b.shell.snapshot.attachmentIds).toEqual([draft.id])
      expect(errors).toHaveBeenCalledTimes(2)
    } finally {
      await b.runtime.dispose()
    }
  })
})

describe('submitted attachments', () => {
  it('does not hold or report attachments of an accepted message', async () => {
    const b = await bench()
    try {
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      await vi.waitFor(() => { expect(b.root.fileUploads.getSnapshot()[draft.id]?.status).toBe('ready') })
      b.shell.setDraft('send with file')
      b.shell.submit('queue', 'click')
      await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
      await b.runtime.flush()
      // The registry still holds the attachment for the echo; the draft no longer owns it.
      expect(b.root.resolveDraftAttachments([draft.id])).toHaveLength(1)
      expect(b.runtime.sessions.retainInfo(sessionId()).getSnapshot().retainedBy.draft).toBeUndefined()
      window.dispatchEvent(new Event('pagehide'))
      expect(localStorage.getItem(UNLOAD_MARK)).toBeNull()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('keeps a slash line adjudicating with its attachments while the Session is switched away', async () => {
    const adjudicate = vi.fn(() => new Promise<never>(() => undefined))
    const b = await bench()
    try {
      const lexicon = { getSnapshot: () => new Map<'/' | '@', readonly string[]>(), subscribe: () => () => undefined }
      const triggers = { adjudicate, lexicon, track: vi.fn() }
      b.runtime.ctx.provide('inputTriggers', { sessionOf: () => triggers } as never)
      b.behavior().uploadFile = vi.fn(() => Promise.resolve({ ok: true, value: uploadValue('notes.txt') }))
      const [draft] = b.root.createDrafts(sessionId(), [draftFile()], true)
      if (draft === undefined) throw new Error('draft missing')
      b.shell.addAttachments([draft.id])
      b.shell.setDraft('/review this file')
      b.shell.submit('queue', 'enter')
      expect(b.shell.snapshot.phase).toBe('adjudicating')
      expect(adjudicate).toHaveBeenCalledOnce()
      await b.switchAway()
      const back = await b.switchBack()
      expect(back.snapshot.phase).toBe('adjudicating')
      expect(back.snapshot.attachmentIds).toEqual([draft.id])
    } finally {
      await b.runtime.dispose()
    }
  })
})
