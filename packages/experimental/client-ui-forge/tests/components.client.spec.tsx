// @vitest-environment jsdom
/** Attention indicator, refresh glyph, changes tab title, and action toast rendering. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import toastCss from '@deepseek-ai/dsh-client-ui-primitives/src/client/Toast.module.css'
import type { PaneId, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActionToast } from '../src/client/ActionToast.tsx'
import { changesAddress } from '../src/client/changes-address.ts'
import { ChangesTabTitle } from '../src/client/ChangesTabTitle.tsx'
import { AttentionIndicator, type AttentionIndicatorProps } from '../src/client/AttentionIndicator.tsx'
import { en } from '../src/client/locales.ts'
import { RefreshGlyph } from '../src/client/RefreshGlyph.tsx'
import { createNoticeSource, type PanelSnapshot } from '../src/client/source.ts'
import type { ForgePanelState } from '../src/types.ts'
import { entry, ready, snapshot } from './client-fixtures.client.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)

/**
 * Fire an animation event under the name React DOM listens for here: jsdom
 * has no `AnimationEvent` but declares `WebkitAnimation`, so React DOM uses the WebKit-prefixed names.
 */
function animation(element: Element, phase: 'Start' | 'Iteration'): void {
  fireEvent(element, new Event(`webkitAnimation${phase}`, { bubbles: true }))
}

describe('RefreshGlyph', () => {
  it('turns while busy and finishes the turn under way once busy ends', () => {
    const view = render(<RefreshGlyph busy={false} size={14} />)
    const glyph = view.container.firstElementChild as HTMLElement
    expect(glyph.hasAttribute('data-turning')).toBe(false)
    view.rerender(<RefreshGlyph busy size={14} />)
    animation(glyph, 'Start')
    animation(glyph, 'Iteration')
    expect(glyph.hasAttribute('data-turning')).toBe(true)
    view.rerender(<RefreshGlyph busy={false} size={14} />)
    expect(glyph.hasAttribute('data-turning')).toBe(true)
    animation(glyph, 'Iteration')
    expect(glyph.hasAttribute('data-turning')).toBe(false)
  })
})

describe('AttentionIndicator', () => {
  function indicator(state: ForgePanelState | null) {
    const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
    const props = { usePanel: bindSnapshotSelector(panel), t } as
      Pick<AttentionIndicatorProps, 'usePanel' | 't'> as AttentionIndicatorProps
    const view = render(<AttentionIndicator {...props} />)
    return { panel, view }
  }

  it.each([
    ['before the first state', null],
    ['without change requests', ready()],
    ['while every change request is fine', ready({ changeRequests: [entry(1, snapshot(1))] })],
  ])('renders nothing %s', (_label, state) => {
    expect(indicator(state).view.container.innerHTML).toBe('')
  })

  it('marks change requests that need attention and names the mark', () => {
    const b = indicator(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2, { checksRollup: 'failure' }))] }))
    const mark = b.view.container.querySelector('[data-forge-attention]')
    expect(mark?.textContent).toBe(en['header.attention'])
    act(() => { b.panel.set({ state: ready({ changeRequests: [entry(1, snapshot(1))] }), disconnected: false }) })
    expect(b.view.container.innerHTML).toBe('')
  })
})

describe('ChangesTabTitle', () => {
  const unused = (): never => { throw new Error('the title does not call tab actions') }

  function title(contentId: string) {
    const info: SidebarRightTabInfo = {
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' as PaneId, isFloating: false },
      tab: {
        id: 'tab-1' as TabId, kind: 'forge-changes', contentId, title: 'Captured', visible: true,
        navigation: { address: contentId, params: undefined, revision: 1 },
        signal: new AbortController().signal,
        actions: { bindCommands: () => () => {}, openResource: unused, openTab: unused, close: unused },
      },
    }
    return render(<ChangesTabTitle useTabInfo={() => info} t={t} />)
  }

  it('names the view from its address in the current language', () => {
    const view = title(changesAddress({ sessionId: brandString<SessionId>('s1'), source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7' } }))
    expect(view.container.textContent).toBe('Changes in #7')
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('keeps the captured title of an address it did not mint', () => {
    expect(title('dsh-resource://forge-changes/s1/remote').container.textContent).toBe('Captured')
  })
})

describe('ActionToast', () => {
  function toast() {
    vi.useFakeTimers()
    const notices = createNoticeSource()
    const dismiss = vi.fn(notices.dismiss)
    const view = render(<ActionToast useNotice={bindSnapshotSelector(notices.hooks.notice)} dismiss={dismiss} t={t} />)
    return { notices, dismiss, view }
  }

  it('renders nothing without a notice', () => {
    const b = toast()
    expect(b.view.container.innerHTML).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('warns about a failure until it fades', () => {
    const b = toast()
    act(() => { b.notices.report('toast.refreshFailed') })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(en['toast.refreshFailed'])
    expect(alert.querySelector(`.${toastCss.icon}`)).not.toBeNull()
    expect(alert.querySelector(`.${toastCss.success}`)).toBeNull()
    expect(within(alert).queryByRole('button')).toBeNull()

    act(() => { vi.advanceTimersByTime(3999) })
    expect(b.dismiss).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(b.dismiss).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('confirms a success with its values', () => {
    const b = toast()
    act(() => { b.notices.report('toast.removed', { tone: 'success', params: { name: '#7' } }) })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Removed #7 from this Session')
    expect(alert.querySelector(`.${toastCss.success}`)).not.toBeNull()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('holds an undoable notice longer and dismisses it before undoing', () => {
    const b = toast()
    const order: string[] = []
    b.dismiss.mockImplementation(() => {
      order.push('dismiss')
      b.notices.dismiss()
    })
    act(() => { b.notices.report('toast.removed', { tone: 'success', params: { name: '#7' }, undo: () => { order.push('undo') } }) })
    act(() => { vi.advanceTimersByTime(6999) })
    expect(order).toEqual([])

    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: en['toast.undo'] }))
    expect(order).toEqual(['dismiss', 'undo'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('fades an undoable notice nobody acts on without undoing', () => {
    const b = toast()
    const undo = vi.fn()
    act(() => { b.notices.report('toast.removed', { tone: 'success', params: { name: '#7' }, undo }) })
    act(() => { vi.advanceTimersByTime(7000) })
    expect(b.dismiss).toHaveBeenCalledOnce()
    expect(undo).not.toHaveBeenCalled()
  })

  it('restarts the hold for a repeated notice', () => {
    const b = toast()
    act(() => { b.notices.report('toast.copyFailed') })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { b.notices.report('toast.copyFailed') })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('alert').textContent).toBe(en['toast.copyFailed'])
    act(() => { vi.advanceTimersByTime(1000) })
    expect(b.dismiss).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
