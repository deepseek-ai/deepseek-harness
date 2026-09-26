import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserNavigation } from '../src/client/browser/BrowserNavigation.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'

const TAB = 'browser-tab' as TabId

describe('Browser persistence store', () => {
  it('replaces snapshots and forgets only the closed tab', () => {
    const store = createBrowserStore().create()
    const first = new BrowserNavigation()
    first.navigate({ kind: 'https', url: 'https://example.test/', title: 'example.test' })
    store.actions.replace(TAB, first.snapshot)
    const other = 'other-tab' as TabId
    store.actions.replace(other, BrowserNavigation.empty())
    expect(BrowserNavigation.current(store.getSnapshot().byTab[TAB])?.url).toBe('https://example.test/')
    store.actions.forget(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(store.getSnapshot().byTab[other]).toBeDefined()
  })
})
