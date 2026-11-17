// @vitest-environment jsdom
/** Reference insertion from outside the composer follows Session, submission, and disposal state. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ReferenceInsert } from '../src/client/contract/draft-editor.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { sessionDraftEditable } from '../src/client/input/draft-editability.ts'

const reference: ReferenceInsert = {
  source: 'reference', ref: '@"/work/a b.md"', label: 'a b.md', appearance: 'file', clipboardText: '@"/work/a b.md"',
}

function bench(sessionEditable?: ObservableSnapshot<boolean>) {
  const pending = Promise.withResolvers<SubmitOutcome>()
  const sink = vi.fn(() => pending.promise)
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
    ...(sessionEditable === undefined ? {} : { sessionEditable }),
  })
  onTestFinished(() => { shell.dispose() })
  return { shell, sink, pending }
}

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

it('follows the Session policy and refuses after disposal', () => {
  const editable = createSnapshotStore(false)
  const { shell } = bench(editable)
  const changed = vi.fn()
  const unsubscribe = shell.referenceInsertionAllowed.subscribe(changed)
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
  expect(shell.snapshot.draft).toBe('')
  editable.set(true)
  expect(changed).toHaveBeenCalledOnce()
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(true)
  unsubscribe()
  editable.set(false)
  expect(changed).toHaveBeenCalledOnce()
  editable.set(true)
  shell.dispose()
  expect(shell.referenceInsertionAllowed.getSnapshot()).toBe(false)
  expect(shell.addReferences([reference])).toBe(false)
})

it('derives Session editability from removal, subagent mode, and composer blocks', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const id = 'target' as SessionId
  await runtime.sessions.add({ id, summary: { cwd: '/workspace' } })
  const owner = runtime.sessions.retain(id)
  onTestFinished(() => { owner.release() })
  const blocks = new ComposerBlockRegistry()
  const editable = sessionDraftEditable(runtime.sessions.binding(id)!.session, () => blocks.storeFor(id))
  const changed = vi.fn()
  const unsubscribe = editable.subscribe(changed)
  expect(editable.getSnapshot()).toBe(true)
  blocks.set(id, { reason: 'Unavailable' })
  expect(changed).toHaveBeenCalled()
  expect(editable.getSnapshot()).toBe(false)
  blocks.set(id, undefined)
  await runtime.sessions.updateSessionSnapshot(id, (state) => {
    state.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode: 'one-shot' } }
  })
  expect(editable.getSnapshot()).toBe(false)
  await runtime.sessions.updateSessionSnapshot(id, (state) => {
    state.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode: 'continuable' } }
  })
  expect(editable.getSnapshot()).toBe(true)
  await runtime.sessions.updateSessionSnapshot(id, (state) => { state.removed = true })
  expect(editable.getSnapshot()).toBe(false)
  unsubscribe()
  changed.mockClear()
  blocks.set(id, { reason: 'Unavailable' })
  await runtime.sessions.updateSessionSnapshot(id, (state) => { state.removed = false })
  expect(changed).not.toHaveBeenCalled()
})
