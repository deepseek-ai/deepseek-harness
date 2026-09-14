/** @vitest-environment jsdom */
/** Viewer ownership and interaction tests; browser checks cover native modal focus and SVG layout. */
import assert from 'node:assert/strict'
import type { PanzoomOptions } from '@panzoom/panzoom'
import { getByRole, queryAllByRole, queryByRole, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMermaidViewer, type MermaidViewer } from '../.vitepress/theme/mermaid-viewer.ts'

const panzoom = vi.hoisted(() => ({
  create: vi.fn<(element: HTMLElement, options: PanzoomOptions) => unknown>(),
  destroy: vi.fn(), setOptions: vi.fn(), zoom: vi.fn(), pan: vi.fn(),
  zoomIn: vi.fn(), zoomOut: vi.fn(), zoomWithWheel: vi.fn(), getScale: vi.fn<() => number>(),
}))
vi.mock('@panzoom/panzoom', () => ({ default: panzoom.create }))

let viewer: MermaidViewer | undefined
let resize: (() => void) | undefined
let viewportWidth = 1032
let viewportHeight = 632
const disconnect = vi.fn()
const dialogMethods = new Map(['showModal', 'close'].map(name => [
  name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
]))

beforeEach(() => {
  vi.clearAllMocks()
  panzoom.create.mockImplementation((_element, options) => {
    panzoom.getScale.mockReturnValue(options.startScale ?? 1)
    return panzoom
  })
  viewportWidth = 1032
  viewportHeight = 632
  document.body.innerHTML = '<main id="VPContent" class="vp-doc"><div class="mermaid"></div></main>'
  document.body.style.overflow = 'auto'
  vi.spyOn(SVGSVGElement.prototype, 'viewBox', 'get').mockImplementation(function (this: SVGSVGElement) {
    const [x, y, width, height] = (this.getAttribute('viewBox') ?? '0 0 0 0').split(' ').map(Number)
    return { baseVal: { x, y, width, height } } as SVGAnimatedRect
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewportWidth)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = true
    this.querySelector<HTMLButtonElement>('[autofocus]')?.focus()
  } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  } })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe(): void {}
    disconnect = disconnect
  })
})

