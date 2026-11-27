// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { SlotTestRuntime, bindSnapshotSelector, contextMenuHook, makeTranslate, responsiveHooks } from '@deepseek-ai/dsh-client-test-runtime'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EnvironmentSection } from '../src/client/EnvironmentSection.tsx'
import { PanelDetails } from '../src/client/PanelDetails.tsx'
import { PanelFold } from '../src/client/PanelFold.tsx'
import { ProjectRow } from '../src/client/ProjectRow.tsx'
import { SessionPanel } from '../src/client/SessionPanel.tsx'
import panelStyles from '../src/client/SessionPanel.module.css'
import { SessionPanelToggle } from '../src/client/SessionPanelToggle.tsx'
import type {
  EnvironmentSectionProps, PanelDetailsProps, ProjectRowProps, SessionPanelDockable, SessionPanelProbes, SessionPanelProps,
  SessionPanelSectionEntry, SessionPanelSectionOwnerProps, SessionPanelToggleProps, SessionPanelVisibility,
} from '../src/client/slots.ts'
import { SessionPanelState } from '../src/client/visibility.ts'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-1' as SessionId
const t = makeTranslate(zh) as SessionPanelToggleProps['t']
const DOCKED: SessionPanelVisibility = { pinned: true, overlay: null }

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
    const entries: SessionPanelDockable = new Map(dockable === undefined ? [] : [[SID, dockable]])
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
    const { props } = toggleProps(false, { pinned: false, overlay: SID })
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
    const { props } = toggleProps(undefined, { pinned: true, overlay: SID })
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
  /** Whether the page asks for reduced motion; each test starts with it asked. */
  let reducedMotion = true
  afterEach(() => {
    probeIds.clear()
    reducedMotion = true
  })

  /** Panel props whose dock probes all have, or all lack, room to dock. */
  function panelProps(dockable: boolean, visibility: SessionPanelVisibility, closeOverlay = vi.fn()) {
    const owners: SessionPanelSectionOwnerProps[] = []
    const renderSlot = ((key: string, owner: object, opts?: { only?: string; entryKey?: string }): ReactNode => {
      if (key === 'conversation.session.panel.section.actions') {
        return opts?.entryKey === 'change-requests' ? <button type="button">刷新</button> : null
      }
      owners.push(owner as SessionPanelSectionOwnerProps)
      return <p>{`${opts?.only ?? ''} body`}</p>
    }) as SessionPanelProps['renderSlot']
    const moveSection = vi.fn<(id: string, target: string, placement: 'before' | 'after') => void>()
    const attached = vi.fn<(element: HTMLElement | null) => void>()
    const createProbeRef = vi.fn((_sessionId: SessionId, probe: string) => {
      probeIds.add(probe)
      return attached
    })
    const props = {
      ...responsiveHooks({ matches: query => reducedMotion && query === '(prefers-reduced-motion: reduce)' }),
      sessionId: SID,
      useVisibility: selectorOf(visibility),
      useSections: selectorOf(SECTIONS),
      useProbes: <S,>(select: (probes: SessionPanelProbes) => S): S => select(new Map([...probeIds].map(id => [id, dockable]))),
      createProbeRef,
      closeOverlay,
      moveSection,
      renderSlot,
      t,
    } as SessionPanelProps
    return { props, owners, closeOverlay, createProbeRef, attached, moveSection }
  }

  it('attaches its dock probe through the injected ref once and detaches it on unmount', () => {
    const { props, createProbeRef, attached } = panelProps(true, DOCKED)
    const view = render(<SessionPanel {...props} />)
    const probe = view.container.querySelector('[data-session-panel-probe]')
    expect(probe).not.toBeNull()
    expect(createProbeRef.mock.calls).toEqual([[SID, expect.any(String)]])
    expect(attached.mock.calls).toEqual([[probe]])
    // A later render keeps the ref, so the probe is neither detached nor attached again.
    const next = panelProps(true, DOCKED)
    view.rerender(<SessionPanel {...next.props} />)
    expect(next.createProbeRef).not.toHaveBeenCalled()
    expect(attached).toHaveBeenCalledTimes(1)
    view.unmount()
    // React 19's development build detaches a callback ref with extra undefined arguments after null.
    expect(attached.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('renders again only when its dock probe flips', () => {
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
      createProbeRef: (sessionId: SessionId, probe: string) => state.createProbeRef(sessionId, probe),
    } as SessionPanelProps
    const view = render(<SessionPanel {...props} />)
    const resize = (width: number): void => {
      act(() => {
        for (const { element, callback } of observed) {
          callback([{ target: element, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
        }
      })
    }
    expect(observed.map(entry => entry.element)).toEqual([view.container.querySelector('[data-session-panel-probe]')])
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(state.dockable.getSnapshot().get(SID)).toBe(false)
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
    expect(state.dockable.getSnapshot().get(SID)).toBe(false)
    view.unmount()
    expect(state.dockable.getSnapshot().has(SID)).toBe(false)
  })

  it('renders only its dock probe while hidden', () => {
    const { props } = panelProps(true, { pinned: false, overlay: null })
    const view = render(<SessionPanel {...props} />)
    expect(view.container.querySelector('[data-session-panel]')).toBeNull()
    expect(view.container.children).toHaveLength(1)
    expect(view.container.firstElementChild?.hasAttribute('data-session-panel-probe')).toBe(true)
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
    const { props, owners, closeOverlay } = panelProps(false, { pinned: true, overlay: SID })
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
    const { props, closeOverlay } = panelProps(false, { pinned: true, overlay: SID })
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
    const { props, closeOverlay } = panelProps(false, { pinned: true, overlay: SID })
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
    const overlay = panelProps(false, { pinned: true, overlay: SID })
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
    const { props, closeOverlay } = panelProps(false, { pinned: true, overlay: SID })
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

  it('marks its dock probe to ask the transcript for room while the docking preference is on, whether or not it shows', () => {
    const marked = (container: HTMLElement): boolean => container.querySelector('[data-session-panel-probe]')!.hasAttribute('data-session-panel-reserve')
    const docked = render(<SessionPanel {...panelProps(true, DOCKED).props} />)
    expect(marked(docked.container)).toBe(true)
    // Without room the panel is hidden or an overlay, and the mark stays: the transcript makes room once it can.
    docked.rerender(<SessionPanel {...panelProps(false, DOCKED).props} />)
    expect(marked(docked.container)).toBe(true)
    // The toggle turned docking off: the transcript keeps its place.
    docked.rerender(<SessionPanel {...panelProps(true, { pinned: false, overlay: null }).props} />)
    expect(marked(docked.container)).toBe(false)
  })

  describe('motion', () => {
    const HIDDEN: SessionPanelVisibility = { pinned: false, overlay: null }
    const probeOf = (container: HTMLElement): Element => container.querySelector('[data-session-panel-probe]')!
    const panelOf = (): HTMLElement | null => screen.queryByRole('complementary')
    /**
     * End an element's animation. jsdom's style object has no unprefixed `animation`, so React listens for the
     * prefixed event name there; a browser delivers the unprefixed one.
     */
    const endAnimation = (element: Element): void => {
      for (const type of ['animationend', 'webkitAnimationEnd']) fireEvent(element, new Event(type, { bubbles: true }))
    }
    /** The page does not ask for reduced motion. */
    const allowMotion = (): void => { reducedMotion = false }

    it('plays the entrance when a press shows the panel, marks the probe meanwhile, and ends both with the animation', () => {
      allowMotion()
      const view = render(<SessionPanel {...panelProps(true, HIDDEN).props} />)
      expect(panelOf()).toBeNull()
      view.rerender(<SessionPanel {...panelProps(true, DOCKED).props} />)
      const panel = panelOf()!
      expect(panel.getAttribute('data-session-panel-motion')).toBe('enter')
      expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(true)
      // A row's own animation ending inside the panel does not end the entrance.
      endAnimation(screen.getByText('environment body'))
      expect(panel.getAttribute('data-session-panel-motion')).toBe('enter')
      endAnimation(panel)
      expect(panelOf()).toBe(panel)
      expect(panel.hasAttribute('data-session-panel-motion')).toBe(false)
      expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(false)
    })

    it('keeps a panel a press hid until its exit ends, with the presentation it had, and hands focus to the toggle at once', () => {
      allowMotion()
      const toggle = document.createElement('button')
      toggle.id = `dsh-session-panel-toggle-${SID}`
      document.body.append(toggle)
      try {
        const docked = panelProps(true, DOCKED)
        const view = render(<SessionPanel {...docked.props} />)
        const panel = panelOf()!
        expect(panel.hasAttribute('data-session-panel-motion')).toBe(false)
        screen.getByRole('button', { name: '刷新' }).focus()
        const hidden = panelProps(true, HIDDEN)
        view.rerender(<SessionPanel {...hidden.props} />)
        expect(panelOf()).toBe(panel)
        expect([panel.getAttribute('data-session-panel'), panel.getAttribute('data-session-panel-motion')]).toEqual(['docked', 'exit'])
        expect(hidden.owners.every(owner => owner.presentation === 'docked')).toBe(true)
        expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(true)
        // The docking preference is off, so the transcript takes its room back while the panel leaves.
        expect(probeOf(view.container).hasAttribute('data-session-panel-reserve')).toBe(false)
        expect(document.activeElement).toBe(toggle)
        endAnimation(panel)
        expect(panelOf()).toBeNull()
        expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(false)
      } finally {
        toggle.remove()
      }
    })

    it('plays the exit of a closed overlay without keeping its dismissal, and the entrance again when a press shows it meanwhile', () => {
      allowMotion()
      const open = panelProps(false, { pinned: true, overlay: SID })
      const view = render(<SessionPanel {...open.props} />)
      const panel = panelOf()!
      const closed = panelProps(false, DOCKED)
      view.rerender(<SessionPanel {...closed.props} />)
      expect([panel.getAttribute('data-session-panel'), panel.getAttribute('data-session-panel-motion')]).toEqual(['overlay', 'exit'])
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.pointerDown(document.body)
      expect(closed.closeOverlay).not.toHaveBeenCalled()
      view.rerender(<SessionPanel {...panelProps(false, { pinned: true, overlay: SID }).props} />)
      expect(panelOf()).toBe(panel)
      expect([panel.getAttribute('data-session-panel'), panel.getAttribute('data-session-panel-motion')]).toEqual(['overlay', 'enter'])
    })

    it('shows and hides at once when the room to dock changes, as on a mount, a Session switch, or a resized window', () => {
      allowMotion()
      const view = render(<SessionPanel {...panelProps(false, DOCKED).props} />)
      expect(panelOf()).toBeNull()
      view.rerender(<SessionPanel {...panelProps(true, DOCKED).props} />)
      expect(panelOf()!.hasAttribute('data-session-panel-motion')).toBe(false)
      expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(false)
      view.rerender(<SessionPanel {...panelProps(false, DOCKED).props} />)
      expect(panelOf()).toBeNull()
      // A change of the room while the panel stays hidden changes nothing either.
      view.rerender(<SessionPanel {...panelProps(true, HIDDEN).props} />)
      view.rerender(<SessionPanel {...panelProps(false, HIDDEN).props} />)
      expect(panelOf()).toBeNull()
    })

    it('plays nothing for a reader who asked for reduced motion', () => {
      const view = render(<SessionPanel {...panelProps(true, HIDDEN).props} />)
      view.rerender(<SessionPanel {...panelProps(true, DOCKED).props} />)
      expect(panelOf()!.hasAttribute('data-session-panel-motion')).toBe(false)
      view.rerender(<SessionPanel {...panelProps(true, HIDDEN).props} />)
      expect(panelOf()).toBeNull()
      expect(probeOf(view.container).hasAttribute('data-session-panel-moving')).toBe(false)
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
      // The panel's only button is the control a section put in its own title row.
      expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['刷新'])
      // Environment keeps its place: its title row is no drag source and has no handle.
      expect(headOf('environment').draggable).toBe(false)
      expect(gripOf('environment')).toBeNull()
      const dataTransfer = transfer()
      fireEvent.dragStart(headOf('environment'), { dataTransfer })
      expect(dataTransfer.setData).not.toHaveBeenCalled()
      expect(marks()).toEqual(NONE)
    })

    it.each([
      { rows: 'absent', movable: false, shown: ['text'] },
      { rows: 'empty', movable: false, shown: ['text'] },
      { rows: 'folder', movable: false, shown: ['environment', 'text'] },
      { rows: 'folder', movable: true, shown: ['environment', 'text', 'zero', 'element'] },
      { rows: 'text fallback', movable: false, shown: ['environment', 'text'] },
    ])('shows titles and starts drags only for populated sections (rows: $rows, reorder: $movable)', async ({ rows: content, movable, shown: ids }) => {
      const sheet = document.createElement('style')
      // Vitest supplies the CSS Module class names but does not install their stylesheet in jsdom.
      sheet.textContent = readFileSync(resolve(import.meta.dirname, '../src/client/SessionPanel.module.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replaceAll(':global(', ':is(').replace(/'[^']*'|"[^"]*"|\.([a-zA-Z][\w-]*)/g, (token, local: string | undefined) =>
          local === undefined ? token : `.${panelStyles[local]}`)
      document.head.append(sheet)
      onTestFinished(() => { sheet.remove() })
      const runtime = await SlotTestRuntime.create()
      onTestFinished(() => runtime.dispose())
      await runtime.declare({ 'conversation.chat.aside': { kind: 'single', scope: 'session' } })
      await runtime.sessions.add({ id: SID })
      const session = runtime.sessions.retain(SID)
      onTestFinished(() => { cleanup(); session.release() })
      await session.ready
      const body = 'conversation.session.panel.section'
      const actions = 'conversation.session.panel.section.actions'
      const rows = 'conversation.session.panel.environment.row'
      const sections = ['environment', 'missing', 'jobs', 'text', 'zero', 'element'].map(id => ({ id, label: id }))
      const { props } = panelProps(true, DOCKED)
      runtime.slots.register({ name: 'conversation.chat.aside', children: {
        [body]: { kind: 'list', scope: 'session' }, [actions]: { kind: 'keyed', scope: 'session' },
      } }, ({ renderSlot }) => <SessionPanel {...props} useSections={selectorOf(sections)} renderSlot={renderSlot} />)
      const environment = { name: body, id: 'environment', children: { [rows]: { kind: 'list', scope: 'session' } } } as const
      if (content === 'text fallback') {
        runtime.slots.register(environment, ({ renderSlot, presentation, dismissOverlay }) =>
          renderSlot(rows, { presentation, dismissOverlay }, { fallback: 'No configured rows' }))
      } else {
        runtime.slots.register(environment, EnvironmentSection)
      }
      if (content === 'empty' || content === 'folder') {
        runtime.slots.register({ name: rows, id: 'a' }, () => null)
        runtime.slots.register({ name: rows, id: 'b' }, () => null)
      }
      if (content === 'folder') runtime.slots.register({ name: rows, id: 'folder' }, () => <span />)
      runtime.slots.register({ name: body, id: 'jobs' }, () => null)
      runtime.slots.register({ name: actions, key: 'jobs' }, () => <b>Count</b>)
      runtime.slots.register({ name: body, id: 'text' }, () => 'Text only')
      if (movable) {
        runtime.slots.register({ name: body, id: 'zero' }, () => 0)
        runtime.slots.register({ name: body, id: 'element' }, () => <span />)
      }
      runtime.renderSlot('conversation.chat.aside', {}, { session })
      const shown = screen.getAllByRole('region')
      expect(shown.map(region => region.dataset.sessionPanelSection)).toEqual(ids)
      const start = createEvent.dragStart(headOf('text'))
      Object.defineProperty(start, 'dataTransfer', { value: transfer() })
      fireEvent(headOf('text'), start)
      expect(start.defaultPrevented).toBe(!movable)
      fireEvent.dragEnd(headOf('text'))
    })

    it('starts no drag while only one shown section can move, since it could land nowhere else', () => {
      const { props, moveSection } = threeSections()
      render(<SessionPanel {...props} />)
      // CSS hides a section whose body rendered nothing; here, the other movable one.
      sectionOf('change-requests').style.display = 'none'
      const dataTransfer = transfer()
      const start = createEvent.dragStart(headOf('jobs'))
      Object.defineProperty(start, 'dataTransfer', { value: dataTransfer })
      fireEvent(headOf('jobs'), start)
      expect(start.defaultPrevented).toBe(true)
      expect(dataTransfer.setData).not.toHaveBeenCalled()
      expect(marks()).toEqual(NONE)
      expect(moveSection).not.toHaveBeenCalled()
      // With both shown the drag starts.
      sectionOf('change-requests').style.display = ''
      fireEvent.dragStart(headOf('jobs'), { dataTransfer })
      expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-dsh-session-panel-section', 'jobs')
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
