// @vitest-environment jsdom
/**
 * The content body's states, renderer selection, content conversion, view
 * state, and shared header. The renderer registry, the view store, and
 * the face are real; the tab and the document body
 * Factory are scripted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DocumentBodyInput } from '../src/client/document/contract.ts'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { ContentPreview, ContentViewer } from '../src/client/content/ContentPreview.tsx'
import type { PreviewContent } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { contentFace } from '../src/client/content/face.ts'
import { createContentPreviewStore } from '../src/client/content/store.ts'

const TAB_ID = 'tab-1' as TabId
const ADDRESS = 'dsh-resource://content-preview/item'

const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement & { __scrollTop?: number }) { return this.__scrollTop ?? 0 },
    set(this: HTMLElement & { __scrollTop?: number }, value: number) { this.__scrollTop = value },
  })
})

afterAll(() => {
  if (originalScrollTop !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop)
})

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', InertResizeObserver) })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function t(key: string, params?: Record<string, unknown>): string {
  return params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`
}

const markdownRenderer: DocumentPreviewDefinition = {
  id: 'markdown', extensions: ['md'], mediaTypes: ['text/markdown'], priority: 'builtin', title: () => 'Markdown', loading: 'text-pages',
}
const plainRenderer: DocumentPreviewDefinition = {
  id: 'plain', extensions: [], mediaTypes: ['text/plain', 'text/markdown'], priority: 'builtin', title: () => 'Plain text', loading: 'text-pages', wrap: true,
}
const bytesRenderer: DocumentPreviewDefinition = {
  id: 'bytes', extensions: ['bin'], mediaTypes: ['application/x-test'], title: () => 'Bytes', loading: 'bytes-complete',
}

/** The document body Factory double: shows the content it received and can claim the scrollport. */
function FakeDocument({ input, innerScrollport }: { input: DocumentBodyInput; innerScrollport: boolean }): ReactNode {
  const { content } = input
  return (
    <div data-factory={input.rendererId} data-wrap={String(input.wrap)} data-base={String('baseAddress' in input)}>
      {content.kind === 'text' ? content.text : content.kind === 'bytes' ? Array.from(content.data).join(',') : null}
      {innerScrollport && <div data-inner ref={input.scrollportRef} />}
    </div>
  )
}

function setup(options: { innerScrollport?: boolean } = {}) {
  const registry = new DocumentPreviewRegistry()
  const instance = createContentPreviewStore().create()
  const face = contentFace({
    mediaTypeCandidates: mediaType => registry.mediaTypeCandidates(mediaType),
    hooks: { documentPreviews: { getSnapshot: registry.getSnapshot, subscribe: registry.subscribe } },
    retainTab: (tabId, signal, forget) => { signal.addEventListener('abort', () => { forget(tabId) }, { once: true }) },
  })('s1', instance.actions)
  const record = new AbortController()
  const state = {
    address: ADDRESS,
    snapshot: { status: 'loading', value: undefined, failure: undefined } as ResourceSnapshot<PreviewContent>,
  }
  const inputs: DocumentBodyInput[] = []
  const useTabInfo = () => ({
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1', isFloating: false },
    tab: {
      id: TAB_ID, kind: 'content', contentId: state.address, title: 'Recorded title', visible: true,
      navigation: { address: state.address, params: state.snapshot.value === undefined ? undefined : { previewContent: state.snapshot.value, previewTitle: 'Stored title' }, revision: 1 },
      signal: record.signal,
      actions: { bindCommands: vi.fn(), openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() },
    },
  })
  const viewerProps = () => ({
    useStore: bindSnapshotSelector(instance),
    actions: instance.actions,
    ...face,
    useDocumentPreviews: bindSnapshotSelector(face.hooks.documentPreviews),
    renderFactorySlot: (_name: string, input: DocumentBodyInput) => {
      inputs.push(input)
      return createElement(FakeDocument, { input, innerScrollport: options.innerScrollport ?? false })
    },
    t,
  })
  const props = (): ComponentProps<typeof ContentPreview> => ({
    useTabInfo,
    renderFactorySlot: (_name: string, input: Pick<ComponentProps<typeof ContentViewer>, 'title' | 'content' | 'useTabInfo'>) =>
      createElement(ContentViewer, { ...viewerProps(), ...input } as never),
  }) as never
  const view = render(createElement(ContentPreview, props()))
  const rerender = (): void => { view.rerender(createElement(ContentPreview, props())) }
  const show = (snapshot: ResourceSnapshot<PreviewContent>): void => {
    state.snapshot = snapshot
    rerender()
  }
  const root = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-contentpreview-state]')!
  return { registry, instance, record, state, inputs, view, props, rerender, show, root }
}

