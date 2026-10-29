// @vitest-environment jsdom
import { createRef, useCallback, useMemo, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useTextInteraction } from '../src/client/chat/text-interaction.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TextInteractionBinding } from '../src/client/chat/text-interaction.ts'
import type { TextInteractionGesture, TextInteractionRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'

const rect = (left: number, top: number, width: number, height: number): DOMRect => new DOMRect(left, top, width, height)
let selectionRect = rect(100, 120, 40, 20)
let resize: () => void

beforeEach(() => {
  selectionRect = rect(100, 120, 40, 20)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => selectionRect })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => Object.assign([selectionRect], { item: (i: number) => i === 0 ? selectionRect : null }) })
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.surface !== undefined) return rect(0, 0, 80, 30)
    if (this.dataset.viewport !== undefined) return rect(20, 80, 400, 300)
    return rect(40, 100, 300, 500)
  })
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Area({ id = 'action', admit, onBinding, enabled = true, composer = false }: {
  enabled?: boolean
  composer?: boolean
  id?: string
  admit?: (request: TextInteractionRequest) => void
  onBinding?: (binding: TextInteractionBinding) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const ids = useMemo(() => enabled ? [id] : [], [enabled, id])
  const dispatch = useCallback((gesture: TextInteractionGesture): string | null => {
    if (!enabled) return null
    let opened = false
    const request: TextInteractionRequest = { ...gesture, sessionId: SessionId(id), open: () => { opened = true } }
    if (admit === undefined) { if (request.trigger === 'selection') request.open() }
    else admit(request)
    return opened ? id : null
  }, [id, admit, enabled])
  const interaction = useTextInteraction(root, surface, dispatch, ids)
  onBinding?.(interaction)
  return <div data-viewport="" data-conversation-scroll="" style={{ overflowX: 'auto', overflowY: 'auto' }}>
    <div ref={root} data-area={id} style={{ position: 'relative' }}>
      <p data-text-interaction-source="">Hello {id}</p>
      <p data-text-interaction-source="">Other text</p>
      <div ref={surface} data-surface="" style={{ position: 'absolute', visibility: 'hidden' }}>
        {interaction.active?.id === id && <button onPointerDown={(event) => { event.preventDefault() }}
          onClick={interaction.dismiss}>{id}</button>}
      </div>
    </div>
    {composer && <div data-composer-seat="">Composer and dock</div>}
  </div>
}

function select(source: Element) {
  const range = document.createRange()
  range.selectNodeContents(source)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  return selection
}

async function layout() {
  await act(async () => { resize(); await new Promise(resolve => requestAnimationFrame(resolve)) })
}

describe('area text interactions', () => {
  it('waits for pointer and keyboard selection to finish', () => {
    const view = render(<Area />)
    const source = view.container.querySelector('[data-text-interaction-source]')!
    fireEvent.pointerDown(source, { button: 0 })
    select(source)
    expect(view.queryByRole('button')).toBeNull()
    fireEvent.pointerUp(document)
    expect(view.getByRole('button', { name: 'action' })).toBeTruthy()
    fireEvent.keyDown(source, { key: 'Shift', shiftKey: true })
    expect(view.queryByRole('button')).toBeNull()
    const range = window.getSelection()!.getRangeAt(0)
    range.setEnd(source.firstChild!, 3)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.keyUp(source, { key: 'Shift' })
    expect(view.getByRole('button')).toBeTruthy()
  })

  it('closes outside without clearing selection or reopening on scroll and resize', async () => {
    const view = render(<><Area /><button>Outside</button></>)
    const selection = select(view.container.querySelector('[data-text-interaction-source]')!)
    const action = view.getByRole('button', { name: 'action' })
    fireEvent.pointerDown(action, { button: 0 })
    expect(view.getByRole('button', { name: 'action' })).toBeTruthy()
    fireEvent.pointerDown(view.getByRole('button', { name: 'Outside' }), { button: 0 })
    expect(view.queryByRole('button', { name: 'action' })).toBeNull()
    expect(selection.toString()).toBe('Hello action')
    fireEvent.pointerUp(document)
    fireEvent(document, new Event('selectionchange'))
    fireEvent.scroll(view.container.querySelector('[data-viewport]')!)
    await layout()
    expect(view.queryByRole('button', { name: 'action' })).toBeNull()
  })

  it('dismisses on Escape, cancellation and blur', () => {
    const view = render(<Area />)
    const sources = view.container.querySelectorAll('[data-text-interaction-source]')
    select(sources[0]!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('button')).toBeNull()
    select(sources[1]!)
    fireEvent.pointerCancel(document)
    expect(view.queryByRole('button')).toBeNull()
    select(sources[0]!)
    fireEvent.blur(window)
    expect(view.queryByRole('button')).toBeNull()
  })

  it('places in content coordinates, flips below at the top and restores after scrolling offscreen', async () => {
    const view = render(<Area />)
    select(view.container.querySelector('[data-text-interaction-source]')!)
    const surface = view.container.querySelector<HTMLElement>('[data-surface]')!
    expect(surface.parentElement?.dataset.area).toBe('action')
    expect(surface.style.left).toBe('40px')
    expect(surface.style.top).toBe('-18px')
    selectionRect = rect(100, 90, 40, 20)
    await layout()
    expect(surface.style.top).toBe('18px')
    selectionRect = rect(100, 10, 40, 20)
    fireEvent.scroll(view.container.querySelector('[data-viewport]')!)
    await layout()
    expect(view.queryByRole('button')).toBeNull()
    expect(surface.querySelector('button')).not.toBeNull()
    selectionRect = rect(100, 120, 40, 20)
    fireEvent.scroll(view.container.querySelector('[data-viewport]')!)
    await layout()
    expect(view.getByRole('button')).toBeTruthy()
    expect(surface.style.top).toBe('-18px')
  })

  it('hides behind the composer and its dock, restores on resize, and keeps explicit dismissal final', async () => {
    const view = render(<Area composer />)
    const composer = view.container.querySelector<HTMLElement>('[data-composer-seat]')!
    let composerTop = 260
    composer.getBoundingClientRect = () => rect(20, composerTop, 400, 380 - composerTop)
    const source = view.container.querySelector('[data-text-interaction-source]')!
    const selection = select(source)
    const surface = view.container.querySelector<HTMLElement>('[data-surface]')!
    const action = surface.querySelector('button')!
    selectionRect = rect(100, 280, 40, 20)
    await layout()
    expect(surface.style.visibility).toBe('hidden')
    expect(surface.querySelector('button')).toBe(action)
    expect(selection.toString()).toBe('Hello action')
    composerTop = 330
    await layout()
    expect(view.getByRole('button')).toBe(action)
    composerTop = 260
    await layout()
    expect(surface.style.visibility).toBe('hidden')
    fireEvent.pointerDown(composer, { button: 0 })
    composerTop = 330
    await layout()
    expect(surface.querySelector('button')).toBeNull()
  })

  it('invalidates changed, disabled and removed sources', async () => {
    const view = render(<Area />)
    const sources = view.container.querySelectorAll<HTMLElement>('[data-text-interaction-source]')
    select(sources[0]!)
    sources[0]!.firstChild!.textContent = 'Changed text'
    await layout()
    expect(view.queryByRole('button')).toBeNull()
    select(sources[1]!)
    sources[1]!.removeAttribute('data-text-interaction-source')
    await layout()
    expect(view.queryByRole('button')).toBeNull()
    select(sources[0]!)
    sources[0]!.remove()
    await layout()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('isolates areas and removes listeners on unmount', () => {
    const view = render(<><Area id="first" /><Area id="second" /></>)
    const areas = view.container.querySelectorAll('[data-area]')
    select(areas[0]!.querySelector('[data-text-interaction-source]')!)
    expect(view.getByRole('button', { name: 'first' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'second' })).toBeNull()
    select(areas[1]!.querySelector('[data-text-interaction-source]')!)
    expect(view.queryByRole('button', { name: 'first' })).toBeNull()
    expect(view.getByRole('button', { name: 'second' })).toBeTruthy()
    view.unmount()
    fireEvent(document, new Event('selectionchange'))
    expect(document.querySelector('[data-surface]')).toBeNull()
  })

  it('leaves contextmenu defaults to the registrant and never reuses an unrelated selection', () => {
    const admit = vi.fn((request: TextInteractionRequest) => {
      if (request.trigger === 'contextmenu') { request.preventDefault(); request.open() }
    })
    const view = render(<Area admit={admit} />)
    const sources = view.container.querySelectorAll('[data-text-interaction-source]')
    select(sources[0]!)
    const same = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 110, clientY: 130 })
    fireEvent(sources[0]!, same)
    expect(same.defaultPrevented).toBe(true)
    expect(admit.mock.lastCall![0].readText()).toBe('Hello action')
    const other = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 110, clientY: 130 })
    fireEvent(sources[1]!, other)
    expect(admit.mock.lastCall![0].hasSelection).toBe(false)
    expect(admit.mock.lastCall![0].readText()).toBeNull()
    view.rerender(<Area />)
    expect(view.queryByRole('button')).toBeNull()
    const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 110, clientY: 130 })
    fireEvent(sources[0]!, native)
    expect(native.defaultPrevented).toBe(false)
    expect(view.queryByRole('button')).toBeNull()
  })
})


