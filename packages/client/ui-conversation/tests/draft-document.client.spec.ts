// @vitest-environment jsdom
/** Structured draft import, persistence, and reference restoration through the real input shell. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { $getRoot, $nodesOfType, REDO_COMMAND, UNDO_COMMAND } from 'lexical'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DraftReference, DraftSnapshot, Occurrence } from '../src/client/contract/draft-editor.ts'
import type {
  CommandClaim, DraftAttachmentId, InputTriggerController, PickOutcome, SubmitOutcome,
} from '../src/client/contract/input.ts'
import { parseStoredDraft, resolveDraftInput, snapshotDraft } from '../src/client/draft.ts'
import { scanTextRefs } from '../src/client/input/decorations.ts'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { CommandChipNode } from '../src/client/input/editor/command-chip-node.tsx'
import { TextRefNode } from '../src/client/input/editor/text-ref.ts'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'

type ReferenceContent = Omit<DraftReference, 'offset' | 'length'>

const file: ReferenceContent = {
  source: 'reference', ref: '@src/main.ts', label: 'main.ts', appearance: 'file', clipboardText: '@src/main.ts',
}
const folder: ReferenceContent = {
  source: 'reference', ref: '@src/', label: 'src/', appearance: 'folder', clipboardText: '@src/',
}
const session: ReferenceContent = {
  source: 'reference', ref: '@[研究记录](dsh-session:c291cmNl)', label: '研究记录', appearance: 'session',
  clipboardText: '@[研究记录](dsh-session:c291cmNl)',
}

function documentOf(...parts: readonly (string | ReferenceContent)[]): DraftSnapshot {
  let text = ''
  const references: DraftReference[] = []
  for (const part of parts) {
    if (typeof part === 'string') text += part
    else {
      references.push({ ...part, offset: text.length, length: part.clipboardText.length })
      text += part.clipboardText
    }
  }
  return { text, references }
}

function makeShell(overrides: Partial<SessionInputDeps> = {}): SessionInputShell {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const shell = new SessionInputShell({
    actx: ctx,
    defaultSink: () => Promise.resolve<SubmitOutcome>({ kind: 'success' }),
    commandAttachments: {
      serialize: () => Promise.resolve([]),
      release: () => {},
      unsupportedNotice: token => token,
    },
    ...overrides,
  })
  onTestFinished(() => { shell.dispose() })
  shell.refreshLexiconSubscription()
  return shell
}

function chips(shell: SessionInputShell) {
  return shell.editor.getEditorState().read(() => $nodesOfType(ReferenceChipNode).map(node => ({
    source: node.getSource(), ref: node.getReference(), label: node.getLabel(),
    appearance: node.getAppearance(), clipboardText: node.getTextContent(), invalid: node.isInvalid(),
  })))
}

function textReferences(shell: SessionInputShell): string[] {
  return shell.editor.getEditorState().read(() => $getRoot().getAllTextNodes()
    .filter(node => node instanceof TextRefNode).map(node => node.getTextContent()))
}

function triggerProvider(lexicon: InputTriggerController['lexicon']): InputTriggerController {
  return {
    lexicon,
    launcher: createSnapshotStore<string | null>(null),
    track: () => {},
    arbitrate: () => 'pass',
    onSpace: () => false,
    serializeReference: (_source, ref) => Promise.resolve(ref),
    adjudicate: () => Promise.resolve(undefined),
    resolveClaim: () => Promise.resolve(undefined),
    openReference: () => false,
    toggleSource: () => {},
  }
}

/** A goal claim whose submissions are recorded. */
function goalClaim(): CommandClaim & { readonly submitted: string[] } {
  const submitted: string[] = []
  return {
    name: 'goal',
    token: '/goal ',
    submitted,
    submit: (args) => {
      submitted.push(args)
      return Promise.resolve({ kind: 'success' })
    },
  }
}

/** Number of command chips in the shell's document. */
function commandChips(shell: SessionInputShell): number {
  return shell.editor.getEditorState().read(() => $nodesOfType(CommandChipNode).length)
}

/** The persisted form of `/goal ship` claimed as a command chip. */
function storedGoalDraft(): DraftSnapshot {
  const original = makeShell()
  original.setDraft('/goal ')
  expect(original.beginCommand(goalClaim(), { start: 0, end: '/goal '.length, draftRev: original.snapshot.draftRev })).toBe(true)
  expect(original.actions.insertText('ship', original.actions.captureInsertion())).toBe(true)
  const stored = parseStoredDraft(JSON.parse(JSON.stringify(original.draftSnapshot)))
  if (stored === undefined) throw new Error('Expected a stored draft')
  expect(stored).toEqual({ text: '/goal ship', references: [], command: { token: '/goal ' } })
  return stored
}