afterEach(() => {
  viewer?.dispose()
  viewer = undefined
  resize = undefined
  document.body.replaceChildren()
  document.body.style.overflow = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

function required<T>(value: T | null | undefined): T {
  assert(value != null)
  return value
}

function render(viewBox = '0 0 2000 3000'): SVGSVGElement {
  const container = required(document.querySelector('.mermaid'))
  container.innerHTML = `<svg id="diagram" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/></svg>`
  return required(container.querySelector('svg'))
}

function open(): HTMLDialogElement {
  getByRole(document.body, 'button', { name: 'View diagram fullscreen' }).click()
  return getByRole(document.body, 'dialog', { name: 'Diagram viewer' }) as HTMLDialogElement
}

describe('documentation Mermaid viewer', () => {
  it.each([
    { heading: 'Agent lifecycle', language: 'en-US', expected: 'Agent lifecycle' },
    { heading: '  \n  ', language: 'zh-CN', expected: '图表查看器' },
    { heading: null, language: 'en-US', expected: 'Diagram viewer' },
  ])('uses the visible title as the dialog name for $heading', ({ heading, language, expected }) => {
    render()
    if (heading !== null) {
      const h1 = document.createElement('h1')
      h1.textContent = heading
      required(document.querySelector('.vp-doc')).prepend(h1)
    }
    viewer = installMermaidViewer(document, () => language)
    getByRole(document.body, 'button').click()
    const dialog = getByRole(document.body, 'dialog', { name: expected })
    const title = required(document.getElementById(required(dialog.getAttribute('aria-labelledby'))))
    expect(title.textContent).toBe(expected)
  })

  it('adds one entry only after an SVG with usable dimensions renders', async () => {
    viewer = installMermaidViewer(document, () => 'en-US')
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
    render('0 0 0 3000')
    viewer.refresh()
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
    render()
    await waitFor(() => {
      expect(queryAllByRole(document.body, 'button')).toHaveLength(1)
    })
    viewer.refresh()
    expect(queryAllByRole(document.body, 'button')).toHaveLength(1)
    expect(required(document.querySelector('.mermaid')).firstElementChild?.tagName).toBe('BUTTON')
    const trigger = getByRole(document.body, 'button', { name: 'View diagram fullscreen' })
    expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(getByRole(document.body, 'button', { name: 'View diagram fullscreen' })).toBe(trigger)
  })

  it('fits the natural SVG into the viewport and isolates copied styles and fragment IDs', () => {
    const source = render()
    const original = source.outerHTML
    viewer = installMermaidViewer(document, () => 'en-US')
    const dialog = open()
    expect(panzoom.create.mock.calls[0]?.[1]).toMatchObject({ startScale: 0.2, minScale: 0.1 })
    const paper = required(dialog.querySelector<HTMLElement>('.dsh-diagram-paper'))
    const clone = required(paper.shadowRoot?.querySelector('svg'))
    expect(clone.style.width).toBe('2000px')
    expect(clone.style.height).toBe('3000px')
    expect(paper.shadowRoot?.querySelector('path')?.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(document.querySelectorAll('#diagram')).toHaveLength(1)
    expect(source.outerHTML).toBe(original)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('')
    required(resize)()
    expect(panzoom.zoom).toHaveBeenLastCalledWith(0.2, { animate: false })
    expect(panzoom.pan).toHaveBeenLastCalledWith(0, 0, { animate: false })
    viewportWidth = 332
    viewportHeight = 932
    required(resize)()
    expect(panzoom.zoom).toHaveBeenLastCalledWith(0.15, { animate: false })
    expect(panzoom.pan).toHaveBeenLastCalledWith(0, 0, { animate: false })
  })

  it('connects zoom, wheel, keyboard panning and fit without dismissing a canvas click', () => {
    render()
    viewer = installMermaidViewer(document, () => 'en-US')
    const dialog = open()
    getByRole(dialog, 'button', { name: 'Zoom in' }).click()
    getByRole(dialog, 'button', { name: 'Zoom out' }).click()
    expect(panzoom.zoomIn).toHaveBeenCalledOnce()
    expect(panzoom.zoomOut).toHaveBeenCalledOnce()
    const viewport = required(dialog.querySelector<HTMLElement>('.dsh-diagram-viewport'))
    const wheel = new WheelEvent('wheel', { deltaY: -100 })
    viewport.dispatchEvent(wheel)
    expect(panzoom.zoomWithWheel).toHaveBeenCalledWith(wheel)
    panzoom.getScale.mockReturnValue(2)
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(panzoom.pan).toHaveBeenLastCalledWith(-32, 0, { relative: true, animate: false })
    getByRole(dialog, 'button', { name: 'Fit view' }).click()
    expect(panzoom.zoom).toHaveBeenLastCalledWith(0.2, { animate: false })
    expect(panzoom.pan).toHaveBeenLastCalledWith(0, 0, { animate: false })
    viewport.click()
    expect(dialog.open).toBe(true)
  })

  it('wraps keyboard focus through the viewer controls in both directions', () => {
    render()
    viewer = installMermaidViewer(document, () => 'en-US')
    const dialog = open()
    const close = getByRole(dialog, 'button', { name: 'Close' })
    const zoomOut = getByRole(dialog, 'button', { name: 'Zoom out' })
    close.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(zoomOut)
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
    expect(document.activeElement).toBe(close)
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
    expect(document.activeElement).toBe(getByRole(dialog, 'button', { name: 'Viewer help' }))
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(close)
  })

  it('shows zoom changes and reveals help on demand without retaining listeners after close', () => {
    render()
    viewer = installMermaidViewer(document, () => 'en-US')
    const dialog = open()
    const scale = required(dialog.querySelector('.dsh-diagram-scale'))
    const paper = required(dialog.querySelector('.dsh-diagram-paper'))
    expect(scale.textContent).toBe('20%')
    panzoom.getScale.mockReturnValue(0.75)
    paper.dispatchEvent(new Event('panzoomchange'))
    expect(scale.textContent).toBe('75%')
    const toggle = getByRole(dialog, 'button', { name: 'Viewer help' })
    const help = required(document.getElementById(required(toggle.getAttribute('aria-controls'))))
    expect(help.hidden).toBe(true)
    toggle.click()
    expect(help.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click()
    expect(help.hidden).toBe(true)
    getByRole(dialog, 'button', { name: 'Close' }).click()
    toggle.click()
    expect(help.hidden).toBe(true)
    panzoom.getScale.mockReturnValue(1.5)
    paper.dispatchEvent(new Event('panzoomchange'))
    expect(scale.textContent).toBe('75%')
  })

  it.each(['button', 'cancel', 'refresh', 'dispose'] as const)('releases resources on %s and restores focus and scrolling', (method) => {
    render()
    viewer = installMermaidViewer(document, () => 'en-US')
    const trigger = getByRole(document.body, 'button')
    const dialog = open()
    const zoom = getByRole(dialog, 'button', { name: 'Zoom in' })
    if (method === 'button') getByRole(dialog, 'button', { name: 'Close' }).click()
    else if (method === 'cancel') dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    else viewer[method]()
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('auto')
    expect(panzoom.destroy).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    zoom.click()
    expect(panzoom.zoomIn).not.toHaveBeenCalled()
    if (method !== 'dispose') expect(document.activeElement).toBe(trigger)
    viewer.dispose()
    expect(panzoom.destroy).toHaveBeenCalledOnce()
  })

  it('closes a replaced diagram and permits repeated opens with the updated locale', async () => {
    render()
    let locale = 'en-US'
    viewer = installMermaidViewer(document, () => locale)
    open()
    render('0 0 400 200')
    await waitFor(() => {
      expect(queryByRole(document.body, 'dialog')).toBeNull()
    })
    expect(panzoom.destroy).toHaveBeenCalledOnce()
    open()
    locale = 'zh-CN'
    viewer.refresh()
    getByRole(document.body, 'button', { name: '全屏查看图表' }).click()
    expect(getByRole(document.body, 'dialog', { name: '图表查看器' })).toBeTruthy()
    getByRole(document.body, 'button', { name: '关闭' }).click()
    expect(panzoom.destroy).toHaveBeenCalledTimes(3)
  })

  it('closes when route content is removed and stops enhancing after disposal', async () => {
    render()
    viewer = installMermaidViewer(document, () => 'en-US')
    open()
    required(document.querySelector('.mermaid')).remove()
    await waitFor(() => {
      expect(queryByRole(document.body, 'dialog')).toBeNull()
    })
    expect(document.body.style.overflow).toBe('auto')
    viewer.dispose()
    required(document.querySelector('main')).innerHTML = '<div class="mermaid"></div>'
    render()
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
  })
})
