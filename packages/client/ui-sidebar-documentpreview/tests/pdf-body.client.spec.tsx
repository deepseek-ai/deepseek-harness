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

const engine = vi.hoisted(() => ({ open: vi.fn<typeof openPdf>(), render: vi.fn<typeof renderPdfPage>() }))
vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: engine.open }))
vi.mock('../src/client/pdf/document.ts', () => ({ renderPdfPage: engine.render }))
import { PdfBody, type PdfBodyProps } from '../src/client/pdf/pdf.tsx'
import { createPdfStore, type PdfState } from '../src/client/pdf/store.ts'
import { en } from '../src/client/pdf/locales.ts'
import { PdfWorkerFailure } from '../src/client/pdf/errors.ts'

const loads: Array<{
  deferred: ReturnType<typeof Promise.withResolvers<PdfDocument>>
  dispose: ReturnType<typeof vi.fn>
}> = []

beforeEach(() => {
  loads.length = 0
  engine.open.mockReset().mockImplementation(() => {
    const deferred = Promise.withResolvers<PdfDocument>()
    const dispose = vi.fn(async () => {})
    loads.push({ deferred, dispose })
    return { document: deferred.promise, dispose }
  })
  engine.render.mockReset().mockResolvedValue({ width: 100, height: 100 })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
  function View({ data = 'one', kind = 'bytes' }: { readonly data?: string; readonly kind?: 'bytes' | 'text' }) {
    const bytes = useMemo(() => new TextEncoder().encode(data), [data])
    // The PDF body reads these standard seats; the remaining framework seats are unused here.
    const props = {
      resourceAddress: 'dsh-resource://file/session/s/report.pdf',
      content: kind === 'bytes' ? { kind, data: bytes } : { kind, text: '', pages: [], eof: true }, wrap: false,
      useTabInfo: () => ({ tab: { id: tabId, signal: controller.signal } }),
      useStore, actions: instance.actions, retainTab: vi.fn(), t: makeTranslate(en),
    } as unknown as PdfBodyProps
    return <PdfBody {...props} />
  }
  return { instance, controller, tabId, View }
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

  it('shows loading, omits the paging toolbar, and renders a continuous page sequence', async () => {
    const h = harness()
    const view = render(<h.View />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Reading…')
    expect(screen.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    await act(async () => { loads[0]!.deferred.resolve(documentOf()) })
    await act(async () => {})
    expect(view.container.querySelector('[role="toolbar"]')).toBeNull()
    expect([...view.container.querySelectorAll('[data-pdf-page]')].map(page => page.getAttribute('data-pdf-page')))
      .toEqual(['1', '2', '3'])
    expect(screen.getAllByRole('img').map(image => image.getAttribute('aria-label')))
      .toEqual(['PDF page 1', 'PDF page 2', 'PDF page 3'])
    expect(engine.render.mock.calls.map(([, page]) => page)).toEqual([1, 2, 3])
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
})
