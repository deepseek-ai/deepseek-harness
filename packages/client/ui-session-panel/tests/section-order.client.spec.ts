// @vitest-environment jsdom
/**
 * The section roster's reader-chosen order: the stored choice applied to the
 * registered sections, a move persisting the order of every live section,
 * and the roster following the ledger, the locale, and the stored choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots/client'
import { SECTION_ORDER_STORAGE_KEY, sectionSource } from '../src/client/sections.ts'

const entry = (id: string, order: number): StoredEntry => ({ component: () => null, options: { id, order, label: id.toUpperCase() } })

/** A context whose section list holds these registrations; `bump` reports a ledger change and `relocalize` a locale change. */
function contextOf(entries: StoredEntry[]) {
  let version = 0
  let revision = 0
  const ledger = new Set<() => void>()
  const locale = new Set<() => void>()
  const ctx = {
    slots: {
      getVersion: () => version,
      entriesOfSlot: () => entries,
      subscribe: (_slot: string, listener: () => void) => {
        ledger.add(listener)
        return () => { ledger.delete(listener) }
      },
    },
    locale: {
      getSnapshot: () => ({ revision }),
      subscribe: (listener: () => void) => {
        locale.add(listener)
        return () => { locale.delete(listener) }
      },
    },
  } as never as Context
  return {
    ctx,
    listeners: () => ledger.size + locale.size,
    bump: (): void => {
      version += 1
      for (const listener of ledger) listener()
    },
    relocalize: (): void => {
      revision += 1
      for (const listener of locale) listener()
    },
  }
}

const REGISTERED = [entry('environment', 0), entry('changes', 100), entry('subagents', 200), entry('jobs', 300)]
const ids = (source: ReturnType<typeof sectionSource>): string[] => source.getSnapshot().map(section => section.id)

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('sectionSource order', () => {
  it('shows the registered order until the reader moves a section, then persists the order of every live section', () => {
    const source = sectionSource(contextOf([...REGISTERED]).ctx)
    expect(ids(source)).toEqual(['environment', 'changes', 'subagents', 'jobs'])
    expect(localStorage.getItem(SECTION_ORDER_STORAGE_KEY)).toBeNull()
    source.move('jobs', 'changes', 'before')
    expect(ids(source)).toEqual(['environment', 'jobs', 'changes', 'subagents'])
    expect(JSON.parse(localStorage.getItem(SECTION_ORDER_STORAGE_KEY) ?? 'null')).toEqual(['environment', 'jobs', 'changes', 'subagents'])
    source.move('jobs', 'subagents', 'after')
    expect(ids(source)).toEqual(['environment', 'changes', 'subagents', 'jobs'])
    source.move('subagents', 'changes', 'before')
    // Another plugin instance, as after a reload, reads the same order.
    expect(ids(sectionSource(contextOf([...REGISTERED]).ctx))).toEqual(['environment', 'subagents', 'changes', 'jobs'])
  })

  it('never moves Environment, and lands a section after it on either side', () => {
    const source = sectionSource(contextOf([...REGISTERED]).ctx)
    const before = source.getSnapshot()
    source.move('environment', 'jobs', 'after')
    expect(source.getSnapshot()).toBe(before)
    expect(localStorage.getItem(SECTION_ORDER_STORAGE_KEY)).toBeNull()
    source.move('jobs', 'environment', 'before')
    expect(ids(source)).toEqual(['environment', 'jobs', 'changes', 'subagents'])
    source.move('subagents', 'environment', 'after')
    expect(ids(source)).toEqual(['environment', 'subagents', 'jobs', 'changes'])
  })

  it('ignores a move onto the same section and a move that names a section that is not live', () => {
    const source = sectionSource(contextOf([...REGISTERED]).ctx)
    const before = source.getSnapshot()
    source.move('jobs', 'jobs', 'before')
    source.move('gone', 'jobs', 'before')
    source.move('jobs', 'gone', 'after')
    expect(source.getSnapshot()).toBe(before)
    expect(localStorage.getItem(SECTION_ORDER_STORAGE_KEY)).toBeNull()
  })

  it('treats a stored value that is not a list as no choice, skips entries that are not strings, and holds Environment first', () => {
    localStorage.setItem(SECTION_ORDER_STORAGE_KEY, '{"jobs":0}')
    expect(ids(sectionSource(contextOf([...REGISTERED]).ctx))).toEqual(['environment', 'changes', 'subagents', 'jobs'])
    localStorage.setItem(SECTION_ORDER_STORAGE_KEY, '["jobs",7,null,"subagents","environment"]')
    expect(ids(sectionSource(contextOf([...REGISTERED]).ctx))).toEqual(['environment', 'changes', 'jobs', 'subagents'])
  })

  it('keeps the snapshot until the ledger, the locale, or the order changes, and notifies subscribers of each', () => {
    const entries = [...REGISTERED]
    const bench = contextOf(entries)
    const source = sectionSource(bench.ctx)
    const listener = vi.fn()
    const off = source.subscribe(listener)
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    source.move('jobs', 'changes', 'before')
    expect(listener).toHaveBeenCalledTimes(1)
    const moved = source.getSnapshot()
    expect(moved).not.toBe(first)
    // A section registered after the choice follows the section it follows in the registered order.
    entries.push(entry('tasks', 250))
    bench.bump()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(ids(source)).toEqual(['environment', 'jobs', 'changes', 'subagents', 'tasks'])
    bench.relocalize()
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    expect(bench.listeners()).toBe(0)
    source.move('tasks', 'jobs', 'before')
    expect(listener).toHaveBeenCalledTimes(3)
    expect(ids(source)).toEqual(['environment', 'tasks', 'jobs', 'changes', 'subagents'])
  })
})
