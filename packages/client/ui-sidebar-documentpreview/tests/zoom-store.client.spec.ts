/** Shared image zoom preferences remain isolated by tab identity. */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createZoomStore, DEFAULT_ZOOM } from '../src/client/zoom/store.ts'

describe('document zoom store', () => {
  it('retains fixed and fit-width preferences and forgets only the closed tab', () => {
    const instance = createZoomStore().create()
    const one = 'one' as TabId
    const two = 'two' as TabId
    instance.actions.zoom(one, { kind: 'fixed', scale: 1.5 })
    instance.actions.zoom(two, DEFAULT_ZOOM)
    expect(instance.getSnapshot().byTab).toEqual({
      one: { kind: 'fixed', scale: 1.5 }, two: { kind: 'fit-width' },
    })
    instance.actions.forget(one)
    expect(instance.getSnapshot().byTab).toEqual({ two: { kind: 'fit-width' } })
  })
})
