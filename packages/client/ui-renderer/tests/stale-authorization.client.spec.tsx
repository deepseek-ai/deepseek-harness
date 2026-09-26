// @vitest-environment jsdom
/**
 * A retained render binding dies with its entry. Re-registering the same key
 * creates a new binding rather than reviving the stale closure.
 */
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  StaleAuthorizationError, type SlotEntryDef, type SlotSpec, type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RenderOpts, SlotRendererHost, SlotScopeAdapter, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

type RenderSlotFn = (key: string, owner: object, opts?: RenderOpts) => ReactNode
type DeclaredSpec = SlotSpec<SlotEntryDef>

/** Ledger-shaped fake: add/dispose maintain the live set the way the runtime ledger does. */
function makeHost() {
  const entries = new Map<string, StoredEntry[]>()
  const versions = new Map<string, number>()
  const subs = new Map<string, Set<() => void>>()
  const live = new Set<StoredEntry>()
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const bindingSource = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const sessionAdapter: SlotScopeAdapter = {
    current: bindingSource,
    bindingSource: () => bindingSource,
  }
  const bump = (key: string) => {
    versions.set(key, (versions.get(key) ?? 0) + 1)
    for (const fn of [...(subs.get(key) ?? [])]) fn()
  }
  const host: SlotRendererHost = {
    subscribe: (key, fn) => {
      const set = subs.get(key) ?? new Set()
      set.add(fn)
      subs.set(key, set)
      return () => { set.delete(fn) }
    },
    getVersion: key => versions.get(key) ?? 0,
    entriesOf: key => entries.get(key) ?? [],
    // Single-kind everywhere and no crashes in this suite: the projection is
    // the raw view and crash reports never fire.
    entriesOfSlot: key => entries.get(key) ?? [],
    reportEntryError: () => {},
    reportFactoryError: () => {},
    specOf: () => ({ kind: 'single', scope: 'root' }),
    isLive: entry => live.has(entry),
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: () => () => {},
    getFactoryVersion: () => 0,
    factoryOf: () => undefined,
    isFactoryLive: () => false,
    root: bindingSource,
    scopeRevision: { getSnapshot: () => 0, subscribe: () => () => {} },
    scope: () => sessionAdapter,
  }
  return {
    host,
    add: (key: string, entry: StoredEntry) => {
      entries.set(key, [...(entries.get(key) ?? []), entry])
      live.add(entry)
      bump(key)
      return () => {
        entries.set(key, (entries.get(key) ?? []).filter(e => e !== entry))
        live.delete(entry)
        bump(key)
      }
    },
  }
}

const CHILD: DeclaredSpec = { kind: 'single', scope: 'root' }

/**
 * Mount a root entry that leaks its binding to the test, then render. The
 * returned dispose unmounts the view FIRST: an empty 'root' makes the live
 * root outlet rethrow its boot-order failure (fail-loud, covered in the
 * scoped-slots suite); the retained-closure scenario under test here is a
 * dead entry whose binding outlives the tree.
 */
function mountCapturing(h: ReturnType<typeof makeHost>) {
  let captured: RenderSlotFn | undefined
  const entry: StoredEntry = {
    component: (props: { renderSlot: RenderSlotFn }) => {
      captured = props.renderSlot
      return null
    },
    options: {},
    children: { 'k.child': CHILD },
  }
  const disposeEntry = h.add('root', entry)
  const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
  return {
    binding: captured!,
    entry,
    dispose: () => {
      view.unmount()
      disposeEntry()
    },
  }
}

describe('stale authorization', () => {
  it('a live binding renders; the same closure throws after its entry is disposed', () => {
    const h = makeHost()
    const { binding, dispose } = mountCapturing(h)
    expect(binding('k.child', {})).not.toBeUndefined()   // live: returns an element
    act(() => { dispose() })
    expect(() => binding('k.child', {})).toThrow(StaleAuthorizationError)
    expect(() => binding('k.child', {})).toThrow(/disposed registration/)
  })

  it('stale check precedes the ownership check: a dead binding throws stale even for undeclared keys', () => {
    const h = makeHost()
    const { binding, dispose } = mountCapturing(h)
    act(() => { dispose() })
    // Were ownership checked first this would be SlotOwnershipError; the dead
    // entry must fail on liveness regardless of the key asked for.
    expect(() => binding('k.undeclared', {})).toThrow(StaleAuthorizationError)
  })

  it('HMR reload (same key, new entry) mints a fresh binding; the old one stays dead', () => {
    const h = makeHost()
    const first = mountCapturing(h)
    act(() => { first.dispose() })

    // Reload: a new entry object for the same slot key (new registration identity).
    let secondBinding: RenderSlotFn | undefined
    const secondEntry: StoredEntry = {
      component: (props: { renderSlot: RenderSlotFn }) => {
        secondBinding = props.renderSlot
        return null
      },
      options: {},
      children: { 'k.child': CHILD },
    }
    h.add('root', secondEntry)
    render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)

    expect(secondBinding).toBeDefined()
    expect(secondBinding).not.toBe(first.binding)          // new identity, no revival
    expect(secondBinding!('k.child', {})).not.toBeUndefined()   // new binding is live
    expect(() => first.binding('k.child', {})).toThrow(StaleAuthorizationError)   // old stays dead
  })
})
