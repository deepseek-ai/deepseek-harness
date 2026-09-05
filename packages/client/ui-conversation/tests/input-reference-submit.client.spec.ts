/**
 * Reference-submit transaction coverage: chips serialize through their
 * owner, stay resident through Host rejection, and clear only after an
 * accepted prompt.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerController, SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'

const mention = '@[Research](dsh-session:InNvdXJjZSI)'
const spacedMention = '@[Research notes](dsh-session:InNvdXJjZSI)'
const commandAttachments = {
  serialize: () => Promise.resolve([]),
  release: () => {},
  unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported`,
}

function chip(shell: SessionInputShell): void {
  shell.setDraft('@res')
  const accepted = shell.insertReference({
    source: 'reference',
    ref: mention,
    label: 'Research',
    clipboardText: mention,
  }, {
    start: 0,
    end: 4,
    draftRev: shell.snapshot.draftRev,
  })
  expect(accepted).toBe(true)
}

describe('reference submission', () => {
  it('mirrors canonical reference text so a persisted draft remains resolvable after remount', async () => {
    const mirror = vi.fn()
    const first = new SessionInputShell({
      actx: {} as Context,
      defaultSink: vi.fn(),
      commandAttachments,
    })
    first.bindMirror(mirror)
    first.setDraft('@res')
    expect(first.insertReference({
      source: 'reference',
      ref: spacedMention,
      label: 'Research notes',
      appearance: 'session',
      clipboardText: spacedMention,
    }, {
      start: 0,
      end: 4,
      draftRev: first.snapshot.draftRev,
    })).toBe(true)
    // InputState.draft IS the clipboard projection now (chips expand to their
    // canonical text); the display label lives in the chip's decorator DOM.
    expect(first.snapshot.draft).toBe(`${spacedMention} `)
    expect(mirror).toHaveBeenLastCalledWith(`${spacedMention} `)

    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
    const restored = new SessionInputShell({
      actx: {} as Context,
      defaultSink: sink,
      commandAttachments,
    })
    restored.setDraft(mirror.mock.calls.at(-1)?.[0] as string)
    restored.submit()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledWith(spacedMention, [], 'queue', expect.any(AbortSignal))
    })
  })

  it('retains the chip on Host failure and clears it only after a later accepted retry', async () => {
    const serializeReference = vi.fn(() => Promise.resolve(mention))
    const sink = vi.fn<(
      _text: string,
      _imageIds: readonly DraftAttachmentId[],
      _mode: 'queue' | 'steer',
      _signal: AbortSignal,
    ) => Promise<SubmitOutcome>>()
      .mockResolvedValueOnce({ kind: 'error', text: 'snapshot unavailable' })
      .mockResolvedValueOnce({ kind: 'success' })
    const inputTriggers = {
      serializeReference,
      track: vi.fn(),
      lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    } as unknown as InputTriggerController
    const shell = new SessionInputShell({
      actx: {} as Context,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandAttachments,
    })
    chip(shell)
    expect(shell.snapshot).toMatchObject({
      draft: `${mention} `,
      occurrences: [{ source: 'reference', ref: mention, label: 'Research', offset: 0, length: mention.length }],
    })

    shell.submit('queue')
    // Optimistic commit: the composer clears at enter and stays unlocked
    // while the detached flight runs.
    expect(shell.snapshot.phase).toBe('plain')
    expect(shell.snapshot.draft).toBe('')
    await vi.waitFor(() => {
      expect(shell.snapshot.draft).toBe(`${mention} `)
    })
    expect(sink).toHaveBeenNthCalledWith(1, mention, [], 'queue', expect.any(AbortSignal))
    expect(shell.snapshot).toMatchObject({
      draft: `${mention} `,
      occurrences: [{ source: 'reference', ref: mention, label: 'Research', offset: 0, length: mention.length }],
    })
    expect(shell.notices.getSnapshot()).toMatchObject({
      level: 'error',
      text: 'snapshot unavailable',
    })

    shell.submit('queue')
    expect(shell.snapshot.draft).toBe('')
    await vi.waitFor(() => {
      expect(sink).toHaveBeenNthCalledWith(2, mention, [], 'queue', expect.any(AbortSignal))
    })
    expect(shell.snapshot.occurrences).toEqual([])
    expect(serializeReference).toHaveBeenCalledTimes(2)
  })

  it('blocks submission and retains the chip when its owner cannot serialize it', async () => {
    const sink = vi.fn()
    const inputTriggers = {
      serializeReference: () => Promise.reject(new Error('reference codec unavailable')),
      track: vi.fn(),
      lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    } as unknown as InputTriggerController
    const shell = new SessionInputShell({
      actx: {} as Context,
      inputTriggers: () => inputTriggers,
      defaultSink: sink,
      commandAttachments,
    })
    chip(shell)
    shell.submit()
    // The serializer rejection restores the optimistic commit with its chip.
    await vi.waitFor(() => {
      expect(shell.snapshot.draft).toBe(`${mention} `)
    })
    expect(sink).not.toHaveBeenCalled()
    expect(shell.snapshot.occurrences).toHaveLength(1)
    expect(shell.notices.getSnapshot()).toMatchObject({
      level: 'error',
      text: 'reference codec unavailable',
    })
  })

  it('aborts Host-side preparation when the input shell is disposed', () => {
    let signal: AbortSignal | undefined
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: (_text, _imageIds, _mode, received) => {
        signal = received
        return new Promise<SubmitOutcome>(() => {})
      },
      commandAttachments,
    })
    shell.setDraft('send this')
    shell.submit()
    expect(signal?.aborted).toBe(false)
    shell.dispose()
    expect(signal?.aborted).toBe(true)
    expect(shell.snapshot.phase).toBe('plain')
    // The optimistic commit stands: disposal drops the settlement, so the
    // sent draft is not restored into the dying composer.
    expect(shell.snapshot.draft).toBe('')
  })

  it('retains a rejected default message without duplicating its prompt error notice', async () => {
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: () => Promise.resolve({ kind: 'error' }),
      commandAttachments,
    })
    shell.setDraft('retry this')
    shell.submit()
    await vi.waitFor(() => {
      expect(shell.snapshot.phase).toBe('plain')
    })
    expect(shell.snapshot.draft).toBe('retry this')
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('restores concurrent failed messages in submission order', async () => {
    const settlements: Array<(outcome: SubmitOutcome) => void> = []
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: () => new Promise<SubmitOutcome>((resolve) => { settlements.push(resolve) }),
      commandAttachments,
    })
    shell.setDraft('first')
    shell.submit()
    shell.setDraft('second')
    shell.submit()
    expect(shell.snapshot.draft).toBe('')

    settlements[0]?.({ kind: 'error' })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('first') })
    settlements[1]?.({ kind: 'error' })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('first\n\nsecond') })
  })
})

describe('submit transaction hardening', () => {
  it('sends one image-only prompt per settlement, ignoring Enter during the round-trip', async () => {
    let settle!: (outcome: SubmitOutcome) => void
    const sink = vi.fn(() => new Promise<SubmitOutcome>((resolve) => { settle = resolve }))
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: sink,
      commandAttachments,
    })
    expect(shell.addAttachments(['img-1' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(1)
    settle({ kind: 'success' })
    await vi.waitFor(() => {
      expect(shell.snapshot.attachmentIds).toEqual([])
    })

    expect(shell.addAttachments(['img-2' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('retains an image-only rejection without duplicating its prompt error notice', async () => {
    const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'error' }))
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: sink,
      commandAttachments,
    })
    const imageId = 'img-1' as DraftAttachmentId
    shell.addAttachments([imageId])
    shell.submit()
    await Promise.resolve()
    await Promise.resolve()
    expect(shell.snapshot.attachmentIds).toEqual([imageId])
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('aborts an unsettled image-only send and returns its image id at disposal', () => {
    let signal: AbortSignal | undefined
    const imageId = 'img-flight' as DraftAttachmentId
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: (_text, _ids, _mode, received) => {
        signal = received
        return new Promise<SubmitOutcome>(() => {})
      },
      commandAttachments,
    })
    shell.addAttachments([imageId])
    shell.submit()
    expect(signal?.aborted).toBe(false)
    expect(shell.dispose()).toEqual([imageId])
    expect(signal?.aborted).toBe(true)
  })

  it('re-tracks at the caret when an insert-text splice lands (directory descent reopens the menu)', () => {
    const track = vi.fn()
    const lexicon = { getSnapshot: () => new Map(), subscribe: () => () => {} }
    const shell = new SessionInputShell({
      actx: {} as Context,
      inputTriggers: () => ({ track, lexicon } as unknown as InputTriggerController),
      defaultSink: vi.fn(),
      commandAttachments,
    })
    shell.setDraft('@sr')
    const applied = shell.insertText('@src/', { start: 0, end: 3, draftRev: shell.snapshot.draftRev }, true)
    expect(applied).toBe(true)
    expect(shell.snapshot.draft).toBe('@src/')
    // Every editor commit re-tracks at the settled caret (the continue flag
    // is a contract passenger now): a trailing '/' keeps the menu open.
    expect(track).toHaveBeenCalledWith('@src/', 5, { tier: 'plain' }, shell.snapshot.draftRev)
  })
})
