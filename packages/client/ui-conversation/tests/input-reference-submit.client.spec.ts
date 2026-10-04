/**
 * Reference-submit transaction coverage: chips serialize through their
 * owner, stay resident through Host rejection, and clear only after an
 * accepted prompt.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerController, SubmitOutcome, PickOutcome } from '../src/client/contract/input.ts'
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
    first.bindDraftPersistence((draft) => { mirror(draft.text) })
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
    const submitted = vi.fn()
    let settle!: (outcome: SubmitOutcome) => void
    const sink = vi.fn(() => new Promise<SubmitOutcome>((resolve) => { settle = resolve }))
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: sink,
      commandAttachments,
      messageSubmitted: submitted,
    })
    expect(shell.addAttachments(['img-1' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(submitted).toHaveBeenCalledOnce()
    settle({ kind: 'success' })
    await vi.waitFor(() => {
      expect(shell.snapshot.attachmentIds).toEqual([])
    })

    expect(shell.addAttachments(['img-2' as DraftAttachmentId])).toBe(true)
    shell.submit('queue')
    expect(sink).toHaveBeenCalledTimes(2)
    expect(submitted).toHaveBeenCalledTimes(2)
    settle({ kind: 'success' })
    shell.dispose()
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


it('captures click and Enter submission intent before async admission, excluding empty submits', async () => {
  const report = vi.fn()
  const submissionState = vi.fn(() => ({ runMode: 'default' as const, running: false }))
  const shell = new SessionInputShell({ actx: {} as Context, defaultSink: async () => ({ kind: 'success' }), commandAttachments, submissionState, messageSubmitted: report })
  try {
    shell.submit('queue', 'click')
    expect(submissionState).not.toHaveBeenCalled()
    shell.setDraft('first')
    shell.submit('steer', 'click')
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ mode: 'steer', source: 'click' }))
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    shell.setDraft('second')
    shell.submit('queue', 'enter')
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'queue', source: 'enter' }))
    expect(report).toHaveBeenCalledTimes(2)
  } finally { shell.dispose() }
})


it.each(['capture', 'report'])('analytics %s failure does not interrupt a message', async (stage) => {
  const sink = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: 'success' }))
  const fail = () => { throw new Error('analytics unavailable') }
  const shell = new SessionInputShell({ actx: {} as Context, defaultSink: sink, commandAttachments,
    ...stage === 'capture' ? { submissionState: fail } : { messageSubmitted: fail } })
  try {
    shell.setDraft('message')
    expect(() => { shell.submit('queue', 'click') }).not.toThrow()
    expect(sink).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
  } finally { shell.dispose() }
})


it.each(['handled', 'claim', 'message'] as const)('counts only a message after asynchronous slash adjudication: %s', async (kind) => {
  const pending = Promise.withResolvers<PickOutcome>()
  const report = vi.fn()
  const submissionState = vi.fn(() => ({ runMode: 'default' as const, running: false }))
  const command = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: 'success' }))
  const sink = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: 'success' }))
  const inputTriggers: InputTriggerController = {
    launcher: { getSnapshot: () => null, subscribe: () => () => {} },
    lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
    track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
    serializeReference: async () => '', openReference: () => false, toggleSource: () => {},
    adjudicate: () => pending.promise,
  }
  const shell = new SessionInputShell({ actx: {} as Context, inputTriggers: () => inputTriggers,
    submissionState, messageSubmitted: report, defaultSink: sink, commandAttachments })
  try {
    shell.setDraft('/compact')
    shell.submit('queue', 'enter')
    expect(report).not.toHaveBeenCalled()
    pending.resolve(kind === 'handled' ? 'handled' : kind === 'claim' ? { claim: { name: 'compact', token: '/compact', submit: command } } : undefined)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(report).toHaveBeenCalledTimes(kind === 'message' ? 1 : 0)
    expect(sink).toHaveBeenCalledTimes(kind === 'message' ? 1 : 0)
    expect(submissionState).toHaveBeenCalledOnce()
    shell.setDraft('programmatic')
    shell.actions.submit()
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'queue' }))
    expect(report.mock.calls.at(-1)?.[0]).not.toHaveProperty('source')
  } finally { shell.dispose() }
})

it('retains occurrence time and Session facts across arbitration and independent failed sends', async () => {
  const pending = Promise.withResolvers<PickOutcome>()
  const submitted = vi.fn()
  const firstSend = Promise.withResolvers<SubmitOutcome>()
  const secondSend = Promise.withResolvers<SubmitOutcome>()
  const sink = vi.fn().mockReturnValueOnce(firstSend.promise).mockReturnValueOnce(secondSend.promise)
  let running = true
  let now = 100
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const shell = new SessionInputShell({ actx: {} as Context, commandAttachments,
    submissionState: () => Object.freeze({ runMode: running ? 'plan' : 'default', running }),
    messageSubmitted: submitted,
    inputTriggers: () => ({
      launcher: { getSnapshot: () => null, subscribe: () => () => {} },
      lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
      track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
      serializeReference: async () => '', openReference: () => false, toggleSource: () => {},
      adjudicate: () => pending.promise,
    }),
    defaultSink: sink,
  })
  try {
    shell.setDraft('/ordinary')
    shell.submit('steer', 'click')
    running = false
    now = 200
    expect(submitted).not.toHaveBeenCalled()
    pending.resolve(undefined)
    await vi.waitFor(() => { expect(submitted).toHaveBeenCalledOnce() })
    expect(submitted).toHaveBeenLastCalledWith({ timestamp: 100, source: 'click', mode: 'steer', state: { running: true, runMode: 'plan' } })
    shell.setDraft('second')
    shell.actions.submit()
    expect(submitted).toHaveBeenLastCalledWith({ timestamp: 200, mode: 'queue', state: { running: false, runMode: 'default' } })
    await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(2) })
    secondSend.resolve({ kind: 'error', text: 'second rejected' })
    firstSend.resolve({ kind: 'error', text: 'first rejected' })
    await Promise.all([firstSend.promise, secondSend.promise])
    expect(submitted).toHaveBeenCalledTimes(2)
  } finally {
    firstSend.resolve({ kind: 'success' })
    secondSend.resolve({ kind: 'success' })
    shell.dispose()
    clock.mockRestore()
  }
})
