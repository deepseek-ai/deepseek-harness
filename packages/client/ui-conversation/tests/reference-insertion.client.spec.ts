// @vitest-environment jsdom
/** Reference insertion from outside the composer follows Session, submission, and disposal state. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlock } from '../src/client/contract/composer-blocks.ts'
import type { ReferenceInsert } from '../src/client/contract/draft-editor.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'

const reference: ReferenceInsert = {
  source: 'reference', ref: '@"/work/a b.md"', label: 'a b.md', appearance: 'file', clipboardText: '@"/work/a b.md"',
}

type SessionGate = Pick<SessionSnapshot, 'removed' | 'subagent'>

function bench(sources: { session?: SessionGate } = {}) {
  const pending = Promise.withResolvers<SubmitOutcome>()
  const sink = vi.fn(() => pending.promise)
  const session = createSnapshotStore<SessionGate>(sources.session ?? { removed: false, subagent: null })
  const block = createSnapshotStore<ComposerBlock | undefined>(undefined)
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
    session,
    composerBlock: () => block,
  })
  onTestFinished(() => { shell.dispose() })
  return { shell, sink, pending, session, block }
}

const child = (mode: 'one-shot' | 'continuable'): SessionGate['subagent'] => ({
  address: { parentSessionId: 'parent' as SessionId, childSessionId: 'child' as SessionId, mode },
})

it('inserts references without attachments and locks while a submission owns the draft', async () => {
  const { shell, pending } = bench()
  const changed = vi.fn()
  const unsubscribe = shell.referenceInsertionAllowed.subscribe(changed)
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(true)
  shell.setDraft('Review')
  expect(shell.addReferences([reference])).toBe(true)
  expect(shell.snapshot.draft).toBe('Review @"/work/a b.md" ')
  expect(shell.snapshot.attachmentIds).toEqual([])
  changed.mockClear()
  shell.submit()
  expect(changed).toHaveBeenCalled()
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  pending.resolve({ kind: 'success' })
  await vi.waitFor(() => { expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(true) })
  unsubscribe()
})

it('follows Session removal, subagent mode, and composer blocks', () => {
  const { shell, session, block } = bench({ session: { removed: true, subagent: null } })
  const changed = vi.fn()
  const unsubscribe = shell.referenceInsertionAllowed.subscribe(changed)
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  expect(shell.snapshot.draft).toBe('')
  session.set({ removed: false, subagent: child('one-shot') })
  expect(changed).toHaveBeenCalledOnce()
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  session.set({ removed: false, subagent: child('continuable') })
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(true)
  block.set({ reason: 'Unavailable' })
  expect(changed).toHaveBeenCalledTimes(3)
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  block.set(undefined)
  expect(shell.addReferences([reference])).toBe(true)
  unsubscribe()
  changed.mockClear()
  session.set({ removed: true, subagent: null })
  block.set({ reason: 'Unavailable' })
  expect(changed).not.toHaveBeenCalled()
})

it('refuses after disposal and permits insertion without Session sources', () => {
  const { shell } = bench()
  shell.dispose()
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  const bare = new SessionInputShell({
    actx: {} as Context,
    defaultSink: async () => ({ kind: 'success' }),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
  })
  onTestFinished(() => { bare.dispose() })
  const unsubscribe = bare.referenceInsertionAllowed.subscribe(() => {})
  expect(bare.referenceInsertionAllowed.getSnapshot()).toBe(true)
  expect(bare.addReferences([reference])).toBe(true)
  unsubscribe()
})
