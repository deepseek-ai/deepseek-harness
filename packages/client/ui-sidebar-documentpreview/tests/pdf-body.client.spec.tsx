// @vitest-environment jsdom
/** PDF controls and stale-completion guards with real tab view state and controlled document loads. */
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { PdfDocument } from '../src/client/pdf/document.ts'
import type { renderPdfPage } from '../src/client/pdf/document.ts'
import type { openPdf } from '../src/client/pdf/runtime.ts'
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'

const engine = vi.hoisted(() => ({ open: vi.fn<typeof openPdf>(), render: vi.fn<typeof renderPdfPage>() }))
const overlay = vi.hoisted(() => ({ create: vi.fn(), render: vi.fn(), cancel: vi.fn() }))
vi.mock('../src/client/pdf/text.ts', () => ({ pdfTextRenderer: (host: HTMLDivElement) => { overlay.create(host); return overlay.render } }))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: engine.open }))
vi.mock('../src/client/pdf/document.ts', () => ({ renderPdfPage: engine.render }))
import { PdfBody, type PdfBodyProps } from '../src/client/pdf/pdf.tsx'
import { createPdfStore, type PdfState } from '../src/client/pdf/store.ts'
import { en } from '../src/client/pdf/locales.ts'
import { LoadingIndicator } from '../src/client/LoadingIndicator.tsx'
import { PdfWorkerFailure } from '../src/client/pdf/errors.ts'
import { ZoomViewport, zoomSurfaceClass } from '../src/client/zoom/ZoomViewport.tsx'

const loads: Array<{
  deferred: ReturnType<typeof Promise.withResolvers<PdfDocument>>
  dispose: ReturnType<typeof vi.fn>
}> = []

