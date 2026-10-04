// @vitest-environment jsdom
/** InputHub restores drafts before views and follows Session-owned lexicon subscriptions. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { $nodesOfType } from 'lexical'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DraftSnapshot } from '../src/client/contract/draft-editor.ts'
import type { InputTriggerController } from '../src/client/contract/input.ts'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { TextRefNode } from '../src/client/input/editor/text-ref.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { zh } from '../src/client/locales.ts'

const mention = '@src/main.ts'
const saved: DraftSnapshot = {
  text: `/saved ${mention}`,
  references: [{
    source: 'reference', ref: mention, label: 'main.ts', appearance: 'file', clipboardText: mention,
    offset: '/saved '.length, length: mention.length,
  }],
}

async function storedSession(draft: unknown) {
  const id = SessionId(`draft-hub-${randomUUID()}`)
  const key = `dsh.conversation.${id}`
  const previous = localStorage.getItem(key)
  onTestFinished(() => {
    if (previous === null) localStorage.removeItem(key)
    else localStorage.setItem(key, previous)
  })
  const raw = JSON.stringify({ draft, view: 'trajectory', viewRequest: null })
  localStorage.setItem(key, raw)
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  await sessions.add({ id })
  const reference = sessions.retain(id)
  onTestFinished(() => { reference.release() })
  await reference.ready
  const binding = reference.binding
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  return { ctx, sessions, id, key, raw, reference, binding, hub }
}

async function fixture(draft: unknown) {
  const b = await storedSession(draft)
  return { ...b, shell: b.hub.shellFor(b.binding) }
}

function textReferences(shell: SessionInputShell): string[] {
  return shell.editor.getEditorState().read(() => $nodesOfType(TextRefNode).map(node => node.getTextContent()))
}

function catalog(initial: readonly string[]) {
  const store = createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map([['/', initial]]))
  const listeners = new Set<() => void>()
  let subscriptions = 0
  let releases = 0
  const source: InputTriggerController['lexicon'] = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => {
      subscriptions++
      listeners.add(listener)
      const stop = store.subscribe(listener)
      return () => {
        releases++
        listeners.delete(listener)
        stop()
      }
    },
  }
  return {
    source,
    set: (names: readonly string[]) => { store.set(new Map([['/', names]])) },
    get subscribers() { return listeners.size },
    get subscriptions() { return subscriptions },
    get releases() { return releases },
  }
}

function controller(lexicon: () => InputTriggerController['lexicon']): InputTriggerController {
  return {
    get lexicon() { return lexicon() },
    launcher: createSnapshotStore<string | null>(null),
    track: () => {},
    arbitrate: () => 'pass',
    onSpace: () => false,
    serializeReference: (_source, ref) => Promise.resolve(ref),
    adjudicate: () => Promise.resolve(undefined),
    openReference: () => false,
    toggleSource: () => {},
  }
}

class TriggerProvider extends Service {
  constructor(ctx: Context, private readonly config: {
    readonly controller: InputTriggerController
    readonly initialize?: () => void
  }) {
    super(ctx, 'inputTriggers')
  }

  sessionOf(): InputTriggerController {
    this.config.initialize?.()
    return this.config.controller
  }
}

it('leaves trigger subscription to lifecycle activation rather than construction or draft writes', async () => {
  const b = await storedSession(saved)
  const source = catalog(['saved'])
  const triggers = controller(() => source.source)
  const resolve = vi.fn(() => triggers)
  const shell = new SessionInputShell({
    actx: b.binding.ctx,
    inputTriggers: resolve,
    defaultSink: () => Promise.resolve({ kind: 'success' }),
    commandAttachments: {
      serialize: () => Promise.resolve([]),
      release: () => {},
      unsupportedNotice: token => token,
    },
  })
  onTestFinished(() => { shell.dispose() })

  expect(resolve).not.toHaveBeenCalled()
  shell.setDraft(saved)
  expect(source.subscribers).toBe(0)
  expect(shell.draftSnapshot).toEqual(saved)
  shell.refreshLexiconSubscription()
  expect(source.subscribers).toBe(1)
  expect(shell.draftSnapshot).toEqual(saved)
})

it('reuses one shell during synchronous catalog retention and restores its initial draft before returning', async () => {
  const b = await storedSession(saved)
  const source = catalog(['saved'])
  const retained: SessionReference[] = []
  onTestFinished(() => { for (const reference of retained) reference.release() })
  const reentered: SessionInputShell[] = []
  let warming = false
  let initialized = false
  let observed = false
  const stop = b.sessions.retainInfo(b.id).subscribe(() => {
    // One reentry exposes duplicate shells without exhausting the stack on a regression.
    if (!warming || observed) return
    observed = true
    reentered.push(b.hub.shellFor(b.binding))
  })
  onTestFinished(stop)
  const provider = b.ctx.plugin(TriggerProvider, {
    controller: controller(() => source.source),
    initialize: () => {
      if (initialized) return
      initialized = true
      warming = true
      try {
        retained.push(b.sessions.retain(b.id))
      } finally { warming = false }
    },
  })
  await provider.await()

  const first = b.hub.shellFor(b.binding)
  const initial = first.draftSnapshot
  expect(initial).toEqual(saved)
  expect(first.editor.getEditorState().read(() => $nodesOfType(ReferenceChipNode).length)).toBe(1)
  await vi.waitFor(() => {
    expect(observed).toBe(true)
    expect(source.subscribers).toBe(1)
  })
  expect(reentered).toHaveLength(1)
  expect(retained).toHaveLength(1)
  expect(retained[0]?.binding).toBe(b.binding)
  expect(new Set([first, ...reentered, b.hub.shellFor(b.binding)]).size).toBe(1)
  expect(source.subscribers).toBe(1)
  expect(first.draftSnapshot).toBe(initial)
  expect(reentered[0]?.draftSnapshot).toBe(first.draftSnapshot)
  expect(first.editor.getEditorState().read(() => $nodesOfType(ReferenceChipNode).length)).toBe(1)
  expect(localStorage.getItem(b.key)).toBe(b.raw)
})

it('restores legacy text before a view and reuses the live draft on later shell lookups', async () => {
  const b = await fixture('/saved legacy\n🙂 中文')
  expect(b.shell.draftSnapshot).toEqual({ text: '/saved legacy\n🙂 中文', references: [] })
  expect(textReferences(b.shell)).toEqual([])
  expect(localStorage.getItem(b.key)).toBe(b.raw)
  b.shell.setDraft('edited before mounting a view')
  expect(b.hub.shellFor(b.binding)).toBe(b.shell)
  expect(b.hub.for(b.binding.ctx)).toBe(b.shell)
  expect(b.shell.draftSnapshot).toEqual({ text: 'edited before mounting a view', references: [] })
  expect(localStorage.getItem(b.key)).toBe(b.raw)
})

it('imports reference chips on the first Hub shell and preserves them without an explicit clear', async () => {
  const b = await fixture(saved)
  expect(b.shell.draftSnapshot).toEqual(saved)
  expect(textReferences(b.shell)).toEqual([])
  expect(b.shell.editor.getEditorState().read(() => $nodesOfType(ReferenceChipNode).length)).toBe(1)
  expect(b.hub.requestDraftInitialization(b.binding, { prompt: 'new text' })).toBe('preserved')
  expect(b.shell.draftSnapshot).toEqual(saved)
  expect(b.hub.requestDraftInitialization(b.binding, { clearPreviousDraft: true })).toBe('applied')
  expect(b.hub.shellFor(b.binding).draftSnapshot).toEqual({ text: '', references: [] })
})

it('subscribes when a provider arrives and disconnects each withdrawn provider', async () => {
  const b = await fixture(saved)
  expect(b.shell.actions.insertText('/current', {
    start: 0, end: '/saved'.length, draftRev: b.shell.snapshot.draftRev,
  })).toBe(true)
  const current = b.shell.draftSnapshot
  expect(textReferences(b.shell)).toEqual([])
  const first = catalog([])
  const firstProvider = b.ctx.plugin(TriggerProvider, { controller: controller(() => first.source) })
  await firstProvider.await()
  await vi.waitFor(() => {
    expect(first.subscribers).toBe(1)
    expect(textReferences(b.shell)).toEqual([])
  })
  expect(b.shell.draftSnapshot).toBe(current)
  first.set(['current'])
  await vi.waitFor(() => { expect(textReferences(b.shell)).toEqual(['/current']) })
  await firstProvider.dispose()
  await vi.waitFor(() => {
    expect(first.subscribers).toBe(0)
    expect(textReferences(b.shell)).toEqual([])
  })
  expect(first.releases).toBe(first.subscriptions)
  expect(b.sessions.binding(b.id)).toBe(b.binding)
  expect(b.hub.shellFor(b.binding)).toBe(b.shell)
  const second = catalog(['saved'])
  const secondProvider = b.ctx.plugin(TriggerProvider, { controller: controller(() => second.source) })
  await secondProvider.await()
  await vi.waitFor(() => {
    expect(second.subscribers).toBe(1)
    expect(textReferences(b.shell)).toEqual([])
  })
  first.set(['current'])
  expect(first.subscribers).toBe(0)
  expect(b.shell.draftSnapshot).toBe(current)
  second.set(['current'])
  await vi.waitFor(() => { expect(textReferences(b.shell)).toEqual(['/current']) })
  await secondProvider.dispose()
  await vi.waitFor(() => {
    expect(second.subscribers).toBe(0)
    expect(textReferences(b.shell)).toEqual([])
  })
  expect(second.releases).toBe(second.subscriptions)
  expect(b.shell.draftSnapshot).toBe(current)
  expect(b.sessions.binding(b.id)).toBe(b.binding)
  expect(b.shell.requestDraftInitialization({})).toBe('preserved')
})

it('reconnects a replacement lexicon source on an explicit subscription refresh', async () => {
  const b = await fixture(saved)
  const first = catalog(['saved'])
  const second = catalog([])
  let current = first.source
  const provider = b.ctx.plugin(TriggerProvider, { controller: controller(() => current) })
  await provider.await()
  await vi.waitFor(() => { expect(first.subscribers).toBe(1) })
  const draft = b.shell.draftSnapshot
  const subscriptions = first.subscriptions
  b.shell.refreshLexiconSubscription()
  b.shell.refreshLexiconSubscription()
  expect(first.subscriptions).toBe(subscriptions)
  expect(first.releases).toBe(0)
  current = second.source
  b.shell.refreshLexiconSubscription()
  await vi.waitFor(() => {
    expect(first.subscribers).toBe(0)
    expect(second.subscribers).toBe(1)
    expect(textReferences(b.shell)).toEqual([])
  })
  expect(first.releases).toBe(first.subscriptions)
  second.set(['saved'])
  await vi.waitFor(() => { expect(textReferences(b.shell)).toEqual(['/saved']) })
  expect(b.shell.draftSnapshot).toBe(draft)
  expect(draft.references).toEqual(saved.references)
})

it('unsubscribes the lexicon and refuses the old binding after Session disposal', async () => {
  const b = await fixture(saved)
  const source = catalog(['saved'])
  const provider = b.ctx.plugin(TriggerProvider, { controller: controller(() => source.source) })
  await provider.await()
  await vi.waitFor(() => { expect(source.subscribers).toBe(1) })
  b.reference.release()
  await b.sessions.disposeScopes()
  expect(source.subscribers).toBe(0)
  expect(source.releases).toBe(source.subscriptions)
  const draft = b.shell.draftSnapshot
  b.shell.refreshLexiconSubscription()
  source.set([])
  expect(source.subscribers).toBe(0)
  expect(source.releases).toBe(source.subscriptions)
  expect(b.shell.draftSnapshot).toBe(draft)
  expect(b.shell.requestDraftInitialization({ prompt: 'late edit', clearPreviousDraft: true })).toBe('blocked')
  expect(() => b.hub.requestDraftInitialization(b.binding, { prompt: 'late edit' })).toThrow('retained Session binding')
})