const live = (value: PreviewContent): ResourceSnapshot<PreviewContent> => ({ status: 'live', value, failure: undefined })
const markdown: PreviewContent = { mediaType: 'text/markdown', text: '# Plan\nbody\n' }

describe('content preview body', () => {
  it('explains that transient input expires after reload', () => {
    const h = setup()
    expect(h.root().dataset.contentpreviewState).toBe('expired')
    expect(h.root().textContent).toContain('content.expired')
  })

  it('names the preview region after the title the header shows', () => {
    const h = setup()
    h.registry.register(markdownRenderer)
    expect(screen.getByRole('region', { name: 'Recorded title' })).toBe(h.root())
    h.show(live(markdown))
    expect(screen.getByRole('region', { name: 'Stored title' })).toBe(h.root())
  })

  it('renders text through the single matching renderer with one complete page and its header', () => {
    const h = setup()
    h.registry.register(markdownRenderer)
    h.show(live(markdown))
    expect(h.root().dataset.contentpreviewState).toBe('content')
    expect(h.root().dataset.documentPreview).toBe('markdown')
    expect(h.root().dataset.contentpreviewMediaType).toBe('text/markdown')
    const input = h.inputs.at(-1)!
    expect(input).toMatchObject({ rendererId: 'markdown', resourceAddress: ADDRESS, wrap: true })
    expect(input).not.toHaveProperty('baseAddress')
    expect(input.content).toEqual({ kind: 'text', text: '# Plan\nbody\n', pages: [{ offset: 1, text: '# Plan\nbody', lines: 2 }], eof: true })
    input.addResource('dsh-resource://file/x')
    input.setResources([])
    expect(h.root().querySelector('[data-contentpreview-title]')?.textContent).toBe('Stored title')
    expect(h.root().querySelector('[data-document-viewer-menu]')).toBeNull()
    expect(h.root().querySelector('[data-contentpreview-tool="wrap"]')).toBeNull()
  })

  it('keeps the converted content reference while the value is unchanged', () => {
    const h = setup()
    h.registry.register(markdownRenderer)
    h.show(live(markdown))
    const first = h.inputs.at(-1)!.content
    h.rerender()
    expect(h.inputs.at(-1)!.content).toBe(first)
    h.show(live({ mediaType: 'text/markdown', text: 'next' }))
    expect(h.inputs.at(-1)!.content).not.toBe(first)
  })

  it('names the media type nothing can render', () => {
    const h = setup()
    h.show(live({ mediaType: 'image/png', bytes: new Uint8Array([1]) }))
    expect(h.root().dataset.contentpreviewState).toBe('unsupported')
    expect(h.root().textContent).toContain('content.noRenderer(mediaType=image/png)')
    expect(h.root().dataset.documentPreview).toBeUndefined()
  })

  it('offers the other renderers in an open-with menu and remembers the choice', () => {
    const h = setup()
    h.registry.register(markdownRenderer)
    h.registry.register(plainRenderer)
    h.show(live(markdown))
    const anchor = h.root().querySelector<HTMLButtonElement>('[data-document-viewer-menu]')!
    expect(anchor.textContent).toBe('Markdown')
    fireEvent.click(anchor)
    const plain = screen.getAllByRole('menuitem').find(row => row.textContent?.includes('Plain text'))!
    fireEvent.click(plain)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.rendererId).toBe('plain')
    expect(h.root().dataset.documentPreview).toBe('plain')
    expect(screen.queryAllByRole('menuitem')).toEqual([])
    fireEvent.click(h.root().querySelector('[data-document-viewer-menu]')!)
    fireEvent.click(h.root().querySelector('[data-document-viewer-menu]')!)
    expect(screen.queryAllByRole('menuitem')).toEqual([])
    fireEvent.click(h.root().querySelector('[data-document-viewer-menu]')!)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    expect(screen.queryAllByRole('menuitem')).toEqual([])
  })

  it('toggles line wrap for a renderer that consumes it', () => {
    const h = setup()
    h.registry.register(plainRenderer)
    h.show(live({ mediaType: 'text/plain', text: 'a' }))
    const wrap = (): HTMLButtonElement => h.root().querySelector<HTMLButtonElement>('[data-contentpreview-tool="wrap"]')!
    expect(wrap().getAttribute('aria-pressed')).toBe('true')
    expect(h.root().querySelector('[data-contentpreview-body]')?.hasAttribute('data-contentpreview-wrap')).toBe(true)
    fireEvent.click(wrap())
    expect(wrap().getAttribute('aria-pressed')).toBe('false')
    expect(h.root().querySelector('[data-contentpreview-body]')?.hasAttribute('data-contentpreview-wrap')).toBe(false)
    expect(h.inputs.at(-1)?.wrap).toBe(false)
  })

  it('decodes bytes for a text renderer and encodes text for a byte renderer', () => {
    const h = setup()
    h.registry.register(plainRenderer)
    h.registry.register(bytesRenderer)
    h.show(live({ mediaType: 'text/plain', bytes: new TextEncoder().encode('hi\nthere') }))
    expect(h.inputs.at(-1)?.content).toEqual({ kind: 'text', text: 'hi\nthere', pages: [{ offset: 1, text: 'hi\nthere', lines: 2 }], eof: true })
    h.show(live({ mediaType: 'application/x-test', text: 'hi' }))
    const content = h.inputs.at(-1)?.content
    expect(content?.kind).toBe('bytes')
    expect(content?.kind === 'bytes' && Array.from(content.data)).toEqual([104, 105])
    const data = new Uint8Array([7, 8])
    h.show(live({ mediaType: 'application/x-test', bytes: data }))
    expect(h.inputs.at(-1)?.content).toEqual({ kind: 'bytes', data })
  })

  it('records the body scroll offset and restores it on remount', () => {
    const h = setup()
    h.registry.register(plainRenderer)
    h.show(live({ mediaType: 'text/plain', text: 'long' }))
    const body = h.root().querySelector<HTMLElement>('[data-contentpreview-body]')!
    fireEvent.scroll(body, { target: { scrollTop: 50 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(50)
    // A scroll inside the renderer is not the body's offset.
    fireEvent.scroll(h.root().querySelector('[data-factory]')!)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(50)
    h.view.unmount()
    const remount = render(createElement(ContentPreview, h.props()))
    expect(remount.container.querySelector<HTMLElement>('[data-contentpreview-body]')!.scrollTop).toBe(50)
  })

  it('follows a renderer-owned scrollport and returns to the body when it is released', () => {
    const h = setup({ innerScrollport: true })
    h.registry.register(plainRenderer)
    h.instance.actions.scrolled(TAB_ID, 30)
    h.show(live({ mediaType: 'text/plain', text: 'long' }))
    const inner = h.root().querySelector<HTMLElement>('[data-inner]')!
    expect(inner.scrollTop).toBe(30)
    fireEvent.scroll(inner, { target: { scrollTop: 90 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(90)
    act(() => { h.inputs.at(-1)!.scrollportRef(null) })
    const body = h.root().querySelector<HTMLElement>('[data-contentpreview-body]')!
    expect(body.scrollTop).toBe(90)
  })
})