beforeEach(() => {
  // Keep the 100px fixture pages at actual size inside the document gutters.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(124)
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage: () => {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
  loads.length = 0
  engine.open.mockReset().mockImplementation(() => {
    const deferred = Promise.withResolvers<PdfDocument>()
    const dispose = vi.fn(async () => {})
    loads.push({ deferred, dispose })
    return { document: deferred.promise, dispose }
  })
  engine.render.mockReset().mockImplementation(async (_document, _page, canvas, _signal, ratio) => {
    canvas.width = canvas.height = 100 * ratio
    return { width: 100, height: 100 }
  })
  overlay.create.mockReset()
  overlay.render.mockReset()
  overlay.cancel.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void { this.disconnected = true; this.observed.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  intersect(element: Element, isIntersecting: boolean): void {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

function harness() {
  const instance = createPdfStore().create()
  const controller = new AbortController()
  const tabId = 'pdf-tab' as TabId
  const subscribe = (listener: () => void) => instance.subscribe(listener)
  const snapshot = () => instance.getSnapshot()
  function useStore<T>(selector: (state: PdfState) => T): T {
    return selector(useSyncExternalStore(subscribe, snapshot))
  }
  const scrollportRef = vi.fn()
  function View({ data = 'one', kind = 'bytes' }: {
    readonly data?: string
    readonly kind?: 'bytes' | 'text'
  }) {
    const bytes = useMemo(() => new TextEncoder().encode(data), [data])
    // The PDF body reads these standard seats; the remaining framework seats are unused here.
    const props = {
      resourceAddress: 'dsh-resource://file/session/s/report.pdf',
      content: kind === 'bytes' ? { kind, data: bytes } : { kind, text: '', pages: [], eof: true }, wrap: false,
      useTabInfo: () => ({ tab: { id: tabId, signal: controller.signal } }),
      useStore, actions: instance.actions, retainTab: vi.fn(), t: makeTranslate(en),
    } as unknown as PdfBodyProps
    return <PdfBody {...props} loading={<LoadingIndicator label={en.loading} />} scrollportRef={scrollportRef}
      ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass} />
  }
  return { instance, controller, tabId, scrollportRef, View }
}

const documentOf = (numPages = 3): PdfDocument => ({ numPages, getPage: vi.fn() })

describe('PDF body', () => {
  it('reports non-byte contents without starting PDF.js', () => {
    const h = harness()
    render(<h.View kind="text" />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(engine.open).not.toHaveBeenCalled()
  })

  it('does not start a load for a tab record that has already ended', () => {
    const h = harness()
    h.controller.abort()
    render(<h.View />)
    expect(engine.open).not.toHaveBeenCalled()
  })

  it('shows loading, adds zoom controls, and renders a continuous page sequence', async () => {
    const h = harness()
    const view = render(<h.View />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Rendering document...')
    expect(screen.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    expect(screen.getByRole('status').querySelector('[data-state="ongoing"]')).not.toBeNull()
    await act(async () => { loads[0]!.deferred.resolve(documentOf()) })
    await act(async () => {})
    expect(screen.getByRole('toolbar', { name: 'Zoom controls' })).toBeTruthy()
    expect([...view.container.querySelectorAll('[data-pdf-page]')].map(page => page.getAttribute('data-pdf-page')))
      .toEqual(['1', '2', '3'])
    expect(screen.getAllByRole('img').map(image => image.getAttribute('aria-label')))
      .toEqual(['PDF page 1', 'PDF page 2', 'PDF page 3'])
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2, 3])
  })

  it('offers retained PDF zoom presets', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    expect(h.scrollportRef).toHaveBeenLastCalledWith(view.container.querySelector('[data-document-zoom-scrollport]'))
    expect(screen.getByRole('toolbar', { name: 'Zoom controls' })).toBeTruthy()
    const menu = screen.getByRole('button', { name: 'Choose zoom' })
    expect(fireEvent.mouseDown(menu)).toBe(false)
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: '100%' }))
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
    expect(h.instance.getSnapshot().byTab[h.tabId]).toEqual({ page: 1, zoom: { kind: 'fixed', scale: 1.5 } })
    expect((view.container.querySelector('[data-document-zoom-frame]') as HTMLElement)
      .style.getPropertyValue('--document-zoom')).toBe('1.5')
    const out = screen.getByRole('button', { name: 'Zoom out' })
    expect(fireEvent.mouseDown(out)).toBe(false)
    fireEvent.click(out)
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: 1.25 })
    const into = screen.getByRole('button', { name: 'Zoom in' })
    expect(fireEvent.mouseDown(into)).toBe(false)
    fireEvent.click(into)
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: 1.5 })
    act(() => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 1.657 }) })
    fireEvent.click(out)
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: 1.5 })
    act(() => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 1.657 }) })
    fireEvent.click(into)
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: 1.75 })
    fireEvent.click(menu)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 4 }) })
    expect(screen.getByRole('button', { name: 'Zoom in' }).hasAttribute('disabled')).toBe(true)
    act(() => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 0.25 }) })
    expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<h.View />)
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('25%')
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fit-width' })
  })

  it('zooms a trackpad gesture around its pointer and leaves ordinary scrolling alone', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const scrollport = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLDivElement
    Object.defineProperties(scrollport, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 400 },
    })
    scrollport.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 420,
      width: 300, height: 400, toJSON: () => ({}) })
    scrollport.scrollLeft = 40
    scrollport.scrollTop = 80
    fireEvent.wheel(scrollport, { deltaY: 20, clientX: 60, clientY: 70 })
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBeUndefined()
    vi.useFakeTimers()
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaY: -10, clientX: 60, clientY: 70 })
    const controls = view.container.querySelector('[data-document-zoom-controls]') as HTMLElement
    const rendersBeforeGesture = engine.render.mock.calls.length
    expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)
    expect(scrollport.dispatchEvent(event)).toBe(false)
    await act(async () => {})
    expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toBeUndefined()
    expect(engine.render).toHaveBeenCalledTimes(rendersBeforeGesture)
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('111%')
    expect((view.container.querySelector('[data-document-zoom-frame]') as HTMLElement)
      .style.getPropertyValue('--document-zoom')).toBe(String(Math.exp(0.1)))
    expect(scrollport.scrollLeft).toBeCloseTo((40 + 50) * Math.exp(0.1) - 50)
    expect(scrollport.scrollTop).toBeCloseTo((80 + 50) * Math.exp(0.1) - 50)
    act(() => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 1.5 }) })
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('111%')
    expect((view.container.querySelector('[data-document-zoom-frame]') as HTMLElement)
      .style.getPropertyValue('--document-zoom')).toBe(String(Math.exp(0.1)))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    const zoom = h.instance.getSnapshot().byTab[h.tabId]?.zoom
    expect(zoom?.kind).toBe('fixed')
    if (zoom?.kind !== 'fixed') throw new Error('pinch did not commit a fixed zoom')
    expect(zoom.scale).toBeCloseTo(Math.exp(0.1))
    const committed = zoom.scale
    expect(engine.render).toHaveBeenCalledTimes(rendersBeforeGesture + 1)
    expect(engine.render.mock.calls.at(-1)![4]).toBeCloseTo(window.devicePixelRatio * committed)
    await act(async () => { await vi.advanceTimersByTimeAsync(419) })
    expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(controls.hasAttribute('data-document-zoom-visible')).toBe(false)
    scrollport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1, clientX: 60, clientY: 70 }))
    await act(async () => {})
    expect(controls.getAttribute('data-document-zoom-visible')).toBe('true')
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: committed })
    view.unmount()
    expect(h.instance.getSnapshot().byTab[h.tabId]?.zoom).toEqual({ kind: 'fixed', scale: committed })
  })

  it('does not restore a pending gesture after its tab closes', async () => {
    vi.useFakeTimers()
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const scrollport = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLDivElement
    scrollport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PAGE, deltaY: -1 }))
    act(() => { h.controller.abort() })
    scrollport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(h.instance.getSnapshot().byTab[h.tabId]).toBeUndefined()
    view.unmount()
    expect(h.instance.getSnapshot().byTab[h.tabId]).toBeUndefined()
  })

  it('redraws only nearby pages and refreshes a retained page when it returns at the new zoom', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(3)) })
    const first = view.container.querySelector('[data-pdf-page="1"]') as HTMLElement
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    const firstCanvas = first.querySelector('canvas')!
    const secondCanvas = second.querySelector('canvas')!
    const firstObserver = IntersectionObserverStub.instances.find(instance => instance.observed.has(firstCanvas))!
    const placeholderObserver = IntersectionObserverStub.instances.find(instance => instance.observed.has(second))!
    await act(async () => { placeholderObserver.intersect(second, true) })
    const secondObserver = IntersectionObserverStub.instances.find(instance => instance.observed.has(secondCanvas))!
    act(() => { secondObserver.intersect(secondCanvas, false) })
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 2 }) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2, 1])
    expect(first.querySelector('canvas')!.width).toBe(200 * window.devicePixelRatio)
    expect(second.querySelector('canvas')!.width).toBe(100 * window.devicePixelRatio)
    await act(async () => { firstObserver.intersect(firstCanvas, false); secondObserver.intersect(secondCanvas, true) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2, 1, 2])
    expect(second.querySelector('canvas')!.width).toBe(200 * window.devicePixelRatio)
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 1 }) })
    expect(second.querySelector('canvas')!.width).toBe(100 * window.devicePixelRatio)
  })

  it('retains the displayed page while cancelling and joining superseded zoom renders', async () => {
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    const obsolete = Promise.withResolvers<{ width: number; height: number }>()
    const latest = Promise.withResolvers<{ width: number; height: number }>()
    engine.render.mockImplementationOnce((_document, _page, buffer) => {
      buffer.width = buffer.height = 200
      return obsolete.promise
    }).mockImplementationOnce((_document, _page, buffer) => {
      buffer.width = buffer.height = 300
      return latest.promise
    })
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 2 }) })
    expect(canvas.width).toBe(100)
    expect(screen.getByRole('img')).toBe(canvas)
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 3 }) })
    expect(engine.render.mock.calls[1]![3].aborted).toBe(true)
    expect(engine.render).toHaveBeenCalledTimes(2)
    await act(async () => { obsolete.resolve({ width: 100, height: 100 }) })
    expect(engine.render).toHaveBeenCalledTimes(3)
    expect(canvas.width).toBe(100)
    await act(async () => { latest.resolve({ width: 100, height: 100 }) })
    expect(canvas.width).toBe(300)
    expect(canvas.style.getPropertyValue('--pdf-page-width')).toBe('100px')
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('keeps the replacement document when the previous load settles late', async () => {
    const h = harness()
    const mounted = render(<h.View data="old" />)
    mounted.rerender(<h.View data="new" />)
    expect(loads[0]!.dispose).toHaveBeenCalledOnce()
    const latest = documentOf(2)
    await act(async () => { loads[1]!.deferred.resolve(latest) })
    await act(async () => { loads[0]!.deferred.resolve(documentOf(99)) })
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(engine.render.mock.calls.every(([document]) => document === latest)).toBe(true)
  })

  it('mounts selectable text with the page and cancels it when the body unmounts', async () => {
    const pdfPage = { pageNumber: 1 } as PDFPageProxy
    const viewport = { width: 100, height: 100, scale: 1 } as PageViewport
    overlay.render.mockReturnValue({ promise: Promise.resolve(), cancel: overlay.cancel })
    engine.render.mockImplementation(async (_document, _number, _canvas, _signal, _ratio, renderText) => {
      await renderText?.(pdfPage, viewport).promise
      return { width: viewport.width, height: viewport.height }
    })
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    expect(overlay.create).toHaveBeenCalledExactlyOnceWith(view.container.querySelector('[data-pdf-text]'))
    expect(overlay.render).toHaveBeenCalledExactlyOnceWith(pdfPage, viewport)
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeDefined()
    expect(overlay.cancel).not.toHaveBeenCalled()
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 2 }) })
    expect(overlay.render).toHaveBeenCalledOnce()
    expect(overlay.cancel).not.toHaveBeenCalled()
    view.unmount()
    expect(overlay.cancel).toHaveBeenCalledOnce()
  })

  it('shows localized load errors and retries without replacing the file resource', async () => {
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.reject(new Error('invalid PDF')) })
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: invalid PDF')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { loads[1]!.deferred.resolve(documentOf(1)) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
    expect(engine.open.mock.calls.map(([data]) => new TextDecoder().decode(data))).toEqual(['one', 'one'])
  })

  it('reports password protection in the renderer locale', async () => {
    const h = harness()
    render(<h.View />)
    const password = new Error('encrypted')
    password.name = 'PasswordException'
    await act(async () => { loads[0]!.deferred.reject(password) })
    expect(screen.getByRole('alert').textContent).toContain(en.password)
  })

  it('renders later pages only when they approach the viewport and records the reached page', async () => {
    IntersectionObserverStub.instances = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(3)) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1])
    const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement
    const observer = IntersectionObserverStub.instances.find(instance => instance.observed.has(second))!
    act(() => { observer.intersect(second, false) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1])
    await act(async () => { observer.intersect(second, true) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2])
    expect(h.instance.getSnapshot().byTab[h.tabId]?.page).toBe(2)
    expect(screen.getByRole('img', { name: 'PDF page 2' })).toBeTruthy()
    view.unmount()
    expect(IntersectionObserverStub.instances.every(instance => instance.disconnected)).toBe(true)
    act(() => { observer.intersect(second, true) })
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2])
  })

  it('ignores successful and failed page renders after their body unmounts', async () => {
    const success = Promise.withResolvers<{ width: number; height: number }>()
    const failure = Promise.withResolvers<{ width: number; height: number }>()
    engine.render.mockReturnValueOnce(success.promise).mockReturnValueOnce(failure.promise)
    const h = harness()
    const view = render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(2)) })
    const signals = engine.render.mock.calls.map(([, , , signal]) => signal)
    expect(signals).toHaveLength(2)
    view.unmount()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await act(async () => {
      success.resolve({ width: 100, height: 100 })
      failure.reject(new Error('late render failure'))
      await Promise.allSettled([success.promise, failure.promise])
    })
    expect(view.container.childElementCount).toBe(0)
  })

  it('renders a structured Worker failure through its own locale', async () => {
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf()) })
    act(() => { engine.open.mock.calls[0]![2](new PdfWorkerFailure(new MessageEvent('messageerror'))) })
    expect(screen.getByRole('alert').textContent).toContain(en.workerFailed)
    expect(screen.getByRole('alert').textContent).not.toContain('message could not be decoded')
  })

  it('ignores a previous document rejection and failure callback after its content is replaced', async () => {
    const h = harness()
    const mounted = render(<h.View data="old" />)
    mounted.rerender(<h.View data="new" />)
    await act(async () => { loads[1]!.deferred.resolve(documentOf(2)) })
    await act(async () => {
      loads[0]!.deferred.reject(new Error('late parsing error'))
      engine.open.mock.calls[0]![2](new PdfWorkerFailure(new ErrorEvent('error')))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })

  it('shows a foreign render rejection and retries that page', async () => {
    engine.render.mockRejectedValueOnce('foreign rendering failure')
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    expect(screen.getByRole('alert').textContent).toContain('Cannot display PDF: foreign rendering failure')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: 'PDF page 1' })).toBeTruthy()
  })

  it('keeps the previous bitmap when canvas allocation fails and retries the zoom', async () => {
    const h = harness()
    render(<h.View />)
    await act(async () => { loads[0]!.deferred.resolve(documentOf(1)) })
    const canvas = screen.getByRole('img') as HTMLCanvasElement
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValueOnce(null)
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 2 }) })
    expect(canvas.width).toBe(100)
    expect(screen.getByRole('img')).toBe(canvas)
    expect(screen.getByRole('alert').textContent).toContain('PDF canvas has no 2D context')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(canvas.width).toBe(200)
    expect(screen.queryByRole('alert')).toBeNull()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValueOnce(null)
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 3 }) })
    expect(screen.getByRole('alert')).toBeTruthy()
    await act(async () => { h.instance.actions.zoom(h.tabId, { kind: 'fixed', scale: 2 }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(canvas.width).toBe(200)
  })
})
