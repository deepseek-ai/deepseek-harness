// @vitest-environment jsdom
/** Session header entry, forge and changes tab titles, and action toast rendering. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import toastCss from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.module.css'
import type { PaneId, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActionToast } from '../src/client/ActionToast.tsx'
import { changesAddress } from '../src/client/changes-address.ts'
import { ChangesTabTitle } from '../src/client/ChangesTabTitle.tsx'
import { ForgeTabTitle } from '../src/client/ForgeTabTitle.tsx'
import { HeaderButton } from '../src/client/HeaderButton.tsx'
import { en } from '../src/client/locales.ts'
import { createNoticeSource, type PanelSnapshot } from '../src/client/source.ts'
import type { ForgePanelState } from '../src/types.ts'
import { entry, ready, snapshot } from './client-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)

describe('HeaderButton', () => {
  function header(state: ForgePanelState | null, visible = false) {
    const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
    const visibility = createSnapshotStore<boolean>(visible)
    const toggle = vi.fn<(visible: boolean) => void>()
    const view = render(
      <HeaderButton usePanel={bindSnapshotSelector(panel)} useVisible={bindSnapshotSelector(visibility)} toggle={toggle} t={t} />,
    )
    return { panel, visibility, toggle, view, button: () => view.container.querySelector('[data-forge-header]') }
  }

  it.each([
    ['before the first state', null],
    ['outside a Git checkout', ready({ checkout: { state: 'none' } })],
    ['while the first inspection of an unknown repository runs', ready({ checkout: { state: 'pending' }, repository: null })],
  ])('stays hidden %s', (_label, state) => {
    expect(header(state).view.container.innerHTML).toBe('')
  })

  it.each([
    ['a ready checkout', ready()],
    ['a failed inspection', ready({ checkout: { state: 'failed', message: 'boom' } })],
    ['a repeated inspection of a known repository', ready({ checkout: { state: 'pending' } })],
    ['bound change requests outside a Git checkout', ready({ checkout: { state: 'none' }, changeRequests: [entry(1, snapshot(1))] })],
  ])('opens the hidden tab for %s', (_label, state) => {
    const b = header(state)
    const button = b.view.getByRole('button', { name: en['header.label'] })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.querySelector('[data-state]')).toBeNull()
    fireEvent.click(button)
    expect(b.toggle).toHaveBeenCalledWith(false)
  })

  it('marks change requests that need attention', () => {
    const b = header(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2, { checksRollup: 'failure' }))] }))
    const button = b.view.getByRole('button', { name: en['header.attention'] })
    expect(button.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('follows the tab visibility and hides a visible tab', () => {
    const b = header(ready(), true)
    const button = b.view.getByRole('button', { name: en['header.label'] })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(b.toggle).toHaveBeenLastCalledWith(true)

    act(() => { b.visibility.set(false) })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(b.toggle).toHaveBeenLastCalledWith(false)
  })

  it('appears, changes its label, and disappears as the panel state changes', () => {
    const b = header(null)
    act(() => { b.panel.set({ state: ready(), disconnected: false }) })
    expect(b.button()?.getAttribute('aria-label')).toBe(en['header.label'])
    act(() => { b.panel.set({ state: ready({ changeRequests: [entry(1, snapshot(1, { mergeability: 'conflicting' }))] }), disconnected: false }) })
    expect(b.button()?.getAttribute('aria-label')).toBe(en['header.attention'])
    act(() => { b.panel.set({ state: ready({ checkout: { state: 'none' } }), disconnected: true }) })
    expect(b.button()).toBeNull()
  })
})

describe('ForgeTabTitle', () => {
  it('shows the branch glyph and the tab name', () => {
    const view = render(<ForgeTabTitle t={t} />)
    expect(view.getByText(en['tab.title'])).toBeTruthy()
    expect(view.container.querySelector('svg')).not.toBeNull()
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
    const view = title(changesAddress({ sessionId: SessionId('s1'), source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7' } }))
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