function expectInitializationBlocked(shell: SessionInputShell): void {
  const draft = shell.draftSnapshot
  const attachmentIds = shell.snapshot.attachmentIds
  const references = chips(shell)
  const write = vi.fn<(value: DraftSnapshot) => void>()
  const unbind = shell.bindDraftPersistence(write)
  try {
    expect(shell.requestDraftInitialization({ clearPreviousDraft: true })).toBe('blocked')
    expect(shell.requestDraftInitialization({ prompt: 'replacement @src/', clearPreviousDraft: true })).toBe('blocked')
    expect(shell.draftSnapshot).toBe(draft)
    expect(shell.snapshot.attachmentIds).toBe(attachmentIds)
    expect(chips(shell)).toEqual(references)
    expect(write).not.toHaveBeenCalled()
  } finally { unbind() }
}

describe('draft document values', () => {
  it.each(['', 'plain text', 'first\nsecond\n', '\n\n', '🙂 中文 e\u0301\n第二行'])('round-trips plain text %j', (text) => {
    const expected = { text, references: [] }
    expect(resolveDraftInput(text)).toEqual(expected)
    expect(parseStoredDraft(text)).toEqual(expected)
    expect(parseStoredDraft(JSON.parse(JSON.stringify(expected)))).toEqual(expected)
    const shell = makeShell()
    shell.setDraft(text)
    expect(shell.snapshot.draft).toBe(text)
    expect(shell.draftSnapshot).toEqual(expected)
    expect(chips(shell)).toEqual([])
  })

  it('copies a structured input independently of its caller', () => {
    const reference = { ...file, offset: 0, length: file.clipboardText.length }
    const input = { text: file.clipboardText, references: [reference] }
    const resolved = resolveDraftInput(input)
    expect(resolved).toEqual(input)
    expect(resolved).not.toBe(input)
    expect(resolved.references).not.toBe(input.references)
    expect(resolved.references[0]).not.toBe(reference)
    reference.label = 'changed by caller'
    input.references.length = 0
    expect(resolved.references).toEqual([{ ...file, offset: 0, length: file.clipboardText.length }])
  })

  it('exports repeated references without editor-local occurrence identities', () => {
    const draft = documentOf('🙂 ', file, '\n', file)
    const occurrences: Occurrence[] = draft.references.map((reference, index) => ({ ...reference, occurrenceId: index + 41 }))
    const exported = snapshotDraft(draft.text, occurrences)
    expect(exported).toEqual(draft)
    expect(exported.references).toHaveLength(2)
    expect(exported.references.every(reference => !('occurrenceId' in reference))).toBe(true)
    expect(JSON.stringify(exported)).not.toContain('occurrenceId')
    expect(parseStoredDraft(JSON.parse(JSON.stringify(exported)))).toEqual(draft)
  })

  it('accepts touching reference spans and references without optional metadata', () => {
    const draft = documentOf(file, folder, { source: 'custom', ref: 'entry', label: 'Entry', clipboardText: '@entry' })
    expect(parseStoredDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft)
    const shell = makeShell()
    shell.setDraft(draft)
    expect(shell.draftSnapshot).toEqual(draft)
    expect(chips(shell)).toHaveLength(3)
  })

  it('decodes explicit false metadata and discards persisted editor-local fields', () => {
    const draft = documentOf({ ...file, invalid: false })
    const stored = {
      ...draft,
      revision: 17,
      references: draft.references.map(reference => ({ ...reference, occurrenceId: 42, nodeKey: 'old-node' })),
    }
    const parsed = parseStoredDraft(JSON.parse(JSON.stringify(stored)))
    expect(parsed).toEqual(draft)
    expect(parsed?.references[0]).toHaveProperty('invalid', false)
    expect(parsed?.references[0]).not.toHaveProperty('occurrenceId')
    expect(parsed?.references[0]).not.toHaveProperty('nodeKey')
  })

  it('carries a leading command token through copy, export, and storage', () => {
    const input = { text: `/goal ${file.clipboardText}`, references: [{ ...file, offset: 6, length: file.clipboardText.length }], command: { token: '/goal ' } }
    const resolved = resolveDraftInput(input)
    expect(resolved).toEqual(input)
    expect(resolved.command).not.toBe(input.command)
    const exported = snapshotDraft(input.text, input.references.map(reference => ({ ...reference, occurrenceId: 7 })), '/goal ')
    expect(exported).toEqual(input)
    expect(parseStoredDraft(JSON.parse(JSON.stringify(exported)))).toEqual(input)
    expect(parseStoredDraft({ text: '/目标', references: [], command: { token: '/目标 ' } })).toEqual(
      { text: '/目标', references: [], command: { token: '/目标 ' } },
    )
  })

  it.each<{ name: string; value: unknown }>([
    { name: 'a token the text does not open', value: { text: 'ship /goal', references: [], command: { token: '/goal ' } } },
    { name: 'a token without its trigger', value: { text: 'goal ship', references: [], command: { token: 'goal ' } } },
    { name: 'a token without a name', value: { text: '/ ship', references: [], command: { token: '/ ' } } },
    { name: 'a non-string token', value: { text: '/goal', references: [], command: { token: 1 } } },
    { name: 'a reference overlapping the token', value: {
      text: '/goal', references: [{ source: 'skill', ref: 'goal', label: 'goal', clipboardText: '/goal', offset: 0, length: 5 }],
      command: { token: '/goal ' },
    } },
  ])('rejects a stored command with $name', ({ value }) => {
    expect(parseStoredDraft(value)).toBeUndefined()
  })

  const valid = documentOf(file)
  const reference = { ...file, offset: 0, length: file.clipboardText.length }
  it.each<{ name: string; value: unknown }>([
    { name: 'null', value: null },
    { name: 'missing value', value: undefined },
    { name: 'scalar number', value: 7 },
    { name: 'array root', value: [] },
    { name: 'missing text', value: { references: [] } },
    { name: 'missing references', value: { text: '' } },
    { name: 'non-string text', value: { text: 3, references: [] } },
    { name: 'non-array references', value: { text: '', references: {} } },
    { name: 'null reference', value: { ...valid, references: [null] } },
    { name: 'negative offset', value: { ...valid, references: [{ ...reference, offset: -1 }] } },
    { name: 'fractional offset', value: { ...valid, references: [{ ...reference, offset: 0.5 }] } },
    { name: 'empty span', value: { ...valid, references: [{ ...reference, length: 0 }] } },
    { name: 'fractional length', value: { ...valid, references: [{ ...reference, length: 1.5 }] } },
    { name: 'span beyond text', value: { ...valid, references: [{ ...reference, offset: 1 }] } },
    { name: 'length differing from clipboard text', value: { ...valid, references: [{ ...reference, length: 1 }] } },
    { name: 'mismatched clipboard text', value: { text: 'x'.repeat(valid.text.length), references: [reference] } },
    { name: 'overlapping references', value: { ...valid, references: [reference, { ...reference }] } },
    { name: 'unordered references', value: { text: `${valid.text} ${valid.text}`, references: [
      { ...reference, offset: valid.text.length + 1 }, reference,
    ] } },
    { name: 'unsupported appearance', value: { ...valid, references: [{ ...reference, appearance: 'image' }] } },
    { name: 'non-boolean invalid flag', value: { ...valid, references: [{ ...reference, invalid: 'true' }] } },
    { name: 'non-string source', value: { ...valid, references: [{ ...reference, source: 1 }] } },
  ])('rejects stored $name', ({ value }) => {
    expect(parseStoredDraft(value)).toBeUndefined()
  })
})

