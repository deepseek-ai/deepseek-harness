/**
 * The store's write set: pages keyed by their first line, invalidated by a newer
 * file version; a view that survives a reset; one bucket per tab, dropped on
 * `forget` so a closed tab leaves nothing behind.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { createTextStore, fresh } from '../src/client/store.ts'
import { page } from './fixtures.client.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const TAB_1 = 'tab-1' as TabId
const TAB_2 = 'tab-2' as TabId
const TAB_9 = 'tab-9' as TabId

function pageValue(offset: number, lines: readonly string[], eof: boolean, version = 'v1') {
  const result = page(offset, lines, eof, version)
  if (!result.ok) throw new Error('fixture')
  return result.value
}

describe('text store', () => {
  it('clears an explicit implementation choice to resume automatic selection', () => {
    const instance = createTextStore().create()
    instance.actions.selected(TAB_1, 'custom')
    expect(instance.getSnapshot().byTab[TAB_1]?.rendererId).toBe('custom')
    instance.actions.selected(TAB_1, undefined)
    expect(instance.getSnapshot().byTab[TAB_1]?.rendererId).toBeUndefined()
  })

  it('starts empty and mints a bucket on the first write', () => {
    const instance = createTextStore().create()
    expect(instance.getSnapshot().byTab).toEqual({})
    instance.actions.loading(TAB_1)
    expect(instance.getSnapshot().byTab[TAB_1]).toEqual({ ...fresh(), loading: true })
  })

  it('keeps pages by their first line and reports the end of the file', () => {
    const instance = createTextStore().create()
    instance.actions.loading(TAB_1)
    instance.actions.page(TAB_1, pageValue(1, ['a', 'b'], false))
    instance.actions.page(TAB_1, pageValue(3, ['c'], true))
    const state = instance.getSnapshot().byTab[TAB_1]
    expect(state?.pages).toEqual({ 1: { text: 'a\nb', lines: 2 }, 3: { text: 'c', lines: 1 } })
    expect(state?.version).toBe('v1')
    expect(state?.eof).toBe(true)
    expect(state?.loading).toBe(false)
  })

  it('drops the pages of an older version when a newer page arrives', () => {
    const instance = createTextStore().create()
    instance.actions.page(TAB_1, pageValue(1, ['a'], false))
    instance.actions.page(TAB_1, pageValue(2, ['B'], true, 'v2'))
    expect(instance.getSnapshot().byTab[TAB_1]?.pages).toEqual({ 2: { text: 'B', lines: 1 } })
    expect(instance.getSnapshot().byTab[TAB_1]?.version).toBe('v2')
  })

  it('records a failure beside the pages already held, and the next page clears it', () => {
    const instance = createTextStore().create()
    instance.actions.page(TAB_1, pageValue(1, ['a'], false))
    const failure = { code: 'workspace-file/too-large', message: 'x', details: {} } as unknown as RemoteFailure
    instance.actions.failed(TAB_1, failure)
    expect(instance.getSnapshot().byTab[TAB_1]?.failure).toBe(failure)
    expect(instance.getSnapshot().byTab[TAB_1]?.pages).toEqual({ 1: { text: 'a', lines: 1 } })
    instance.actions.page(TAB_1, pageValue(2, ['b'], true))
    expect(instance.getSnapshot().byTab[TAB_1]?.failure).toBeUndefined()
  })

  it('resets the pages but keeps the view', () => {
    const instance = createTextStore().create()
    instance.actions.page(TAB_1, pageValue(1, ['a'], true))
    instance.actions.scrolled(TAB_1, 120)
    instance.actions.toggledWrap(TAB_1)
    instance.actions.navigated(TAB_1, 3)
    instance.actions.reset(TAB_1)
    expect(instance.getSnapshot().byTab[TAB_1]).toEqual({
      ...fresh(), scrollTop: 120, wrap: false, revision: 3,
    })
  })

  it('forgets one tab and keeps the rest', () => {
    const instance = createTextStore().create()
    instance.actions.toggledWrap(TAB_1)
    instance.actions.toggledWrap(TAB_2)
    instance.actions.forget(TAB_1)
    expect(Object.keys(instance.getSnapshot().byTab)).toEqual([TAB_2])
    // Forgetting an unknown tab is a no-op, not a fault: the abort listener may
    // fire for a tab that never wrote anything.
    instance.actions.forget(TAB_9)
    expect(Object.keys(instance.getSnapshot().byTab)).toEqual([TAB_2])
  })
})
describe('read observation baseline', () => {
  it('retains the first observation across overlapping reads and resets it only for a new generation', () => {
    const instance = createTextStore().create()
    instance.actions.loading(TAB_1, 'text-pages', 'observed-1')
    instance.actions.loading(TAB_1, 'text-pages', 'observed-2')
    expect(instance.getSnapshot().byTab[TAB_1]?.observedVersion).toBe('observed-1')
    instance.actions.page(TAB_1, pageValue(1, ['first'], false))
    instance.actions.loading(TAB_1, 'text-pages', 'observed-3')
    expect(instance.getSnapshot().byTab[TAB_1]?.observedVersion).toBe('observed-1')
    instance.actions.reset(TAB_1)
    instance.actions.loading(TAB_1, 'text-pages', 'observed-3')
    expect(instance.getSnapshot().byTab[TAB_1]?.observedVersion).toBe('observed-3')
  })
})
