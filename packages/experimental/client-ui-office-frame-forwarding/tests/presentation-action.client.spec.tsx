// @vitest-environment jsdom
/** The toolbar action follows the presentation registered for its own tab. */
import { fireEvent, render, screen } from '@testing-library/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { expect, test, vi } from 'vitest'
import { PresentationAction, type PresentationActionProps } from '../src/client/PresentationAction.tsx'
import { createPresentationStore } from '../src/client/presentation-store.ts'
import { en } from '../src/client/locales.ts'

test('only a mounted presentation exposes playback, and disabled actions cannot start it', () => {
  const store = createPresentationStore().create(), id = brandString<TabId>('presentation'), other = brandString<TabId>('other')
  const play = vi.fn(), otherPlay = vi.fn()
  const props = {
    useTabInfo: () => ({ tab: { id } }),
    useStore: selector => selector(store.getSnapshot()),
    t: key => en[key as keyof typeof en],
  } as PresentationActionProps
  const view = render(<PresentationAction {...props} />)
  try {
    expect(screen.queryByRole('button')).toBeNull()
    store.actions.present(other, { disabled: false, play: otherPlay })
    view.rerender(<PresentationAction {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
    store.actions.present(id, { disabled: true, play })
    view.rerender(<PresentationAction {...props} />)
    const button = screen.getByRole('button', { name: en.play })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(play).not.toHaveBeenCalled()
    store.actions.present(id, { disabled: false, play })
    view.rerender(<PresentationAction {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.play }))
    expect(play).toHaveBeenCalledOnce()
    expect(otherPlay).not.toHaveBeenCalled()
    store.actions.retire(id, play)
    view.rerender(<PresentationAction {...props} />)
    expect(screen.queryByRole('button')).toBeNull()
  } finally { view.unmount() }
})
