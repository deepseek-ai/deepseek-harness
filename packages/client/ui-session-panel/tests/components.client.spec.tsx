// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EnvironmentSection } from '../src/client/EnvironmentSection.tsx'
import { PanelDetails } from '../src/client/PanelDetails.tsx'
import { PanelFold } from '../src/client/PanelFold.tsx'
import { ProjectRow } from '../src/client/ProjectRow.tsx'
import { SessionPanel } from '../src/client/SessionPanel.tsx'
import { SessionPanelToggle } from '../src/client/SessionPanelToggle.tsx'
import type {
  EnvironmentSectionProps, PanelDetailsProps, ProjectRowProps, SessionPanelDockable, SessionPanelProbes, SessionPanelProps,
  SessionPanelRoom, SessionPanelSectionEntry, SessionPanelSectionOwnerProps, SessionPanelToggleProps, SessionPanelVisibility,
} from '../src/client/slots.ts'
import { SessionPanelState } from '../src/client/visibility.ts'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-1' as SessionId
const t = makeTranslate(zh) as SessionPanelToggleProps['t']
const DOCKED: SessionPanelVisibility = { docks: true, pinned: false, overlay: null }
/** Room in the gutter alone, as a wide window gives, or none at all. */
const roomOf = (gutter: boolean): SessionPanelRoom => ({ gutter, reserve: false })

function selectorOf<T>(value: T) {
  return <S,>(select: (current: T) => S): S => select(value)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Whether a hovered anchor's tooltip shows before and at 500ms of hover. */
function tooltipAfterHover(anchor: Element): { readonly early: boolean; readonly at500: boolean } {
  vi.useFakeTimers()
  fireEvent.pointerEnter(anchor, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(499) })
  const early = screen.queryByRole('tooltip', { hidden: true }) !== null
  act(() => { vi.advanceTimersByTime(1) })
  return { early, at500: screen.queryByRole('tooltip', { hidden: true }) !== null }
}