describe('draft documents in the input shell', () => {
  it('imports file, folder, session, repeated, and invalid references on the first document', () => {
    const draft = documentOf('🙂 文件 ', file, '\n目录 ', folder, '\n会话 ', session, ' 再次 ', file, ' ', {
      ...session, invalid: true,
    })
    const shell = makeShell()
    shell.setDraft(draft)
    expect(shell.draftSnapshot).toEqual(draft)
    expect(shell.snapshot.draft).toBe(draft.text)
    expect(chips(shell)).toEqual(draft.references.map(reference => ({
      source: reference.source, ref: reference.ref, label: reference.label,
      appearance: reference.appearance, clipboardText: reference.clipboardText, invalid: reference.invalid ?? false,
    })))
    expect(new Set(shell.snapshot.occurrences.map(occurrence => occurrence.occurrenceId)).size).toBe(5)
  })

  it('restores semantic references after JSON persistence into another shell', () => {
    const original = makeShell()
    original.setDraft(documentOf(file, '\n', folder, '\n', session, ' ', { ...file, invalid: true }))
    const stored = parseStoredDraft(JSON.parse(JSON.stringify(original.draftSnapshot)))
    expect(stored).toBeDefined()
    if (stored === undefined) throw new Error('Expected a stored draft')
    const restored = makeShell()
    restored.setDraft(stored)
    expect(restored.draftSnapshot).toEqual(original.draftSnapshot)
    expect(chips(restored)).toEqual(chips(original))
  })

  it('rebuilds a persisted command chip once the trigger pipeline resolves its claim', async () => {
    const stored = storedGoalDraft()
    const claim = goalClaim()
    const resolution = Promise.withResolvers<CommandClaim | undefined>()
    const resolveClaim = vi.fn<InputTriggerController['resolveClaim']>(() => resolution.promise)
    const provider: InputTriggerController = { ...triggerProvider(createSnapshotStore(new Map())), resolveClaim }
    const shell = makeShell({ inputTriggers: () => provider })
    shell.setDraft(stored)
    expect(resolveClaim).toHaveBeenCalledWith('/goal', expect.any(AbortSignal))
    expect(shell.snapshot.phase).toBe('plain')
    expect(commandChips(shell)).toBe(0)
    resolution.resolve(claim)
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
    expect(commandChips(shell)).toBe(1)
    expect(shell.draftSnapshot).toEqual(stored)
    // The chip belongs to the restored seed, so undo has no step to revert.
    shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
    shell.editor.update(() => {}, { discrete: true })
    expect(commandChips(shell)).toBe(1)
    shell.submit()
    await vi.waitFor(() => { expect(claim.submitted).toEqual(['ship']) })
  })

  it('waits for the trigger pipeline before resolving a restored command chip', async () => {
    const stored = storedGoalDraft()
    const resolveClaim = vi.fn<InputTriggerController['resolveClaim']>(() => Promise.resolve(goalClaim()))
    const pipeline: { provider?: InputTriggerController } = {}
    const shell = makeShell({ inputTriggers: () => pipeline.provider })
    shell.setDraft(stored)
    shell.refreshLexiconSubscription()
    expect(commandChips(shell)).toBe(0)
    pipeline.provider = { ...triggerProvider(createSnapshotStore(new Map())), resolveClaim }
    shell.refreshLexiconSubscription()
    shell.refreshLexiconSubscription()
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
    expect(resolveClaim).toHaveBeenCalledTimes(1)
    expect(commandChips(shell)).toBe(1)
  })

  it.each<{ name: string; settle: (shell: SessionInputShell, resolution: PromiseWithResolvers<CommandClaim | undefined>) => void }>([
    { name: 'the draft changed while the claim resolved', settle: (shell, resolution) => {
      expect(shell.actions.insertText(' now', shell.actions.captureInsertion())).toBe(true)
      resolution.resolve(goalClaim())
    } },
    { name: 'no source claims the token', settle: (_shell, resolution) => { resolution.resolve(undefined) } },
    { name: 'catalog warmup fails', settle: (_shell, resolution) => { resolution.reject(new Error('catalog unavailable')) } },
  ])('keeps the literal command token when $name', async ({ settle }) => {
    const resolution = Promise.withResolvers<CommandClaim | undefined>()
    const provider: InputTriggerController = {
      ...triggerProvider(createSnapshotStore(new Map())), resolveClaim: () => resolution.promise,
    }
    const shell = makeShell({ inputTriggers: () => provider })
    shell.setDraft(storedGoalDraft())
    const literal = shell.snapshot.draft
    settle(shell, resolution)
    await setImmediate()
    expect(shell.snapshot.phase).toBe('plain')
    expect(commandChips(shell)).toBe(0)
    expect(shell.snapshot.draft.startsWith(literal)).toBe(true)
    expect(shell.notices.getSnapshot()).toBeNull()
  })

  it('aborts a pending command chip restore when a new draft replaces it or the shell disposes', () => {
    const signals: AbortSignal[] = []
    const provider: InputTriggerController = {
      ...triggerProvider(createSnapshotStore(new Map())),
      resolveClaim: (_token, signal) => { signals.push(signal); return new Promise(() => {}) },
    }
    const shell = makeShell({ inputTriggers: () => provider })
    shell.setDraft(storedGoalDraft())
    shell.setDraft('plain replacement')
    expect(signals[0]?.aborted).toBe(true)
    shell.setDraft(storedGoalDraft())
    shell.dispose()
    expect(signals[1]?.aborted).toBe(true)
  })

  it.each([
    { name: 'before the first reference', prefix: '\uE100\uFFFC🙂 before ', middle: ' between ' },
    { name: 'between references', prefix: '🙂 before ', middle: '\uE11D between \uFFFC' },
  ])('sanitizes reserved placeholders $name and recalculates reference offsets', ({ prefix, middle }) => {
    const shell = makeShell()
    const input = documentOf(prefix, file, middle, session, ' after')
    shell.setDraft(input)
    const expected = documentOf('🙂 before ', file, ' between ', session, ' after')
    expect(shell.snapshot.draft).toBe(expected.text)
    expect(shell.draftSnapshot).toEqual(expected)
    expect(shell.draftSnapshot.references.map(reference => reference.offset)).toEqual(
      expected.references.map(reference => reference.offset),
    )
    expect(shell.draftSnapshot.references.map(reference => reference.ref)).toEqual(
      input.references.map(reference => reference.ref),
    )
    expect(chips(shell)).toMatchObject([
      { source: file.source, ref: file.ref, clipboardText: file.clipboardText },
      { source: session.source, ref: session.ref, clipboardText: session.clipboardText },
    ])
  })

  it('keeps snapshot identity stable through reads and selection-only editor updates', () => {
    const shell = makeShell()
    shell.setDraft(documentOf('before ', file))
    const draft = shell.draftSnapshot
    expect(shell.draftSnapshot).toBe(draft)
    shell.editor.update(() => { $getRoot().selectStart() }, { discrete: true })
    expect(shell.draftSnapshot).toBe(draft)
  })

  it('publishes reference-only changes even when the text stays equal', () => {
    const shell = makeShell()
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    shell.bindDraftPersistence(write)
    const first = documentOf(file)
    shell.setDraft(first)
    const previous = shell.draftSnapshot
    const changed = documentOf({ ...file, ref: '@src/other.ts', label: 'renamed', invalid: true })
    shell.setDraft(changed)
    expect(shell.snapshot.draft).toBe(first.text)
    expect(shell.draftSnapshot).toEqual(changed)
    expect(shell.draftSnapshot).not.toBe(previous)
    expect(write).toHaveBeenLastCalledWith(changed)
    expect(chips(shell)).toMatchObject([{ ref: '@src/other.ts', label: 'renamed', invalid: true }])
    shell.setDraft(first.text)
    expect(shell.draftSnapshot).toEqual({ text: first.text, references: [] })
    expect(chips(shell)).toEqual([])
    expect(write).toHaveBeenLastCalledWith({ text: first.text, references: [] })
  })

  it('binds persistence without saving and explicitly saves the current document', () => {
    const shell = makeShell()
    shell.setDraft(documentOf('read ', session))
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    const unbind = shell.bindDraftPersistence(write)
    expect(write).not.toHaveBeenCalled()
    shell.persistCurrentDraft()
    expect(write).toHaveBeenLastCalledWith(shell.draftSnapshot)
    shell.actions.persistDraft()
    expect(write).toHaveBeenCalledTimes(2)
    unbind()
    shell.setDraft('edited without a view')
    expect(write).toHaveBeenCalledTimes(2)
    const nextWrite = vi.fn<(draft: DraftSnapshot) => void>()
    shell.bindDraftPersistence(nextWrite)
    expect(nextWrite).not.toHaveBeenCalled()
    shell.actions.persistDraft()
    expect(nextWrite).toHaveBeenLastCalledWith({ text: 'edited without a view', references: [] })
  })

  it('keeps the replacement persistence writer when an earlier binding is disposed', () => {
    const shell = makeShell()
    const first = vi.fn<(draft: DraftSnapshot) => void>()
    const second = vi.fn<(draft: DraftSnapshot) => void>()
    shell.actions.persistDraft()
    const unbindFirst = shell.bindDraftPersistence(first)
    const unbindSecond = shell.bindDraftPersistence(second)
    unbindFirst()

    const draft = documentOf('retained ', file)
    shell.setDraft(draft)
    shell.actions.persistDraft()
    expect(first).not.toHaveBeenCalled()
    expect(second.mock.calls).toEqual([[draft], [draft]])

    unbindSecond()
    shell.actions.persistDraft()
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('applies initial text without waiting for a view or inferring reference chips', () => {
    const shell = makeShell()
    const prompt = `read ${file.clipboardText}`
    expect(shell.requestDraftInitialization({ prompt })).toBe('applied')
    expect(shell.draftSnapshot).toEqual({ text: prompt, references: [] })
    expect(chips(shell)).toEqual([])
  })

  it('preserves existing text or attachments unless target text is explicitly cleared', () => {
    const shell = makeShell()
    const old = documentOf('existing ', session)
    shell.setDraft(old)
    expect(shell.requestDraftInitialization({ prompt: 'replacement' })).toBe('preserved')
    expect(shell.draftSnapshot).toEqual(old)
    const attachment = 'draft-image' as DraftAttachmentId
    shell.addAttachments([attachment])
    shell.setDraft('')
    expect(shell.requestDraftInitialization({ prompt: 'replacement' })).toBe('preserved')
    expect(shell.snapshot.draft).toBe('')
    expect(shell.requestDraftInitialization({ prompt: 'replacement', clearPreviousDraft: true })).toBe('applied')
    expect(shell.snapshot.draft).toBe('replacement')
    expect(shell.snapshot.attachmentIds).toEqual([attachment])
    expect(shell.requestDraftInitialization({ clearPreviousDraft: true })).toBe('applied')
    expect(shell.snapshot.draft).toBe('')
    expect(shell.snapshot.attachmentIds).toEqual([attachment])
  })

  it('persists clearing so a persistence rebind and a new shell do not restore references', () => {
    const shell = makeShell()
    shell.setDraft(documentOf(file, ' ', session))
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    const unbind = shell.bindDraftPersistence(write)
    shell.persistCurrentDraft()
    expect(shell.requestDraftInitialization({ clearPreviousDraft: true })).toBe('applied')
    expect(write).toHaveBeenLastCalledWith({ text: '', references: [] })
    unbind()
    shell.bindDraftPersistence(write)
    shell.persistCurrentDraft()
    const saved = write.mock.calls.at(-1)?.[0]
    const parsed = parseStoredDraft(JSON.parse(JSON.stringify(saved)))
    if (parsed === undefined) throw new Error('Expected the cleared document')
    const restored = makeShell()
    restored.setDraft(parsed)
    expect(restored.draftSnapshot).toEqual({ text: '', references: [] })
    expect(chips(restored)).toEqual([])
  })

  it('leaves a document unchanged when no initialization option changes text', () => {
    const shell = makeShell()
    shell.setDraft(documentOf(file))
    const draft = shell.draftSnapshot
    expect(shell.requestDraftInitialization({})).toBe('preserved')
    expect(shell.requestDraftInitialization({ clearPreviousDraft: false })).toBe('preserved')
    expect(shell.draftSnapshot).toBe(draft)
  })

  it('rejects initialization after disposal', () => {
    const shell = makeShell()
    shell.setDraft('keep this')
    shell.dispose()
    expect(shell.requestDraftInitialization({ prompt: 'replace', clearPreviousDraft: true })).toBe('blocked')
    expect(shell.draftSnapshot).toEqual({ text: 'keep this', references: [] })
  })

  it('refuses draft initialization while slash adjudication retains the document', async () => {
    const adjudication = Promise.withResolvers<PickOutcome>()
    const started = Promise.withResolvers<undefined>()
    const lexicon = createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map())
    const provider: InputTriggerController = {
      ...triggerProvider(lexicon),
      adjudicate: () => { started.resolve(undefined); return adjudication.promise },
    }
    const shell = makeShell({ inputTriggers: () => provider })
    try {
      const draft = documentOf('/pending ', file)
      shell.setDraft(draft)
      shell.addAttachments(['pending-image' as DraftAttachmentId])
      shell.submit()
      await started.promise
      expect(shell.snapshot.phase).toBe('adjudicating')
      expectInitializationBlocked(shell)
      adjudication.reject(new Error('catalog unavailable'))
      await vi.waitFor(() => {
        expect(shell.snapshot.phase).toBe('plain')
        expect(shell.notices.getSnapshot()?.text).toBe('catalog unavailable')
      })
      expect(shell.draftSnapshot).toEqual(draft)
    } finally {
      shell.dispose()
      adjudication.resolve(undefined)
      await adjudication.promise.catch(() => undefined)
    }
  })

  it('refuses draft initialization while a claimed command is submitting', async () => {
    const outcome = Promise.withResolvers<SubmitOutcome>()
    const started = Promise.withResolvers<undefined>()
    const shell = makeShell()
    try {
      const draft = documentOf('/pending ', session)
      shell.setDraft(draft)
      expect(shell.beginCommand({
        name: 'pending', token: '/pending ', attachments: true,
        submit: () => { started.resolve(undefined); return outcome.promise },
      }, { start: 0, end: '/pending '.length, draftRev: shell.snapshot.draftRev })).toBe(true)
      shell.addAttachments(['command-image' as DraftAttachmentId])
      shell.submit()
      await started.promise
      expect(shell.snapshot.phase).toBe('submitting')
      expectInitializationBlocked(shell)
      outcome.resolve({ kind: 'error', text: 'command refused' })
      await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('claimed') })
      expect(shell.draftSnapshot).toEqual({ ...draft, command: { token: '/pending ' } })
    } finally {
      shell.dispose()
      outcome.resolve({ kind: 'error' })
      await outcome.promise
    }
  })

  it.each(['detached default-send', 'attachment'] as const)(
    'refuses draft initialization during a %s flight despite its editable phase', async (kind) => {
      const outcome = Promise.withResolvers<SubmitOutcome>()
      const started = Promise.withResolvers<undefined>()
      const sink = vi.fn<SessionInputDeps['defaultSink']>(() => { started.resolve(undefined); return outcome.promise })
      const shell = makeShell({ defaultSink: sink })
      try {
        const sentAttachment = 'sent-image' as DraftAttachmentId
        if (kind === 'attachment') shell.addAttachments([sentAttachment])
        else shell.setDraft('outbound message')
        shell.submit()
        await started.promise
        expect(sink).toHaveBeenCalledOnce()
        expect(sink.mock.calls[0]?.[1]).toEqual(kind === 'attachment' ? [sentAttachment] : [])
        shell.setDraft(documentOf('next message ', file))
        shell.addAttachments(['next-image' as DraftAttachmentId])
        expect(shell.snapshot.phase).toBe('plain')
        expectInitializationBlocked(shell)
        outcome.resolve({ kind: 'error', text: 'flight rejected' })
        await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('flight rejected') })
        expect(shell.requestDraftInitialization({ prompt: 'after settlement', clearPreviousDraft: true })).toBe('applied')
      } finally {
        shell.dispose()
        outcome.resolve({ kind: 'error' })
        await outcome.promise
      }
    },
  )

  it('matches a delayed skill lexicon against the current editable document without changing references', async () => {
    const lexicon = createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map())
    const provider = triggerProvider(lexicon)
    const shell = makeShell({ inputTriggers: () => provider })
    const previous = documentOf('/older ', file)
    shell.setDraft(previous)
    const current = documentOf('/current ', file)
    expect(shell.actions.insertText('/current', {
      start: 0, end: '/older'.length, draftRev: shell.snapshot.draftRev,
    })).toBe(true)
    const draft = shell.draftSnapshot
    expect(textReferences(shell)).toEqual([])
    lexicon.set(new Map([['/', ['older']]]))
    await vi.waitFor(() => { expect(textReferences(shell)).toEqual([]) })
    expect(shell.draftSnapshot).toBe(draft)
    lexicon.set(new Map([['/', ['older', 'current']]]))
    await vi.waitFor(() => { expect(textReferences(shell)).toEqual(['/current']) })
    expect(shell.draftSnapshot).toBe(draft)
    expect(shell.snapshot.phase).toBe('plain')
    expect(chips(shell)).toHaveLength(1)
    shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(shell.draftSnapshot).toEqual(previous) })
    // History retains the decoration state saved before the catalog was available.
    expect(textReferences(shell)).toEqual([])
    lexicon.set(new Map([['/', ['older', 'current', 'edited']]]))
    await vi.waitFor(() => { expect(textReferences(shell)).toEqual(['/older']) })
    expect(shell.draftSnapshot).toEqual(previous)
    shell.editor.dispatchCommand(REDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(shell.draftSnapshot).toEqual(current) })
    expect(textReferences(shell)).toEqual(['/current'])
    expect(shell.actions.insertText('/edited', {
      start: 0, end: '/current'.length, draftRev: shell.snapshot.draftRev,
    })).toBe(true)
    expect(shell.draftSnapshot).toEqual(documentOf('/edited ', file))
    lexicon.set(new Map([['/', ['edited']]]))
    await vi.waitFor(() => { expect(textReferences(shell)).toEqual(['/edited']) })
    expect(shell.draftSnapshot).toEqual(documentOf('/edited ', file))
    expect(shell.snapshot.phase).toBe('plain')
    expect(chips(shell)).toMatchObject([{ ref: file.ref, appearance: 'file' }])
  })

  it('restores and persists failed structured sends in submission order after reversed settlement', async () => {
    const first = Promise.withResolvers<SubmitOutcome>()
    const second = Promise.withResolvers<SubmitOutcome>()
    const provider = triggerProvider(createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()))
    const sink = vi.fn<SessionInputDeps['defaultSink']>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const shell = makeShell({ inputTriggers: () => provider, defaultSink: sink })
    const write = vi.fn<(draft: DraftSnapshot) => void>()
    shell.bindDraftPersistence(write)
    const firstDraft = documentOf('first 🙂 ', file)
    const secondDraft = documentOf('second ', session)
    try {
      shell.setDraft(firstDraft)
      shell.submit()
      shell.setDraft(secondDraft)
      shell.submit()
      await vi.waitFor(() => { expect(sink).toHaveBeenCalledTimes(2) })
      expect(shell.draftSnapshot).toEqual({ text: '', references: [] })
      second.resolve({ kind: 'error', text: 'second rejected' })
      await vi.waitFor(() => { expect(shell.draftSnapshot).toEqual(secondDraft) })
      expect(write).toHaveBeenLastCalledWith(secondDraft)
      first.resolve({ kind: 'error', text: 'first rejected' })
      const expected = documentOf('first 🙂 ', file, '\n\nsecond ', session)
      await vi.waitFor(() => { expect(shell.draftSnapshot).toEqual(expected) })
      expect(write).toHaveBeenLastCalledWith(expected)
      expect(parseStoredDraft(JSON.parse(JSON.stringify(write.mock.calls.at(-1)?.[0])))).toEqual(expected)
      expect(chips(shell)).toMatchObject([{ ref: file.ref }, { ref: session.ref }])
      expect(shell.requestDraftInitialization({ prompt: 'next', clearPreviousDraft: true })).toBe('applied')
    } finally {
      shell.dispose()
      first.resolve({ kind: 'error' })
      second.resolve({ kind: 'error' })
      await Promise.all([first.promise, second.promise])
      await setImmediate()
    }
  })

  it.each(['reject', 'dispose then resolve', 'dispose then reject'] as const)(
    'contains pending reference serialization when it must %s', async (settlement) => {
      const serialization = Promise.withResolvers<string>()
      const started = Promise.withResolvers<AbortSignal>()
      const provider: InputTriggerController = {
        ...triggerProvider(createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map())),
        serializeReference: (_source, _ref, signal) => {
          started.resolve(signal)
          return serialization.promise
        },
      }
      const sink = vi.fn<SessionInputDeps['defaultSink']>(() => Promise.resolve({ kind: 'success' }))
      const shell = makeShell({ inputTriggers: () => provider, defaultSink: sink })
      const write = vi.fn<(draft: DraftSnapshot) => void>()
      shell.bindDraftPersistence(write)
      const draft = documentOf('pending ', file)
      const attachment = 'pending-serialization-image' as DraftAttachmentId
      try {
        shell.setDraft(draft)
        shell.addAttachments([attachment])
        shell.submit()
        const signal = await started.promise
        expect(signal.aborted).toBe(false)
        expect(shell.snapshot.phase).toBe('plain')
        expectInitializationBlocked(shell)
        shell.bindDraftPersistence(write)

        if (settlement === 'reject') {
          serialization.reject('reference unavailable')
          await vi.waitFor(() => { expect(shell.notices.getSnapshot()?.text).toBe('reference unavailable') })
          expect(shell.draftSnapshot).toEqual(draft)
          expect(shell.snapshot.attachmentIds).toEqual([attachment])
          expect(write).toHaveBeenLastCalledWith(draft)
        } else {
          expect(shell.dispose()).toEqual([attachment])
          expect(signal.aborted).toBe(true)
          const disposedDraft = shell.draftSnapshot
          const writes = write.mock.calls.length
          if (settlement === 'dispose then resolve') serialization.resolve('resolved reference')
          else serialization.reject('late reference failure')
          await serialization.promise.catch(() => undefined)
          // The shell exposes no settlement promise; this checkpoint drains its queued continuations.
          await setImmediate()
          expect(shell.draftSnapshot).toBe(disposedDraft)
          expect(shell.notices.getSnapshot()).toBeNull()
          expect(write).toHaveBeenCalledTimes(writes)
        }
        expect(sink).not.toHaveBeenCalled()
      } finally {
        shell.dispose()
        serialization.resolve('settled during teardown')
        await serialization.promise.catch(() => undefined)
        await setImmediate()
      }
    },
  )
})

