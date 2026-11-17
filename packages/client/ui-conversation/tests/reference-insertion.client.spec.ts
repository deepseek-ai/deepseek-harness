// @vitest-environment jsdom
/** Reference insertion from outside the composer follows Session, submission, and disposal state. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerBlock } from '../src/client/contract/composer-blocks.ts'
import type { ReferenceInsert } from '../src/client/contract/draft-editor.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'

const reference: ReferenceInsert = {
  source: 'reference', ref: '@"/work/a b.md"', label: 'a b.md', appearance: 'file', clipboardText: '@"/work/a b.md"',
}

type SessionGate = Pick<SessionSnapshot, 'removed' | 'subagent'>

function bench() {
  const pending = Promise.withResolvers<SubmitOutcome>()
  const sink = vi.fn(() => pending.promise)
  const sources: { session: SessionGate; block: ComposerBlock | undefined } = {
    session: { removed: false, subagent: null }, block: undefined,
  }
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
    session: () => sources.session,
    composerBlock: () => sources.block,
  })
  onTestFinished(() => { shell.dispose() })
  return { shell, sink, pending, sources }
}

const child = (mode: 'one-shot' | 'continuable'): SessionGate['subagent'] => ({
  address: { parentSessionId: 'parent' as SessionId, childSessionId: 'child' as SessionId, mode },
})

it('inserts references without attachments and refuses while a submission owns the draft', async () => {
  const { shell, pending } = bench()
  expect(shell.canInsertReferences()).toBe(true)
  shell.setDraft('Review')
  expect(shell.addReferences([reference])).toBe(true)
  expect(shell.snapshot.draft).toBe('Review @"/work/a b.md" ')
  expect(shell.snapshot.attachmentIds).toEqual([])
  shell.submit()
  expect(shell.canInsertReferences()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  pending.resolve({ kind: 'success' })
  await vi.waitFor(() => { expect(shell.canInsertReferences()).toBe(true) })
})

it('reads Session removal, subagent mode, and composer blocks at each call', () => {
  const { shell, sources } = bench()
  sources.session = { removed: true, subagent: null }
  expect(shell.canInsertReferences()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  expect(shell.snapshot.draft).toBe('')
  sources.session = { removed: false, subagent: child('one-shot') }
  expect(shell.canInsertReferences()).toBe(false)
  sources.session = { removed: false, subagent: child('continuable') }
  expect(shell.canInsertReferences()).toBe(true)
  sources.block = { reason: 'Unavailable' }
  expect(shell.canInsertReferences()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  sources.block = undefined
  expect(shell.addReferences([reference])).toBe(true)
})

it('refuses after disposal and permits insertion without Session sources', () => {
  const { shell } = bench()
  shell.dispose()
  expect(shell.canInsertReferences()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  const bare = new SessionInputShell({
    actx: {} as Context,
    defaultSink: async () => ({ kind: 'success' }),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
  })
  onTestFinished(() => { bare.dispose() })
  expect(bare.canInsertReferences()).toBe(true)
  expect(bare.addReferences([reference])).toBe(true)
})