describe('SessionPanelToggle', () => {
  function toggleProps(dockable: boolean | undefined, visibility: SessionPanelVisibility, toggle = vi.fn()) {
    const renderSlot = vi.fn(() => <span>需要处理</span>)
    const entries: SessionPanelDockable = new Map(dockable === undefined ? [] : [[SID, roomOf(dockable)]])
    const props = {
      sessionId: SID, useDockable: selectorOf(entries), useVisibility: selectorOf(visibility), toggle, renderSlot, t,
    } as SessionPanelToggleProps
    return { props, toggle, renderSlot }
  }

  it('names the panel together with its indicators and reports the docked panel as expanded', () => {
    const { props, renderSlot } = toggleProps(true, DOCKED)
    render(<SessionPanelToggle {...props} />)
    const button = screen.getByRole('button', { name: '会话面板 需要处理' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(`dsh-session-panel-${SID}`)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session.panel.indicator', { panelShown: true })
  })

  it('flips docking with room to dock and opens the overlay without it', () => {
    const wide = toggleProps(true, DOCKED)
    render(<SessionPanelToggle {...wide.props} />)
    fireEvent.click(screen.getByRole('button'))
    expect(wide.toggle).toHaveBeenCalledWith(SID)
    cleanup()
    const narrow = toggleProps(false, DOCKED)
    render(<SessionPanelToggle {...narrow.props} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(button)
    expect(narrow.toggle).toHaveBeenCalledWith(SID)
  })

  it('reports an open overlay as expanded', () => {
    const { props } = toggleProps(false, { docks: false, pinned: false, overlay: SID })
    render(<SessionPanelToggle {...props} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  it('tells its indicators whether the panel shows', () => {
    const { props, renderSlot } = toggleProps(false, DOCKED)
    render(<SessionPanelToggle {...props} />)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session.panel.indicator', { panelShown: false })
  })

  it('shows its tooltip after 500ms of hover', () => {
    const { props } = toggleProps(true, DOCKED)
    render(<SessionPanelToggle {...props} />)
    expect(tooltipAfterHover(screen.getByRole('button'))).toEqual({ early: false, at500: true })
  })

  it('is unavailable and says why while no Chat View shows the Session', () => {
    const { props } = toggleProps(undefined, { docks: true, pinned: false, overlay: SID })
    render(<SessionPanelToggle {...props} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-controls')).toBe(false)
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('切换到「对话」视图后可显示会话面板')
  })
})

describe('SessionPanel', () => {
  const SECTIONS: readonly SessionPanelSectionEntry[] = [
    { id: 'environment', label: '环境' },
    { id: 'change-requests', label: '变更请求' },
  ]

  /** Ids of the probes the rendered panels created, so a later props object answers for the mounted panel. */
  const probeIds = new Set<string>()
  afterEach(() => { probeIds.clear() })

  /** Panel props whose panels all have this room: a boolean stands for the gutter alone. */
  function panelProps(dockable: boolean | SessionPanelRoom, visibility: SessionPanelVisibility, closeOverlay = vi.fn()) {
    const room = typeof dockable === 'boolean' ? roomOf(dockable) : dockable
    const setPinned = vi.fn<(sessionId: SessionId, pinned: boolean) => void>()
    const moveSection = vi.fn<(id: string, target: string, placement: 'before' | 'after') => void>()
    const owners: SessionPanelSectionOwnerProps[] = []
    const renderSlot = ((key: string, owner: object, opts?: { only?: string; entryKey?: string }): ReactNode => {
      if (key === 'conversation.session.panel.section.actions') {
        return opts?.entryKey === 'change-requests' ? <button type="button">刷新</button> : null
      }
      owners.push(owner as SessionPanelSectionOwnerProps)
      return <p>{`${opts?.only ?? ''} body`}</p>
    }) as SessionPanelProps['renderSlot']
    const attached = vi.fn<(element: HTMLElement | null) => void>()
    const createProbeRef = vi.fn((_sessionId: SessionId, probe: string, _member: keyof SessionPanelRoom) => {
      probeIds.add(probe)
      return attached
    })
    const props = {
      sessionId: SID,
      useVisibility: selectorOf(visibility),
      useSections: selectorOf(SECTIONS),
      useProbes: <S,>(select: (probes: SessionPanelProbes) => S): S => select(new Map([...probeIds].map(id => [id, room]))),
      createProbeRef,
      setPinned,
      closeOverlay,
      moveSection,
      renderSlot,
      t,
    } as SessionPanelProps
    return { props, owners, closeOverlay, createProbeRef, attached, setPinned, moveSection }
  }

  it('attaches its two probes through the injected refs once, under one id, and detaches them on unmount', () => {
    const { props, createProbeRef, attached } = panelProps(true, DOCKED)
    const view = render(<SessionPanel {...props} />)
    const gutter = view.container.querySelector('[data-session-panel-probe="gutter"]')
    const reserve = view.container.querySelector('[data-session-panel-probe="reserve"]')
    expect([gutter, reserve]).not.toContain(null)
    const id = createProbeRef.mock.calls[0]?.[1]
    expect(createProbeRef.mock.calls).toEqual([[SID, id, 'gutter'], [SID, id, 'reserve']])
    expect(attached.mock.calls).toEqual([[gutter], [reserve]])
    // A later render keeps the refs, so the probes are neither detached nor attached again.
    const next = panelProps(true, DOCKED)
    view.rerender(<SessionPanel {...next.props} />)
    expect(next.createProbeRef).not.toHaveBeenCalled()
    expect(attached).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(attached.mock.calls.slice(-2)).toEqual([[null], [null]])
  })

  it('renders again only when one of its probes flips', () => {
    const observed: { readonly element: Element; readonly callback: ResizeObserverCallback }[] = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe(element: Element): void { observed.push({ element, callback: this.callback }) }
      unobserve(): void {}
      disconnect(): void {}
    })
    const state = new SessionPanelState()
    const base = panelProps(false, DOCKED)
    const props = {
      ...base.props,
      useProbes: bindSnapshotSelector(state.probes),
      createProbeRef: (sessionId: SessionId, probe: string, member: keyof SessionPanelRoom) =>
        state.createProbeRef(sessionId, probe, member),
    } as SessionPanelProps
    const view = render(<SessionPanel {...props} />)
    /** Report the gutter probe's width. */
    const resize = (width: number): void => {
      act(() => {
        for (const { element, callback } of observed) {
          if (element.getAttribute('data-session-panel-probe') !== 'gutter') continue
          callback([{ target: element, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
        }
      })
    }
    expect(observed.map(entry => entry.element)).toEqual([...view.container.querySelectorAll('[data-session-panel-probe]')])
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(state.dockable.getSnapshot().get(SID)).toEqual(roomOf(false))
    resize(1)
    expect(screen.getByRole('complementary').getAttribute('data-session-panel')).toBe('docked')
    // CSS sizes the docked panel; no measured width reaches its style.
    expect(screen.getByRole('complementary').getAttribute('style')).toBeNull()
    const settled = base.owners.length
    resize(1)
    expect(base.owners).toHaveLength(settled)
    // A probe under 1px wide sits within a pixel below the gutter that docks the panel.
    resize(0.5)
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(state.dockable.getSnapshot().get(SID)).toEqual(roomOf(false))
    view.unmount()
    expect(state.dockable.getSnapshot().has(SID)).toBe(false)
  })

  it('renders only its probes while hidden', () => {
    const { props } = panelProps(true, { docks: false, pinned: false, overlay: null })
    const view = render(<SessionPanel {...props} />)
    expect(view.container.querySelector('[data-session-panel]')).toBeNull()
    expect([...view.container.children].map(child => child.getAttribute('data-session-panel-probe'))).toEqual(['gutter', 'reserve'])
  })

  it('docks with one titled region per section in roster order and each section body', () => {
    const { props, owners } = panelProps(true, DOCKED)
    render(<SessionPanel {...props} />)
    const panel = screen.getByRole('complementary', { name: '会话面板' })
    expect(panel.getAttribute('data-session-panel')).toBe('docked')
    expect(panel.id).toBe(`dsh-session-panel-${SID}`)
    const regions = screen.getAllByRole('region')
    expect(regions.map(region => region.getAttribute('aria-labelledby'))).toEqual([
      `dsh-session-panel-${SID}-environment`, `dsh-session-panel-${SID}-change-requests`,
    ])
    expect(screen.getByRole('heading', { name: '变更请求' })).toBeTruthy()
    expect(screen.getByText('environment body')).toBeTruthy()
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()
    expect(owners.every(owner => owner.presentation === 'docked')).toBe(true)
  })

  it('closes the overlay on Escape from inside and returns focus to the toggle', () => {
    const { props, owners, closeOverlay } = panelProps(false, { docks: true, pinned: false, overlay: SID })
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    document.body.append(toggle)
    try {
      render(<SessionPanel {...props} />)
      const panel = screen.getByRole('complementary')
      expect(panel.getAttribute('data-session-panel')).toBe('overlay')
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(closeOverlay).not.toHaveBeenCalled()
      screen.getByRole('button', { name: '刷新' }).focus()
      fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
      expect(closeOverlay).toHaveBeenCalledWith(SID)
      expect(document.activeElement).toBe(toggle)
      owners[0]?.dismissOverlay()
      expect(closeOverlay).toHaveBeenCalledTimes(2)
    } finally {
      toggle.remove()
    }
  })

  it('closes the overlay on Escape from the page without moving focus', () => {
    const { props, closeOverlay } = panelProps(false, { docks: true, pinned: false, overlay: SID })
    render(<SessionPanel {...props} />)
    const outside = document.createElement('input')
    document.body.append(outside)
    try {
      outside.focus()
      fireEvent.keyDown(outside, { key: 'Escape' })
      expect(closeOverlay).toHaveBeenCalledWith(SID)
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('closes the overlay on an outside pointerdown but not on the panel, the toggle, or an open menu', () => {
    const { props, closeOverlay } = panelProps(false, { docks: true, pinned: false, overlay: SID })
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(toggle, menu)
    try {
      render(<SessionPanel {...props} />)
      fireEvent.pointerDown(screen.getByText('environment body'))
      fireEvent.pointerDown(toggle)
      fireEvent.pointerDown(item)
      expect(closeOverlay).not.toHaveBeenCalled()
      fireEvent.pointerDown(document.body)
      expect(closeOverlay).toHaveBeenCalledWith(SID)
    } finally {
      toggle.remove()
      menu.remove()
    }
  })

  it('leaves Escape to other handlers while docked, after another handler took it, or behind a modal', () => {
    const docked = panelProps(true, DOCKED)
    render(<SessionPanel {...docked.props} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    expect(docked.closeOverlay).not.toHaveBeenCalled()
    cleanup()
    const overlay = panelProps(false, { docks: true, pinned: false, overlay: SID })
    render(<SessionPanel {...overlay.props} />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)
    expect(overlay.closeOverlay).not.toHaveBeenCalled()
    // A modal opened over the overlay registers its Escape after the panel's, so the panel sees it first.
    function Modal() {
      const dialog = useRef<HTMLDivElement>(null)
      useModalLayer(dialog, true, () => {})
      return <div ref={dialog} role="dialog" aria-modal="true" />
    }
    const modal = render(<Modal />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(overlay.closeOverlay).not.toHaveBeenCalled()
    modal.unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(overlay.closeOverlay).toHaveBeenCalledWith(SID)
  })

  it('leaves Escape to an input method composing text, including the key that ends the composition', () => {
    const { props, closeOverlay } = panelProps(false, { docks: true, pinned: false, overlay: SID })
    render(<SessionPanel {...props} />)
    fireEvent(document, new Event('compositionstart'))
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent(document, new Event('compositionend'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeOverlay).not.toHaveBeenCalled()
    fireEvent.keyUp(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeOverlay).toHaveBeenCalledWith(SID)
  })

  it('hands focus to the toggle when the panel hides with the keyboard inside it', () => {
    const toggle = document.createElement('button')
    toggle.id = `dsh-session-panel-toggle-${SID}`
    const outside = document.createElement('button')
    document.body.append(toggle, outside)
    try {
      const docked = panelProps(true, DOCKED)
      const view = render(<SessionPanel {...docked.props} />)
      const control = screen.getByRole('button', { name: '刷新' })
      control.focus()
      // Moves within the panel, and blurs that name no next target, keep the keyboard inside.
      fireEvent.focusOut(control, { relatedTarget: screen.getByRole('complementary') })
      fireEvent.focusOut(control, { relatedTarget: null })
      view.rerender(<SessionPanel {...panelProps(false, DOCKED).props} />)
      expect(document.activeElement).toBe(toggle)
      // Focus that already left the panel stays where it went.
      view.rerender(<SessionPanel {...docked.props} />)
      screen.getByRole('button', { name: '刷新' }).focus()
      outside.focus()
      view.rerender(<SessionPanel {...panelProps(false, DOCKED).props} />)
      expect(document.activeElement).toBe(outside)
      // A panel that hides without having held focus moves nothing.
      view.rerender(<SessionPanel {...docked.props} />)
      view.rerender(<SessionPanel {...panelProps(false, DOCKED).props} />)
      expect(document.activeElement).toBe(outside)
    } finally {
      toggle.remove()
      outside.remove()
    }
  })

  describe('pin', () => {
    const PINNED: SessionPanelVisibility = { docks: true, pinned: true, overlay: null }
    const RESERVE: SessionPanelRoom = { gutter: false, reserve: true }
    const pin = (): HTMLElement | null => screen.queryByRole('button', { name: '固定会话面板' })

    it('offers the pin on a docked panel, unpressed, and pins on a press', () => {
      const { props, setPinned } = panelProps(true, DOCKED)
      const view = render(<SessionPanel {...props} />)
      const button = pin()!
      expect(button.getAttribute('aria-pressed')).toBe('false')
      // The pin precedes the sections, so it is the panel's first control.
      expect(screen.getByRole('complementary').firstElementChild).toBe(button)
      // Unpinned, the body is not asked to keep the panel's room.
      expect(view.container.querySelector('[data-session-panel-reserve]')).toBeNull()
      fireEvent.click(button)
      expect(setPinned.mock.calls).toEqual([[SID, true]])
      expect(tooltipAfterHover(button)).toEqual({ early: false, at500: true })
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('固定面板')
    })

    it('shows a pinned panel in the room the transcript makes, pressed, asks the body for that room, and unpins on a press', () => {
      const { props, setPinned, owners } = panelProps(RESERVE, PINNED)
      const view = render(<SessionPanel {...props} />)
      expect(screen.getByRole('complementary').getAttribute('data-session-panel')).toBe('docked')
      expect(owners.every(owner => owner.presentation === 'docked')).toBe(true)
      const button = pin()!
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(view.container.querySelector('[data-session-panel-reserve]')?.getAttribute('data-session-panel-probe')).toBe('gutter')
      fireEvent.click(button)
      expect(setPinned.mock.calls).toEqual([[SID, false]])
      fireEvent.keyDown(document.body, { key: 'Tab' })
      fireEvent.focus(button)
      expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('取消固定')
    })

    it('asks for no room while the toggle hides a pinned panel', () => {
      const { props } = panelProps(RESERVE, { docks: false, pinned: true, overlay: null })
      const view = render(<SessionPanel {...props} />)
      expect(screen.queryByRole('complementary')).toBeNull()
      expect(view.container.querySelector('[data-session-panel-reserve]')).toBeNull()
    })

    it('offers the pin on an overlay only where the transcript can make room or the pin is already on', () => {
      const none = panelProps(false, { docks: true, pinned: false, overlay: SID })
      const view = render(<SessionPanel {...none.props} />)
      expect(screen.getByRole('complementary').getAttribute('data-session-panel')).toBe('overlay')
      expect(pin()).toBeNull()
      view.rerender(<SessionPanel {...panelProps(RESERVE, { docks: true, pinned: false, overlay: SID }).props} />)
      expect(pin()?.getAttribute('aria-pressed')).toBe('false')
      // Pinned where the transcript cannot make room: the overlay still offers the way to unpin.
      view.rerender(<SessionPanel {...panelProps(false, { docks: true, pinned: true, overlay: SID }).props} />)
      expect(screen.getByRole('complementary').getAttribute('data-session-panel')).toBe('overlay')
      expect(pin()?.getAttribute('aria-pressed')).toBe('true')
    })

    it('keeps the panel mounted and the pin focused as a press docks the overlay and the next one returns it', () => {
      const observed: { readonly element: Element; readonly callback: ResizeObserverCallback }[] = []
      vi.stubGlobal('ResizeObserver', class {
        private readonly callback: ResizeObserverCallback
        constructor(callback: ResizeObserverCallback) { this.callback = callback }
        observe(element: Element): void { observed.push({ element, callback: this.callback }) }
        unobserve(): void {}
        disconnect(): void {}
      })
      const state = new SessionPanelState()
      const props = {
        ...panelProps(false, DOCKED).props,
        useVisibility: bindSnapshotSelector(state.visibility),
        useProbes: bindSnapshotSelector(state.probes),
        createProbeRef: (sessionId: SessionId, probe: string, member: keyof SessionPanelRoom) =>
          state.createProbeRef(sessionId, probe, member),
        setPinned: (sessionId: SessionId, pinned: boolean) => { state.setPinned(sessionId, pinned) },
        closeOverlay: (sessionId: SessionId) => { state.closeOverlay(sessionId) },
      } as SessionPanelProps
      render(<SessionPanel {...props} />)
      // The transcript can make room; the gutter alone holds nothing.
      act(() => {
        for (const { element, callback } of observed) {
          if (element.getAttribute('data-session-panel-probe') !== 'reserve') continue
          callback([{ target: element, contentRect: { width: 1 } } as ResizeObserverEntry], {} as ResizeObserver)
        }
      })
      expect(screen.queryByRole('complementary')).toBeNull()
      act(() => { state.toggle(SID) })
      const panel = screen.getByRole('complementary')
      expect(panel.getAttribute('data-session-panel')).toBe('overlay')
      const button = pin()!
      button.focus()
      fireEvent.click(button)
      expect(panel.getAttribute('data-session-panel')).toBe('docked')
      expect(screen.getByRole('complementary')).toBe(panel)
      expect(document.activeElement).toBe(pin())
      // An outside press no longer closes it.
      fireEvent.pointerDown(document.body)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('complementary').getAttribute('data-session-panel')).toBe('docked')
      fireEvent.click(pin()!)
      expect(screen.getByRole('complementary')).toBe(panel)
      expect(panel.getAttribute('data-session-panel')).toBe('overlay')
      expect(document.activeElement).toBe(pin())
      fireEvent.pointerDown(document.body)
      expect(screen.queryByRole('complementary')).toBeNull()
    })
  })

  describe('section order', () => {
    const THREE: readonly SessionPanelSectionEntry[] = [...SECTIONS, { id: 'jobs', label: '后台任务' }]
    const sectionOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-session-panel-section="${id}"]`)!
    const headOf = (id: string): HTMLElement => sectionOf(id).firstElementChild as HTMLElement
    const gripOf = (id: string): Element | null => headOf(id).querySelector('[data-session-panel-grip]')
    const transfer = () => ({
      setData: vi.fn(), effectAllowed: '', dropEffect: '',
      setDragImage: vi.fn<(image: HTMLElement, x: number, y: number) => void>(),
    })
    /** Give a section a box from `top` down, 40px tall and 300px wide; jsdom lays nothing out. */
    const place = (id: string, top: number): void => {
      vi.spyOn(sectionOf(id), 'getBoundingClientRect').mockReturnValue({
        top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top, toJSON: () => ({}),
      })
    }
    /** jsdom's DragEvent fallback drops pointer coordinates from event options. */
    const drag = (
      target: HTMLElement, kind: 'dragOver' | 'dragLeave' | 'drop', point: { x?: number; y: number }, dataTransfer = transfer(),
    ) => {
      const event = createEvent[kind](target)
      Object.defineProperties(event, {
        clientX: { value: point.x ?? 150 }, clientY: { value: point.y }, dataTransfer: { value: dataTransfer },
      })
      fireEvent(target, event)
      return { event, dataTransfer }
    }
    const marks = (): (string | null)[][] => ['environment', 'change-requests', 'jobs'].map(id => [
      sectionOf(id).getAttribute('data-dragging'), sectionOf(id).getAttribute('data-drop-target'),
    ])
    const NONE = [[null, null], [null, null], [null, null]]
    function threeSections() {
      const base = panelProps(true, DOCKED)
      return { ...base, props: { ...base.props, useSections: selectorOf(THREE) } as SessionPanelProps }
    }

    it('makes every title row but Environment a drag source that ends with a handle, which is a mark and no control', () => {
      const { props } = threeSections()
      render(<SessionPanel {...props} />)
      for (const id of ['change-requests', 'jobs']) {
        expect(headOf(id).draggable).toBe(true)
        const grip = gripOf(id)!
        expect(headOf(id).lastElementChild).toBe(grip)
        expect([grip.tagName, grip.getAttribute('aria-hidden')]).toEqual(['SPAN', 'true'])
      }
      // The panel's only buttons are the pin and the control a section put in its own title row.
      expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['固定会话面板', '刷新'])
      // Environment keeps its place: its title row is no drag source and has no handle.
      expect(headOf('environment').draggable).toBe(false)
      expect(gripOf('environment')).toBeNull()
      const dataTransfer = transfer()
      fireEvent.dragStart(headOf('environment'), { dataTransfer })
      expect(dataTransfer.setData).not.toHaveBeenCalled()
      expect(marks()).toEqual(NONE)
    })

    it('marks the dragged section and the edge it would land at, and moves it on the drop', () => {
      const { props, moveSection } = threeSections()
      render(<SessionPanel {...props} />)
      place('environment', 100)
      place('change-requests', 140)
      place('jobs', 180)
      const dataTransfer = transfer()
      fireEvent.dragStart(headOf('jobs'), { dataTransfer })
      expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-dsh-session-panel-section', 'jobs')
      expect(dataTransfer.effectAllowed).toBe('move')
      // The drag image is a copy of the title row.
      expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(1)
      expect(dataTransfer.setDragImage.mock.calls[0]?.[0].textContent).toContain('后台任务')
      expect(marks()).toEqual([[null, null], [null, null], ['', null]])

      const over = drag(sectionOf('change-requests'), 'dragOver', { y: 150 })
      expect(over.event.defaultPrevented).toBe(true)
      expect(over.dataTransfer.dropEffect).toBe('move')
      expect(marks()).toEqual([[null, null], [null, 'before'], ['', null]])
      drag(sectionOf('change-requests'), 'dragOver', { y: 150 })
      drag(sectionOf('change-requests'), 'dragOver', { y: 170 })
      expect(marks()).toEqual([[null, null], [null, 'after'], ['', null]])
      // A leave for a child of the same section keeps the mark; one whose pointer is outside the section clears it.
      drag(sectionOf('change-requests'), 'dragLeave', { y: 160 })
      expect(marks()[1]).toEqual([null, 'after'])
      // Another section's leave does not clear this one's mark.
      drag(sectionOf('environment'), 'dragLeave', { y: 300 })
      expect(marks()[1]).toEqual([null, 'after'])
      for (const outside of [{ y: 139 }, { y: 180 }, { x: -1, y: 160 }, { x: 300, y: 160 }]) {
        drag(sectionOf('change-requests'), 'dragOver', { y: 170 })
        drag(sectionOf('change-requests'), 'dragLeave', outside)
        expect(marks()[1]).toEqual([null, null])
      }
      // Over the dragged section itself there is nowhere to land.
      drag(sectionOf('change-requests'), 'dragOver', { y: 150 })
      expect(drag(sectionOf('jobs'), 'dragOver', { y: 190 }).event.defaultPrevented).toBe(true)
      expect(marks()).toEqual([[null, null], [null, null], ['', null]])

      drag(sectionOf('change-requests'), 'dragOver', { y: 150 })
      const drop = drag(sectionOf('change-requests'), 'drop', { y: 150 })
      expect(drop.event.defaultPrevented).toBe(true)
      expect(moveSection.mock.calls).toEqual([['jobs', 'change-requests', 'before']])
      expect(marks()).toEqual(NONE)
      fireEvent.dragEnd(headOf('jobs'))
      expect(marks()).toEqual(NONE)
    })

    it('lands a section after Environment whichever half of it the pointer is over', () => {
      const { props, moveSection } = threeSections()
      render(<SessionPanel {...props} />)
      place('environment', 100)
      fireEvent.dragStart(headOf('jobs'), { dataTransfer: transfer() })
      drag(sectionOf('environment'), 'dragOver', { y: 105 })
      expect(marks()[0]).toEqual([null, 'after'])
      drag(sectionOf('environment'), 'dragOver', { y: 135 })
      expect(marks()[0]).toEqual([null, 'after'])
      drag(sectionOf('environment'), 'drop', { y: 105 })
      expect(moveSection.mock.calls).toEqual([['jobs', 'environment', 'after']])
    })

    it('clears the marks when the drag ends without a drop', () => {
      const { props, moveSection } = threeSections()
      render(<SessionPanel {...props} />)
      place('change-requests', 140)
      fireEvent.dragStart(headOf('jobs'), { dataTransfer: transfer() })
      drag(sectionOf('change-requests'), 'dragOver', { y: 170 })
      fireEvent.dragEnd(headOf('jobs'))
      expect(marks()).toEqual(NONE)
      expect(moveSection).not.toHaveBeenCalled()
      // A drag end that this panel did not start changes nothing.
      fireEvent.dragEnd(headOf('jobs'))
      expect(marks()).toEqual(NONE)
    })

    it('ignores a drag that did not start on one of its title rows', () => {
      const { props, moveSection } = threeSections()
      render(<SessionPanel {...props} />)
      place('change-requests', 140)
      expect(drag(sectionOf('change-requests'), 'dragOver', { y: 150 }).event.defaultPrevented).toBe(false)
      expect(drag(sectionOf('change-requests'), 'drop', { y: 150 }).event.defaultPrevented).toBe(false)
      expect(marks()).toEqual(NONE)
      expect(moveSection).not.toHaveBeenCalled()
    })
  })
})

describe('EnvironmentSection', () => {
  it('renders its rows straight into the section body with the section owner values', () => {
    const renderSlot = vi.fn(() => <span>row</span>)
    const dismissOverlay = vi.fn<() => void>()
    render(<>{EnvironmentSection({ presentation: 'overlay', dismissOverlay, renderSlot } as Pick<EnvironmentSectionProps,
      'presentation' | 'dismissOverlay' | 'renderSlot'> as EnvironmentSectionProps)}</>)
    expect(renderSlot).toHaveBeenCalledWith('conversation.session.panel.environment.row', { presentation: 'overlay', dismissOverlay })
    expect(screen.getByText('row')).toBeTruthy()
  })
})

describe('ProjectRow', () => {
  function rowProps(over: {
    workingDirectory?: string | null
    workspacePath?: string
    cwd?: string
    home?: string
  }, open = vi.fn()) {
    const renderFactorySlot = vi.fn((_name: string, input: { label: string }) => <button type="button">{input.label}</button>)
    const props = {
      sessionId: SID,
      useProjection: (key: string) => key === 'workingDirectory' ? over.workingDirectory : undefined,
      useWorkspaces: selectorOf({
        items: over.workspacePath === undefined ? [] : [{ path: over.workspacePath, sessionIds: [SID] }],
      }),
      useSessions: selectorOf({ byId: over.cwd === undefined ? {} : { [SID]: { cwd: over.cwd } } }),
      useHost: selectorOf({ home: over.home, isLoopback: true }),
      useContextMenu: contextMenuHook(open),
      renderFactorySlot,
      t,
    } as ProjectRowProps
    return { props, renderFactorySlot, open }
  }

  function folderOf(container: HTMLElement): { name: string | null; parent: string | null } {
    const folder = container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement
    const [name, parent] = [...folder.children]
    return { name: name?.textContent ?? null, parent: parent?.textContent ?? null }
  }

  it('shows the working directory as its name and parent folder, with the label and full path in the tooltip', () => {
    const { props, renderFactorySlot } = rowProps({
      workingDirectory: '/Users/me/projects/app/.worktrees/fix',
      cwd: '/Users/me/projects/app',
      workspacePath: '/Users/me/projects/app',
      home: '/Users/me',
    })
    const view = render(<ProjectRow {...props} />)
    expect(folderOf(view.container)).toEqual({ name: 'fix', parent: '~/projects/app/.worktrees' })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(view.container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement)
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('工作目录\n~/projects/app/.worktrees/fix')
    fireEvent.blur(view.container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement)
    expect(tooltipAfterHover(view.container.querySelector('[data-session-panel-project] [tabindex="0"]') as HTMLElement))
      .toEqual({ early: false, at500: true })
    expect(renderFactorySlot).toHaveBeenCalledWith('contextMenu.button', expect.objectContaining({
      target: { kind: 'directory', value: { sessionId: SID, path: '/Users/me/projects/app/.worktrees/fix' } },
      label: '工作目录操作',
    }))
    expect(renderFactorySlot.mock.calls[0]?.[1]).not.toHaveProperty('size')
    expect(screen.getByRole('button', { name: '工作目录操作' })).toBeTruthy()
  })

  it('marks its parts for the panel\'s row rules: icon and folder in the body, then the More button as the row menu', () => {
    const view = render(<ProjectRow {...rowProps({ cwd: '/srv/app' }).props} />)
    const row = view.container.querySelector('[data-session-panel-row]') as HTMLElement
    expect(row.hasAttribute('data-session-panel-project')).toBe(true)
    expect([...row.children].map(part => part.getAttribute('data-row-part'))).toEqual(['body', 'menu'])
    const [body, menu] = [...row.children] as [HTMLElement, HTMLElement]
    expect(body.tagName).toBe('SPAN')
    expect([...body.children].map(part => part.getAttribute('data-row-part'))).toEqual(['icon', 'content'])
    expect(body.children[0]?.getAttribute('aria-hidden')).toBe('true')
    expect(body.children[1]?.textContent).toBe('app/srv')
    expect(menu.querySelector('button')?.textContent).toBe('工作目录操作')
  })

  it('falls back to the directory the Session was created in and opens the directory menu on right-click', () => {
    const { props, open } = rowProps({ cwd: '/srv/app', workspacePath: '/srv' })
    const view = render(<ProjectRow {...props} />)
    expect(folderOf(view.container)).toEqual({ name: 'app', parent: '/srv' })
    fireEvent.contextMenu(view.container.querySelector('[data-session-panel-project]') as HTMLElement)
    expect(open).toHaveBeenCalledWith({ kind: 'directory', value: { sessionId: SID, path: '/srv/app' } }, expect.anything())
  })

  it('falls back to the listing Workspace when no directory is recorded, keeping a root parent and omitting an absent one', () => {
    const atRoot = render(<ProjectRow {...rowProps({ workingDirectory: null, workspacePath: '/srv' }).props} />)
    expect(folderOf(atRoot.container)).toEqual({ name: 'srv', parent: '/' })
    atRoot.unmount()
    const atHome = render(<ProjectRow {...rowProps({ workingDirectory: '/Users/me', home: '/Users/me' }).props} />)
    expect(folderOf(atHome.container)).toEqual({ name: '~', parent: null })
  })

  it('renders nothing before the Session directory is known', () => {
    const { props } = rowProps({})
    const view = render(<ProjectRow {...props} />)
    expect(view.container.innerHTML).toBe('')
  })
})

describe('PanelFold', () => {
  type FoldProps = FactoryComponentPropsOf<'conversation.session.panel.fold'>

  /** Render the control with the props a list passes; the renderer's standard seats are left out, as the control reads none. */
  function fold(expanded: boolean) {
    const onToggle = vi.fn<() => void>()
    const props = {
      expanded, onToggle,
      label: expanded ? 'Show less' : 'Show 14 more',
      name: expanded ? 'Show less (subagents)' : 'Show 14 more (subagents)',
    } as Pick<FoldProps, 'expanded' | 'label' | 'name' | 'onToggle'> as FoldProps
    const view = render(<PanelFold {...props} />)
    return { onToggle, row: view.container.firstElementChild as HTMLElement }
  }

  it('is a panel row whose body is the button, with a down chevron in the icon part while rows are held back', () => {
    const { row, onToggle } = fold(false)
    expect(row.getAttribute('data-session-panel-row')).toBe('fold')
    expect([...row.children].map(part => `${part.tagName}:${part.getAttribute('data-row-part') ?? ''}`)).toEqual(['BUTTON:body'])
    const button = screen.getByRole('button', { name: 'Show 14 more (subagents)' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect([...button.children].map(part => part.getAttribute('data-row-part'))).toEqual(['icon', 'content'])
    expect(button.children[0]?.getAttribute('aria-hidden')).toBe('true')
    expect(button.querySelector('svg')?.getAttribute('data-icon')).toBe('dsw-icon-chevron-down-outline-regular')
    expect(button.children[1]?.textContent).toBe('Show 14 more')
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('points the chevron up and reports expanded once the list shows every row', () => {
    const { row } = fold(true)
    const button = screen.getByRole('button', { name: 'Show less (subagents)' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('svg')?.getAttribute('data-icon')).toBe('dsw-icon-chevron-up-outline-regular')
    expect(row.querySelector('[data-row-part="content"]')?.textContent).toBe('Show less')
  })
})

describe('PanelDetails', () => {
  /** Render the details with the props a row passes; the renderer's standard seats are left out, as the details read none. */
  function details(input: PanelDetailsProps): HTMLElement {
    const view = render(<PanelDetails {...input as FactoryComponentPropsOf<'conversation.session.panel.details'>} />)
    return view.container.querySelector('[data-session-panel-details]') as HTMLElement
  }

  it('stacks the title, lines, state, and measures in order, each measure after the icon of its kind', () => {
    const root = details({
      title: 'Survey open-source harnesses',
      lines: ['Owner: open-source-arch'],
      status: { state: 'done', label: 'Completed' },
      facts: [{ kind: 'tokens', label: '3.3M tok' }, { kind: 'duration', label: '6m 56s' }],
    })
    expect([...root.children].map(child => child.textContent))
      .toEqual(['Survey open-source harnesses', 'Owner: open-source-arch', 'Completed', '3.3M tok6m 56s'])
    expect(root.children[2]?.querySelector('[data-state="done"]')).not.toBeNull()
    const facts = [...(root.children[3] as HTMLElement).children]
    expect(facts.map(fact => [fact.getAttribute('data-fact'), fact.querySelector('svg')?.getAttribute('data-icon')])).toEqual([
      ['tokens', 'dsw-icon-database-outline-regular'],
      ['duration', 'dsw-icon-clock-outline-regular'],
    ])
    expect(facts.every(fact => fact.firstElementChild?.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('renders only the title when nothing else is given', () => {
    expect(details({ title: 'sleep 30' }).children).toHaveLength(1)
  })

  it('starts with the lines when the title is omitted', () => {
    const root = details({ lines: ['bash'], status: { state: 'ongoing', label: 'running' } })
    expect([...root.children].map(child => child.textContent)).toEqual(['bash', 'running'])
  })
})

describe('dictionaries', () => {
  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
