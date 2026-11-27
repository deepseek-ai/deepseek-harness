/** A retired Office view cannot remove the replacement header command or another tab's action. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { expect, test } from 'vitest'
import { createPresentationStore } from '../src/client/presentation-store.ts'

test('header commands remain scoped to the current mounted view of each tab', () => {
  const store = createPresentationStore().create()
  const first = brandString<TabId>('first'), second = brandString<TabId>('second')
  const old = { disabled: false, play: () => {} }, current = { disabled: true, play: () => {} }
  store.actions.present(first, old)
  store.actions.present(second, old)
  store.actions.present(first, current)
  store.actions.retire(first, old.play)
  expect(store.getSnapshot().byTab[first]).toEqual(current)
  store.actions.retire(second, old.play)
  expect(store.getSnapshot().byTab[second]).toBeUndefined()
  store.actions.retire(first, current.play)
  expect(store.getSnapshot().byTab).toEqual({})
})