describe('text interaction lifecycle', () => {
  it('exposes DOM text only while the captured source remains usable', () => {
    let binding: TextInteractionBinding | undefined
    const view = render(<Area onBinding={(value) => { binding = value }} />)
    expect(binding!.readText()).toBeNull()
    const source = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const selection = select(source)
    expect(binding!.readText()).toBe('Hello action')
    source.hidden = true
    expect(binding!.readText()).toBeNull()
    source.hidden = false
    source.removeAttribute('data-text-interaction-source')
    expect(binding!.readText()).toBeNull()
    source.setAttribute('data-text-interaction-source', '')
    act(() => { binding!.clearSelection(); binding!.dismiss() })
    expect(selection.isCollapsed).toBe(true)
    expect(view.queryByRole('button')).toBeNull()
    expect(binding!.readText()).toBeNull()
    view.unmount()
    expect(binding!.readText()).toBeNull()
    binding!.clearSelection()
  })

  it('supports an unmounted area', () => {
    const root = createRef<HTMLDivElement>()
    const surface = createRef<HTMLDivElement>()
    const hook = renderHook(() => useTextInteraction(root, surface, () => null, []))
    expect(hook.result.current.readText()).toBeNull()
    act(() => { hook.result.current.dismiss(); hook.result.current.clearSelection() })
  })

  it('dismisses a surface when its plugin unregisters', () => {
    const view = render(<Area />)
    select(view.container.querySelector('[data-text-interaction-source]')!)
    expect(view.getByRole('button')).toBeTruthy()
    view.rerender(<Area enabled={false} />)
    expect(view.queryByRole('button')).toBeNull()
  })

  it('opens context menus without cancelling defaults unless the consumer requests it', () => {
    let binding: TextInteractionBinding | undefined
    const view = render(<Area onBinding={(value) => { binding = value }} admit={(request) => { request.open() }} />)
    const source = view.container.querySelector('[data-text-interaction-source]')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    fireEvent(source, event)
    expect(event.defaultPrevented).toBe(false)
    expect(view.getByRole('button')).toBeTruthy()
    expect(binding!.readText()).toBeNull()
    // Menu focus may collapse browser selection without closing the captured interaction.
    view.getByRole('button').focus()
    fireEvent(document, new Event('selectionchange'))
    expect(view.getByRole('button')).toBeTruthy()
    fireEvent.contextMenu(view.getByRole('button'))
    expect(view.getByRole('button')).toBeTruthy()
  })

  it('keeps a focused selection action open and ignores unrelated keys', () => {
    const view = render(<Area />)
    const source = view.container.querySelector('[data-text-interaction-source]')!
    select(source)
    const button = view.getByRole('button')
    button.focus()
    fireEvent(document, new Event('selectionchange'))
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    fireEvent.keyDown(document, { key: 'Shift' })
    fireEvent.keyUp(document, { key: 'a' })
    expect(view.getByRole('button')).toBeTruthy()
    button.blur()
    fireEvent.keyDown(source, { key: 'ArrowLeft' })
    fireEvent.keyDown(source, { key: 'Shift', shiftKey: true })
    fireEvent.keyUp(source, { key: 'ArrowLeft', shiftKey: true })
    expect(view.queryByRole('button')).toBeNull()
    fireEvent.keyUp(source, { key: 'Shift' })
  })

  it('does not admit blank or hidden selections, controls, or unmarked right-click targets', () => {
    const admit = vi.fn((request: TextInteractionRequest) => { request.open() })
    const view = render(<Area admit={admit} />)
    const source = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    source.textContent = '   '
    select(source)
    expect(admit).not.toHaveBeenCalled()
    source.textContent = 'visible words'
    source.style.display = 'none'
    select(source)
    expect(admit).not.toHaveBeenCalled()
    fireEvent.contextMenu(source)
    expect(admit).not.toHaveBeenCalled()
    source.style.display = ''
    source.innerHTML = '<button>control</button>'
    fireEvent.contextMenu(source.firstElementChild!)
    fireEvent.contextMenu(source.firstElementChild!.firstChild!)
    fireEvent.contextMenu(view.container.querySelector('[data-area]')!)
    expect(admit).not.toHaveBeenCalled()
  })

  it('invalidates folded ancestors and handles scaled positioning containers', async () => {
    const view = render(<Area />)
    const area = view.container.querySelector<HTMLElement>('[data-area]')!
    const source = area.querySelector('[data-text-interaction-source]')!
    Object.defineProperties(area, { offsetWidth: { value: 150 }, offsetHeight: { value: 250 } })
    select(source)
    const surface = area.querySelector<HTMLElement>('[data-surface]')!
    expect(surface.style.left).toBe('20px')
    expect(surface.style.top).toBe('-9px')
    area.style.visibility = 'hidden'
    await layout()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('keeps a context-menu point attached to its source through scrolling and reflow', async () => {
    const view = render(<Area admit={(request) => { if (request.trigger === 'contextmenu') request.open() }} />)
    const source = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    let sourceTop = 100
    source.getBoundingClientRect = () => rect(40, sourceTop, 300, 500)
    fireEvent.contextMenu(source, { clientX: 110, clientY: 130 })
    const surface = view.container.querySelector<HTMLElement>('[data-surface]')!
    expect(surface.style.top).toBe('39px')
    sourceTop = 80
    await layout()
    expect(surface.style.top).toBe('19px')
    source.scrollTop = 5
    fireEvent.scroll(source)
    await layout()
    expect(surface.style.top).toBe('14px')
  })

  it('cancels scheduled placement when an active area unmounts', () => {
    const view = render(<Area />)
    select(view.container.querySelector('[data-text-interaction-source]')!)
    fireEvent.scroll(view.container.querySelector('[data-viewport]')!)
    resize()
    view.unmount()
    expect(document.querySelector('[data-surface]')).toBeNull()
  })
})