describe('plain-text reference catalogs', () => {
  it('leaves named tokens plain until their own catalog includes them', () => {
    const unavailable = new Map<'/' | '@', readonly string[]>()
    expect(scanTextRefs('', unavailable)).toEqual([])
    expect(scanTextRefs('/plan /plan.md /plan/path /plan。 x/plan @person', unavailable)).toEqual([])
    expect(scanTextRefs('/plan @person', new Map([['/', []]]))).toEqual([])
    expect(scanTextRefs('/plan @person', new Map([['@', ['person']]]))).toEqual([
      { start: 6, end: 13, trigger: '@' },
    ])
    expect(scanTextRefs('/plan @person', new Map([['/', ['plan']]]))).toEqual([
      { start: 0, end: 5, trigger: '/' },
    ])
  })

  it('orders folder and catalog references without overlapping ranges', () => {
    const text = '@src/ /plan @other/ @src/'
    expect(scanTextRefs(text, new Map([['@', ['src']], ['/', ['plan']]]))).toEqual([
      { start: 0, end: 4, trigger: '@' },
      { start: 6, end: 11, trigger: '/' },
      { start: 12, end: 19, trigger: '@' },
      { start: 20, end: 24, trigger: '@' },
    ])
    expect(scanTextRefs('@"some folder/ trailing', new Map())).toEqual([
      { start: 0, end: 14, trigger: '@' },
    ])
  })
})
