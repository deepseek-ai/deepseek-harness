// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
/**
 * What the body draws from its pages and the file's metadata, and what it does
 * with a navigation: load until the asked line is held, jump to it once, then
 * keep the reader's place.
 *
 * jsdom lays nothing out, so two geometry facts are supplied here: a line's
 * offset is its number times one line height, and `scrollTop` holds what it is
 * set to. Both are the browser's job; the specs assert the body's arithmetic
 * over them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { FileNavigatorInput } from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { TextPreview } from '../src/client/TextPreview.tsx'
import type { TextPreviewProps } from '../src/client/TextPreview.tsx'
import { CodeBody } from '../src/client/code/CodeBody.tsx'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { TextBody } from '../src/client/text/TextBody.tsx'
import { PLAIN_BODY_ID } from '../src/client/text/index.ts'
import { documentSlots, ABSOLUTE_PATH, ADDRESS, PATH, SESSION, TAB_ID, failure, harness, page, settle } from './fixtures.client.ts'

const LINE_HEIGHT = 20

const originals = {
  offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop'),
  scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      const line = this.getAttribute('data-textpreview-line')
      if (line !== null) return (Number(line) - 1) * LINE_HEIGHT
      if (!this.matches('[data-code-preview] pre .line')) return 0
      const rows = this.closest('[data-code-preview]')?.querySelectorAll('pre .line') ?? []
      return Array.from(rows).indexOf(this) * LINE_HEIGHT
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement & { __scrollTop?: number }) { return this.__scrollTop ?? 0 },
    set(this: HTMLElement & { __scrollTop?: number }, value: number) { this.__scrollTop = value },
  })
})

afterAll(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
    else Object.defineProperty(HTMLElement.prototype, name, descriptor)
  }
})

/** Records each scrollport observer so a spec can report a resize to it. */
class RecordingResizeObserver {
  static instances: RecordingResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: () => void) { RecordingResizeObserver.instances.push(this) }
  observe(target: Element): void { this.targets.push(target) }
  disconnect(): void {}
  resize(): void { act(() => { this.callback() }) }
}

beforeEach(() => {
  RecordingResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

class PendingIntersectionObserver {
  static instances: PendingIntersectionObserver[] = []
  readonly observed = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback) {
    PendingIntersectionObserver.instances.push(this)
  }

  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return [] }

  intersect(element: Element): void {
    this.callback(
      [{ target: element, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function codeProps(h: ReturnType<typeof harness>, navigation: { params?: unknown; revision: number }): TextPreviewProps {
  const props = h.props(navigation)
  const definition: DocumentPreviewDefinition = {
    id: 'code', extensions: ['md'], title: () => 'Code', loading: 'text-pages', wrap: true, sourceLines: true,
  }
  return {
    ...props,
    useDocumentPreviews: selector => selector([definition]),
    renderSlot: documentSlots((_key, owner) => <CodeBody {...props} {...owner as unknown as OwnerOf<'sidebar.right.tab.document'>} t={key => key} />),
  }
}

function body(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-textpreview-body]')
  if (element === null) throw new Error('expected the file body')
  return element
}

function scrollport(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-code-block-content]') ?? body(container)
}

function lines(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-textpreview-line]'), row => row.textContent ?? '')
}

function target(container: HTMLElement): string | null {
  return container.querySelector('[data-textpreview-target]')?.getAttribute('data-textpreview-target') ?? null
}

function marks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-textpreview-mark]'))
}

function click(container: HTMLElement, selector: string): void {
  const button = container.querySelector<HTMLButtonElement>(selector)
  if (button === null) throw new Error(`expected ${selector}`)
  fireEvent.click(button)
}

describe('TextPreview — pages', () => {
  it.each([ABSOLUTE_PATH, 'C:\\work\\project\\notes.md', '\\\\host\\share\\notes.md'])(
    'shows the Host path %s in the header and tooltip even when text cannot be read',
    async (absolutePath) => {
      const h = harness({ 1: failure('workspace-file/not-text', { path: PATH }) })
      h.useResource.mockReturnValue({
        status: 'live', value: { absolutePath, version: 'v1', bytes: 100 }, failure: undefined,
      })
      const view = render(<TextPreview {...h.props()} />)
      await settle()
      const path = view.container.querySelector('[data-textpreview-path]')
      expect(path?.textContent).toBe(absolutePath)
      expect(path?.getAttribute('title')).toBe(absolutePath)
      expect(h.read).toHaveBeenCalledWith(SESSION, PATH, 1, h.controller.signal)
    },
  )

  it('shows the requested path until Host metadata supplies its absolute path', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const metadata = h.useResource()
    h.useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-path]')?.textContent).toBe(PATH)
    h.useResource.mockReturnValue(metadata)
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-path]')?.textContent).toBe(ABSOLUTE_PATH)
    expect(view.container.querySelector('[data-textpreview-path]')?.getAttribute('title')).toBe(ABSOLUTE_PATH)
  })

  it('reads the first page on first mount and draws its lines, offering the next', async () => {
    const h = harness({ 1: page(1, ['one', 'two', 'three'], false) })
    const view = render(<TextPreview {...h.props()} />)
    // The first read has no document body or next-page control to displace its status.
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
    expect(view.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    expect(body(view.container).firstElementChild).toBe(view.getByRole('status'))
    expect(lines(view.container)).toEqual([])
    await settle()
    expect(view.queryByRole('status')).toBeNull()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.read).toHaveBeenCalledWith(SESSION, PATH, 1, h.controller.signal)
    expect(lines(view.container)).toEqual(['one\n', 'two\n', 'three\n'])
    expect(view.container.querySelector('[data-textpreview-url]')?.getAttribute('data-textpreview-url')).toBe(ADDRESS)
    expect(view.container.textContent).toContain(PATH)
    expect(view.container.querySelector('[data-textpreview-more]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
  })

  it('reads nothing on a remount while the store holds the pages', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const first = render(<TextPreview {...h.props()} />)
    await settle()
    first.unmount()
    const second = render(<TextPreview {...h.props()} />)
    await settle()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(lines(second.container)).toEqual(['one\n'])
  })

  it('loads the next page where the loaded text ends, until the file ends', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], false), 4: page(4, ['d', 'e'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    click(view.container, '[data-textpreview-more]')
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 4, h.controller.signal)
    expect(lines(view.container)).toEqual(['a\n', 'b\n', 'c\n', 'd\n', 'e\n'])
    expect(view.container.querySelectorAll('[data-textpreview-page]').length).toBe(2)
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
  })

  it('keeps loaded lines visible while the next page shows the shared loading indicator', async () => {
    const h = harness({ 1: page(1, ['held'], false) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const next = Promise.withResolvers<Awaited<ReturnType<typeof h.read>>>()
    h.read.mockReturnValueOnce(next.promise)
    click(view.container, '[data-textpreview-more]')
    expect(view.getByRole('status').getAttribute('aria-label')).toBe('loading')
    expect(lines(view.container)).toEqual(['held\n'])
    await act(async () => { next.resolve(page(2, ['tail'], true)); await next.promise })
    expect(view.queryByRole('status')).toBeNull()
    expect(lines(view.container)).toEqual(['held\n', 'tail\n'])
  })

  it('says why a page failed and retries the same page', async () => {
    const h = harness({ 1: failure('gateway/internal', { path: PATH }) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const failed = view.container.querySelector('[data-textpreview-failed]')
    expect(failed?.getAttribute('data-textpreview-failed')).toBe('gateway/internal')
    expect(view.container.textContent).toContain('error.unavailable(message=boom)')
    // Nothing read yet: the failure stands as the body, under the file's type sheet.
    expect(failed?.querySelector('svg')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
    expect(view.container.querySelector('[data-slot="sidebar.right.tab.document.unpreviewable"]')).toBeNull()
    h.script(1, page(1, ['one'], true))
    click(view.container, '[data-textpreview-retry]')
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 1, h.controller.signal)
    expect(lines(view.container)).toEqual(['one\n'])
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
  })

  it('hands a readable file it cannot render to the unpreviewable seat instead of Retry', async () => {
    const h = harness({ 1: failure('workspace-file/not-text', { path: PATH }) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const failed = view.container.querySelector('[data-textpreview-failed]')
    expect(failed?.getAttribute('data-textpreview-failed')).toBe('workspace-file/not-text')
    expect(view.container.textContent).toContain('error.notText')
    expect(view.container.querySelector('[data-textpreview-retry]')).toBeNull()
    const seat = failed?.querySelector('[data-slot="sidebar.right.tab.document.unpreviewable"]')
    expect(seat?.getAttribute('data-slot-path')).toBe(ABSOLUTE_PATH)
    // The header's own handoff seat receives the same file.
    const actions = view.container.querySelector('[data-slot="sidebar.right.tab.document.actions"]')
    expect(actions?.getAttribute('data-slot-path')).toBe(ABSOLUTE_PATH)
  })

  it('offers neither Retry nor a handoff for a path with nothing to show', async () => {
    const h = harness({ 1: failure('workspace-file/not-found', { path: PATH }) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-failed]')?.getAttribute('data-textpreview-failed')).toBe('workspace-file/not-found')
    expect(view.container.querySelector('[data-textpreview-retry]')).toBeNull()
    expect(view.container.querySelector('[data-slot="sidebar.right.tab.document.unpreviewable"]')).toBeNull()
  })

  it('withholds the handoff seats until the file reports a Host path', async () => {
    const h = harness({ 1: failure('workspace-file/not-text', { path: PATH }) })
    h.setVersion(undefined)
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-failed]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot]')).toBeNull()
    h.script(1, page(1, ['reloaded'], true))
    click(view.container, '[data-textpreview-tool="reload"]')
    await settle()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
  })

  it('says why a later page failed on a line under the pages already read', async () => {
    const h = harness({ 1: page(1, ['a'], false), 2: failure('workspace-file/too-large', { path: PATH, limit: 1024 }) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    click(view.container, '[data-textpreview-more]')
    await settle()
    const failed = view.container.querySelector('[data-textpreview-failed]')
    expect(failed?.getAttribute('data-textpreview-failed')).toBe('workspace-file/too-large')
    expect(failed?.querySelector('svg')).toBeNull()
    expect(lines(view.container)).toEqual(['a\n'])
    h.script(2, page(2, ['b'], true))
    click(view.container, '[data-textpreview-retry]')
    await settle()
    expect(lines(view.container)).toEqual(['a\n', 'b\n'])
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
  })

  it('announces a change while automatic refresh is paused and reloads on request, keeping the reader\'s place', async () => {
    const h = harness({ 1: page(1, ['a', 'b'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    fireEvent.scroll(body(view.container), { target: { scrollTop: 50 } })
    click(view.container, '[data-textpreview-tool="auto-refresh"]')
    h.setVersion('v2')
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-changed]')?.textContent).toContain('changed')
    expect(lines(view.container)).toEqual(['a\n', 'b\n'])
    h.script(1, page(1, ['A', 'B', 'C'], true, 'v2'))
    click(view.container, '[data-textpreview-reload-now]')
    expect(h.read).toHaveBeenCalledTimes(2)
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 1, h.controller.signal)
    expect(lines(view.container)).toEqual(['A\n', 'B\n', 'C\n'])
    expect(body(view.container).scrollTop).toBe(50)
  })
})

describe('TextPreview — the file\'s metadata', () => {
  it('refreshes by default with the toggle hidden and catches up when automatic refresh resumes', async () => {
    const h = harness({ 1: page(1, ['old'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const toggle = view.container.querySelector('[data-textpreview-tool="auto-refresh"]')!
    expect(toggle.closest('[hidden]')).not.toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(view.queryByRole('button', { name: 'autoRefresh' })).toBeNull()
    expect(view.getByRole('button', { name: 'reload' })).toBeTruthy()
    fireEvent.scroll(body(view.container), { target: { scrollTop: 40 } })
    h.script(1, page(1, ['updated'], true, 'v2'))
    h.setVersion('v2')
    view.rerender(<TextPreview {...h.props()} />)
    await settle()
    expect(lines(view.container)).toEqual(['updated\n'])
    expect(body(view.container).scrollTop).toBe(40)
    expect(h.read).toHaveBeenCalledTimes(2)
    fireEvent.click(toggle)
    h.script(1, page(1, ['latest'], true, 'v3'))
    h.setVersion('v3')
    view.rerender(<TextPreview {...h.props()} />)
    expect(lines(view.container)).toEqual(['updated\n'])
    expect(h.read).toHaveBeenCalledTimes(2)
    fireEvent.click(toggle)
    await settle()
    expect(lines(view.container)).toEqual(['latest\n'])
    expect(h.read).toHaveBeenCalledTimes(3)
  })

  it('does not treat the observation present at read start as a later file change', async () => {
    const h = harness({ 1: page(1, ['newer read'], true, 'v2') })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    click(view.container, '[data-textpreview-tool="auto-refresh"]')
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toMatchObject({ version: 'v2', observedVersion: 'v1' })
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
    h.setVersion('v3')
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
    h.script(1, page(1, ['refreshed'], true, 'v4'))
    click(view.container, '[data-textpreview-reload-now]')
    await settle()
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toMatchObject({ version: 'v4', observedVersion: 'v3' })
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
    h.setVersion('v5')
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
  })

  it('announces metadata that changes during the first read while automatic refresh is paused', async () => {
    const h = harness()
    const pending = Promise.withResolvers<ReturnType<typeof page>>()
    h.read.mockReturnValueOnce(pending.promise)
    const view = render(<TextPreview {...h.props()} />)
    click(view.container, '[data-textpreview-tool="auto-refresh"]')
    h.setVersion('v2')
    view.rerender(<TextPreview {...h.props()} />)
    await act(async () => { pending.resolve(page(1, ['read v1'], true)); await pending.promise })
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toMatchObject({ version: 'v1', observedVersion: 'v1' })
    expect(view.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
  })

  it('refreshes one tab without acknowledging another tab on the same file and store', async () => {
    const h = harness({ 1: page(1, ['old'], true) })
    const otherId = 'tab-2' as TabId
    const other = harness({}, otherId)
    const firstProps = h.props()
    const secondProps = { ...firstProps, useTabInfo: other.props().useTabInfo }
    const first = render(<TextPreview {...firstProps} />)
    const second = render(<TextPreview {...secondProps} />)
    await settle()
    click(first.container, '[data-textpreview-tool="auto-refresh"]')
    click(second.container, '[data-textpreview-tool="auto-refresh"]')
    h.setVersion('v2')
    first.rerender(<TextPreview {...firstProps} />)
    second.rerender(<TextPreview {...secondProps} />)
    expect(first.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
    expect(second.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
    h.script(1, page(1, ['new'], true, 'v2'))
    click(first.container, '[data-textpreview-reload-now]')
    await settle()
    expect(first.container.querySelector('[data-textpreview-changed]')).toBeNull()
    expect(second.container.querySelector('[data-textpreview-changed]')).not.toBeNull()
    expect(lines(first.container)).toEqual(['new\n'])
    expect(lines(second.container)).toEqual(['old\n'])
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toMatchObject({ version: 'v2', observedVersion: 'v2' })
    expect(h.instance.getSnapshot().byTab[otherId]).toMatchObject({ version: 'v1', observedVersion: 'v1' })
    expect(h.file?.version).toBe('v2')
  })

  it('keeps metadata failure separate from per-tab content refresh', async () => {
    const h = harness({ 1: page(1, ['a', 'b'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    h.setVersion('v2')
    h.setFailure(new RemoteError('workspace-file/not-found', 'gone', { path: PATH }))
    view.rerender(<TextPreview {...h.props()} />)
    const bar = view.container.querySelector('[data-textpreview-meta-failed]')
    expect(bar?.getAttribute('data-textpreview-meta-failed')).toBe('workspace-file/not-found')
    expect(bar?.textContent).toContain('error.notFound')
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
    expect(lines(view.container)).toEqual(['a\n', 'b\n'])
    // Retrying content does not acknowledge or mutate the shared metadata failure.
    h.script(1, page(1, ['A'], true, 'v2'))
    click(view.container, '[data-textpreview-reload-now]')
    expect(h.read).toHaveBeenCalledTimes(2)
    await settle()
    expect(lines(view.container)).toEqual(['A\n'])
    // A later provider frame independently clears the metadata failure.
    h.setVersion('v2')
    h.setFailure(undefined)
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-meta-failed]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
  })

  it('says a metadata-and-read failure once and retries the content read', async () => {
    const h = harness({ 1: failure('workspace-file/outside-workspace', { path: PATH }) })
    h.setFailure(new RemoteError('workspace-file/outside-workspace', 'outside', { path: PATH }))
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    // With nothing read the body's failure is the whole story: a metadata bar
    // above it would repeat the same line.
    expect(view.container.querySelector('[data-textpreview-meta-failed]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-failed]')?.getAttribute('data-textpreview-failed'))
      .toBe('workspace-file/outside-workspace')
    h.script(1, page(1, ['a'], true))
    click(view.container, '[data-textpreview-retry]')
    await settle()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(lines(view.container)).toEqual(['a\n'])
    h.setFailure(undefined)
    view.rerender(<TextPreview {...h.props()} />)
    expect(view.container.querySelector('[data-textpreview-meta-failed]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
  })

  it('draws a page holding one empty line as one line, and nothing for a page past the end', async () => {
    const h = harness({ 1: page(1, [''], false), 2: page(2, [], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(lines(view.container)).toEqual(['\n'])
    click(view.container, '[data-textpreview-more]')
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 2, h.controller.signal)
    expect(lines(view.container)).toEqual(['\n'])
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
  })
})

describe('TextPreview — navigation and view', () => {
  it('rebinds scrolling when the selected Slot body is replaced without changing the renderer id', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const code = codeProps(h, { revision: 1 })
    const fallback: TextPreviewProps = { ...code, renderSlot: documentSlots(() => <div data-late-renderer />) }
    const view = render(<TextPreview {...fallback} />)
    await settle()
    const outer = body(view.container)
    fireEvent.scroll(outer, { target: { scrollTop: 120 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(120)

    view.rerender(<TextPreview {...code} />)
    const inner = scrollport(view.container)
    expect(inner).not.toBe(outer)
    expect(inner.scrollTop).toBe(120)
    fireEvent.scroll(inner, { target: { scrollTop: 240 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(240)

    view.rerender(<TextPreview {...fallback} />)
    expect(outer.scrollTop).toBe(240)
    fireEvent.scroll(outer, { target: { scrollTop: 360 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(360)
  })

  const CODE_DEFINITION: DocumentPreviewDefinition = {
    id: 'code', extensions: ['md'], title: () => 'Code', loading: 'text-pages', wrap: true, sourceLines: true,
  }
  const PLAIN_DEFINITION: DocumentPreviewDefinition = {
    id: PLAIN_BODY_ID, extensions: [], title: () => 'Plain text', loading: 'text-pages', wrap: true, sourceLines: true,
  }

  /**
   * Offer `definitions` for a Markdown file; plain text renders lines, Code renders lines unless `codeDrawsLines` is false,
   * and every other renderer draws no source lines.
   */
  function rendererProps(
    h: ReturnType<typeof harness>,
    navigation: { params?: unknown; revision: number },
    definitions: DocumentPreviewDefinition[],
    codeDrawsLines: boolean,
  ): TextPreviewProps {
    const base = h.props(navigation)
    return {
      ...base,
      useDocumentPreviews: selector => selector(definitions),
      renderSlot: documentSlots((_key, owner, opts) => {
        const documentOwner = owner as unknown as OwnerOf<'sidebar.right.tab.document'>
        if (opts.entryKey === 'code' && codeDrawsLines) return <CodeBody {...base} {...documentOwner} t={key => key} />
        if (opts.entryKey === PLAIN_BODY_ID) return <TextBody {...base} {...documentOwner} />
        return <div data-test-no-lines />
      }),
    }
  }

  /** A Markdown file that also offers Code and plain text; only the latter two expose source lines. */
  function markdownProps(h: ReturnType<typeof harness>, navigation: { params?: unknown; revision: number }): TextPreviewProps {
    const markdown: DocumentPreviewDefinition = { id: 'markdown', extensions: ['md'], title: () => 'Markdown', loading: 'text-pages', wrap: false }
    return rendererProps(h, navigation, [markdown, CODE_DEFINITION, PLAIN_DEFINITION], true)
  }

  it.each([['Code', 'code'], ['Plain text', PLAIN_BODY_ID]])(
    'answers a line navigation in Markdown without moving, and switching to %s does not jump later',
    async (_name, rendererId) => {
      PendingIntersectionObserver.instances = []
      vi.stubGlobal('IntersectionObserver', PendingIntersectionObserver)
      const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
      const view = render(<TextPreview {...markdownProps(h, { params: { line: 3 }, revision: 1 })} />)
      await settle()
      expect(body(view.container).scrollTop).toBe(0)
      expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(1)
      act(() => { h.instance.actions.selected(TAB_ID, rendererId) })
      await settle()
      expect(scrollport(view.container).scrollTop).toBe(0)
      expect(marks(view.container)).toEqual([])
    },
  )

  it('restores the reading position of a Markdown tab opened at a line, on a remount and after a reload', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const navigation = { params: { line: 3 }, revision: 1 }
    const first = render(<TextPreview {...markdownProps(h, navigation)} />)
    await settle()
    fireEvent.scroll(body(first.container), { target: { scrollTop: 300 } })
    first.unmount()
    const second = render(<TextPreview {...markdownProps(h, navigation)} />)
    await settle()
    expect(body(second.container).scrollTop).toBe(300)
    h.script(1, page(1, ['A', 'B', 'C'], true, 'v2'))
    click(second.container, '[data-textpreview-tool="reload"]')
    body(second.container).scrollTop = 0
    await settle()
    expect(body(second.container).scrollTop).toBe(300)
  })

  it('keeps a line navigation pending while a source-line renderer has not drawn the line', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const props = rendererProps(h, { params: { line: 3 }, revision: 1 }, [CODE_DEFINITION, PLAIN_DEFINITION], false)
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBeUndefined()
    act(() => { h.instance.actions.selected(TAB_ID, PLAIN_BODY_ID) })
    await waitFor(() => { expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(1) })
    expect(body(view.container).scrollTop).toBe(2 * LINE_HEIGHT)
  })

  it('lands on code lines before and after syntax highlighting is ready', async () => {
    PendingIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', PendingIntersectionObserver)
    const h = harness({ 1: page(1, ['const a = 1', 'const b = 2', 'const c = 3'], true) })
    const view = render(<TextPreview {...codeProps(h, { params: { line: 2 }, revision: 1 })} />)
    await settle()
    expect(view.container.querySelector('[data-code-preview] pre.shiki')).toBeNull()
    expect(view.container.querySelectorAll('[data-code-preview] pre .line')).toHaveLength(3)
    expect(body(view.container).scrollTop).toBe(0)
    const codeScrollport = scrollport(view.container)
    expect(codeScrollport.scrollTop).toBe(LINE_HEIGHT)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(1)
    fireEvent.scroll(body(view.container), { target: { scrollTop: 300 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(LINE_HEIGHT)
    fireEvent.scroll(codeScrollport, { target: { scrollTop: 300 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(300)

    const block = view.container.querySelector('[data-code-preview] .md-code-block')!
    act(() => { PendingIntersectionObserver.instances[0]!.intersect(block) })
    await waitFor(() => { expect(view.container.querySelector('[data-code-preview] pre.shiki')).not.toBeNull() })
    expect(scrollport(view.container)).toBe(codeScrollport)
    // The band lives in the scrollport, so the highlighted swap keeps it.
    expect(marks(view.container).map(mark => [mark.parentElement, mark.dataset.textpreviewMark, mark.style.top]))
      .toEqual([[codeScrollport, '2', `${LINE_HEIGHT}px`]])
    view.rerender(<TextPreview {...codeProps(h, { params: { line: 3 }, revision: 2 })} />)
    expect(codeScrollport.scrollTop).toBe(2 * LINE_HEIGHT)
    expect(marks(view.container).map(mark => mark.dataset.textpreviewMark)).toEqual(['3'])
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(2)
  })

  it('loads until the navigated line is held, then jumps to it once and marks it', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], false), 4: page(4, ['d', 'e', 'f'], true) })
    const view = render(<TextPreview {...h.props({ params: { line: 5 }, revision: 1 })} />)
    await settle()
    // The first page does not reach line 5, so the body asks for the next on its own.
    await settle()
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 4, h.controller.signal)
    expect(body(view.container).scrollTop).toBe(4 * LINE_HEIGHT)
    expect(target(view.container)).toBe('5')
    const [mark] = marks(view.container)
    expect(mark?.parentElement).toBe(body(view.container))
    expect(mark?.dataset.textpreviewMark).toBe('5')
    expect(mark?.style.top).toBe(`${4 * LINE_HEIGHT}px`)
    fireEvent.animationEnd(mark!)
    expect(marks(view.container)).toEqual([])
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(1)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(4 * LINE_HEIGHT)
  })

  it('comes back where the reader was on a remount, instead of jumping again', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const first = render(<TextPreview {...h.props({ params: { line: 3 }, revision: 1 })} />)
    await settle()
    expect(body(first.container).scrollTop).toBe(2 * LINE_HEIGHT)
    fireEvent.scroll(body(first.container), { target: { scrollTop: 300 } })
    first.unmount()
    const second = render(<TextPreview {...h.props({ params: { line: 3 }, revision: 1 })} />)
    await settle()
    expect(body(second.container).scrollTop).toBe(300)
    expect(marks(second.container)).toEqual([])
  })

  it('jumps again for a new navigation to the same tab', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const view = render(<TextPreview {...h.props({ params: { line: 3 }, revision: 1 })} />)
    await settle()
    fireEvent.scroll(body(view.container), { target: { scrollTop: 300 } })
    view.rerender(<TextPreview {...h.props({ params: { line: 2 }, revision: 2 })} />)
    expect(body(view.container).scrollTop).toBe(1 * LINE_HEIGHT)
    expect(target(view.container)).toBe('2')
    expect(marks(view.container).map(mark => mark.dataset.textpreviewMark)).toEqual(['2'])
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(2)
  })

  it('drops the line mark when the scrollport resizes or wrapping reflows its lines', async () => {
    const h = harness({ 1: page(1, ['a', 'b', 'c'], true) })
    const view = render(<TextPreview {...h.props({ params: { line: 3 }, revision: 1 })} />)
    await settle()
    const observer = RecordingResizeObserver.instances.find(item => item.targets.includes(body(view.container)))
    observer!.resize()
    expect(marks(view.container).map(mark => mark.dataset.textpreviewMark)).toEqual(['3'])
    observer!.resize()
    expect(marks(view.container)).toEqual([])

    view.rerender(<TextPreview {...h.props({ params: { line: 2 }, revision: 2 })} />)
    expect(marks(view.container)).toHaveLength(1)
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('[data-textpreview-tool="wrap"]')!)
    expect(marks(view.container)).toEqual([])
  })

  it('stops at the end of the file for a line past it, and answers a navigation without a line', async () => {
    const h = harness({ 1: page(1, ['a', 'b'], true) })
    const view = render(<TextPreview {...h.props({ params: { line: 99 }, revision: 1 })} />)
    await settle()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(target(view.container)).toBeNull()
    expect(marks(view.container)).toEqual([])
    expect(body(view.container).scrollTop).toBe(0)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(1)
    view.rerender(<TextPreview {...h.props({ params: {}, revision: 2 })} />)
    expect(target(view.container)).toBeNull()
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.revision).toBe(2)
  })

  it('wraps by default and stops when the shared store says so', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(body(view.container).hasAttribute('data-textpreview-wrap')).toBe(true)
    act(() => { h.instance.actions.toggledWrap(TAB_ID) })
    expect(body(view.container).hasAttribute('data-textpreview-wrap')).toBe(false)
  })
})

describe('TextPreview — header controls', () => {
  it('displays the document refresh binding supplied by its tab owner', async () => {
    const h = harness({ 0: page(0, ['hello'], true) })
    const props = h.props(), info = props.useTabInfo()
    const view = render(<TextPreview {...props} useTabInfo={() => ({ ...info, tab: { ...info.tab,
      refreshShortcut: { id: 'page.refresh' as never, label: 'Refresh', aliases: [], binding: null,
        keys: ['Ctrl', 'R'], aria: 'Control+R', modified: true, conflicts: [], issue: null },
    } })} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-tool="reload"]')?.getAttribute('aria-keyshortcuts')).toBe('Control+R')
  })
  it('toggles wrap off from the header, reporting the pressed state', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const wrap = view.container.querySelector<HTMLButtonElement>('[data-textpreview-tool="wrap"]')
    if (wrap === null) throw new Error('expected the wrap control')
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(wrap)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.wrap).toBe(false)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    expect(body(view.container).hasAttribute('data-textpreview-wrap')).toBe(false)
  })

  it('reloads only this tab from the header without a change announced', async () => {
    const h = harness({ 1: page(1, ['one'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    expect(h.useResource).toHaveBeenCalledWith(ADDRESS)
    expect(view.container.querySelector('[data-textpreview-changed]')).toBeNull()
    h.script(1, page(1, ['uno'], true, 'v2'))
    click(view.container, '[data-textpreview-tool="reload"]')
    expect(h.read).toHaveBeenCalledTimes(2)
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 1, h.controller.signal)
    expect(lines(view.container)).toEqual(['uno\n'])
  })

  it('forgets at once when mounted for a record that has already ended', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    h.controller.abort()
    render(<TextPreview {...h.props()} />)
    await settle()
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toBeUndefined()
  })

  it('forgets its state when the record ends, even with the body unmounted, through one listener however often it mounted', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const armed = vi.spyOn(h.controller.signal, 'addEventListener')
    const first = render(<TextPreview {...h.props()} />)
    await settle()
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toBeDefined()
    // Switched away and back: the store outlives the body, so nothing re-arms.
    first.unmount()
    const second = render(<TextPreview {...h.props()} />)
    await settle()
    second.unmount()
    expect(armed.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1)
    h.controller.abort()
    expect(h.instance.getSnapshot().byTab[TAB_ID]).toBeUndefined()
  })
})


it('opens a path menu with the preview pane and requested line', async () => {
  const h = harness({ 1: page(1, ['first'], true) })
  const openFileMenu = vi.fn()
  const view = render(<TextPreview {...h.props({ revision: 1, params: { line: 1 } })} useContextMenu={contextMenuHook(openFileMenu)} />)
  await settle()
  fireEvent.contextMenu(view.container.querySelector('[data-textpreview-path]')!, { clientX: 33, clientY: 44 })
  expect(openFileMenu).toHaveBeenCalledWith({ kind: 'file', value: { sessionId: SESSION, path: ABSOLUTE_PATH, line: 1, paneId: 'pane-1' } }, { x: 33, y: 44 })
  const p = h.props()
  const info = p.useTabInfo()
  view.rerender(<TextPreview {...p} useContextMenu={contextMenuHook(openFileMenu)} useDocumentPreviews={selector => selector([])}
    useTabInfo={() => ({ ...info, tab: { ...info.tab, contentId: 'dsh-resource://file/session/s/archive.zip',
      navigation: { address: 'dsh-resource://file/session/s/archive.zip', revision: 2, params: undefined } } })} />)
  fireEvent.contextMenu(view.container.querySelector('[data-textpreview-path]')!, { clientX: 55, clientY: 66 })
  expect(openFileMenu).toHaveBeenLastCalledWith({ kind: 'file', value: { sessionId: SESSION, path: ABSOLUTE_PATH, paneId: 'pane-1' } }, { x: 55, y: 66 })
  view.rerender(<TextPreview {...h.props({ revision: 3, params: { line: 42 } })}
    useContextMenu={contextMenuHook(openFileMenu)} useDocumentPreviews={selector => selector([])}
    useTabInfo={() => ({ ...info, tab: { ...info.tab, contentId: 'dsh-resource://file/session/s/archive.zip',
      navigation: { address: 'dsh-resource://file/session/s/archive.zip', revision: 3, params: { line: 42 } } } })} />)
  fireEvent.keyDown(view.container.querySelector('[data-textpreview-path]')!, { key: 'F10', shiftKey: true })
  expect(openFileMenu).toHaveBeenLastCalledWith({ kind: 'file', value: {
    sessionId: SESSION, path: ABSOLUTE_PATH, line: 42, paneId: 'pane-1',
  } }, { x: 0, y: 0 })
})

describe('TextPreview — reading position across reloads', () => {
  const VIEW_HEIGHT = 100
  const numbered = (from: number, count: number): string[] => Array.from({ length: count }, (_, i) => `l${from + i}`)

  /** Lay the body out like a browser: one line height per line, offsets clamped to the content. */
  function layOut(element: HTMLElement): void {
    const max = (): number => Math.max(0, element.querySelectorAll('[data-textpreview-line]').length * LINE_HEIGHT - VIEW_HEIGHT)
    let top = 0
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => VIEW_HEIGHT })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => max() + VIEW_HEIGHT })
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => { top = Math.min(top, max()); return top },
      set: (value: number) => { top = Math.max(0, Math.min(value, max())) },
    })
  }

  it('returns to an offset past the first page after a reload emptied the body', async () => {
    const h = harness({ 1: page(1, numbered(1, 10), false), 11: page(11, numbered(11, 10), true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const scrolled = body(view.container)
    layOut(scrolled)
    click(view.container, '[data-textpreview-more]')
    await settle()
    fireEvent.scroll(scrolled, { target: { scrollTop: 300 } })
    h.script(1, page(1, numbered(1, 10), false, 'v2'))
    h.script(11, page(11, numbered(11, 10), true, 'v2'))
    click(view.container, '[data-textpreview-tool="reload"]')
    // The emptied body pins the browser's offset to 0 and reports it as a scroll.
    expect(scrolled.scrollTop).toBe(0)
    fireEvent.scroll(scrolled)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(300)
    await settle()
    expect(h.read).toHaveBeenLastCalledWith(SESSION, PATH, 11, h.controller.signal)
    expect(scrolled.scrollTop).toBe(300)
  })

  it('keeps the remembered offset while a shorter file holds the view at its end', async () => {
    const h = harness({ 1: page(1, numbered(1, 20), true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const scrolled = body(view.container)
    layOut(scrolled)
    fireEvent.scroll(scrolled, { target: { scrollTop: 300 } })
    h.script(1, page(1, numbered(1, 10), true, 'v2'))
    h.setVersion('v2')
    view.rerender(<TextPreview {...h.props()} />)
    await settle()
    fireEvent.scroll(scrolled)
    expect(scrolled.scrollTop).toBe(100)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(300)
    h.script(1, page(1, numbered(1, 20), true, 'v3'))
    h.setVersion('v3')
    view.rerender(<TextPreview {...h.props()} />)
    await settle()
    expect(scrolled.scrollTop).toBe(300)
  })

  it('remembers where the reader scrolls up to, and the next reload keeps that place', async () => {
    const h = harness({ 1: page(1, numbered(1, 20), true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const scrolled = body(view.container)
    layOut(scrolled)
    fireEvent.scroll(scrolled, { target: { scrollTop: 300 } })
    fireEvent.scroll(scrolled, { target: { scrollTop: 120 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(120)
    h.script(1, page(1, numbered(1, 20), true, 'v2'))
    click(view.container, '[data-textpreview-tool="reload"]')
    fireEvent.scroll(scrolled)
    await settle()
    expect(scrolled.scrollTop).toBe(120)
  })
})

describe('TextPreview — workspace navigator Factories', () => {
  /** The navigator occurrences a render holds: the header's toggle, and the content row's navigator after the body. */
  function seats(container: HTMLElement) {
    const row = container.querySelector('[data-textpreview-content]')
    const header = container.querySelector('[data-textpreview-path]')?.parentElement
    return {
      toggle: header?.lastElementChild?.getAttribute('data-navigator-factory'),
      navigator: row?.lastElementChild?.getAttribute('data-navigator-factory'),
    }
  }

  it('keeps the Factory positions\' and the handoff\'s DOM identity while the preview goes from waiting to loaded', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const props = h.props()
    const renderFactorySlot = vi.fn(props.renderFactorySlot)
    const none: TextPreviewProps['useDocumentPreviews'] = select => select([])
    const view = render(<TextPreview {...props} renderFactorySlot={renderFactorySlot} useDocumentPreviews={none} />)
    expect(renderFactorySlot.mock.calls).toEqual([
      ['sidebar.files.navigator.toggle', { useTabInfo: props.useTabInfo }],
      ['sidebar.files.navigator', { useTabInfo: props.useTabInfo, page: false, onOpen: expect.any(Function) as FileNavigatorInput['onOpen'] }],
    ])
    expect(view.container.querySelector('[data-textpreview-state="loading"]')).not.toBeNull()
    expect(seats(view.container)).toEqual({
      toggle: 'sidebar.files.navigator.toggle', navigator: 'sidebar.files.navigator',
    })
    const navigator = view.container.querySelector<HTMLElement>('[data-textpreview-content] > [data-navigator-factory]')!
    const toggle = view.container.querySelector('[data-textpreview-path]')?.parentElement?.lastElementChild
    const handoff = view.container.querySelector('[data-slot="sidebar.right.tab.document.actions"]')
    expect(handoff?.getAttribute('data-slot-path')).toBe(ABSOLUTE_PATH)
    expect(toggle?.previousElementSibling).toBe(handoff)
    navigator.tabIndex = 0
    navigator.focus()
    navigator.scrollTop = 64
    view.rerender(<TextPreview {...props} renderFactorySlot={renderFactorySlot} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-state="text"]')).not.toBeNull()
    expect(seats(view.container)).toEqual({
      toggle: 'sidebar.files.navigator.toggle', navigator: 'sidebar.files.navigator',
    })
    expect(view.container.querySelector('[data-textpreview-content] > [data-navigator-factory]')).toBe(navigator)
    expect(view.container.querySelector('[data-textpreview-path]')?.parentElement?.lastElementChild).toBe(toggle)
    // The handoff keeps its seat between the tools and the toggle in every state.
    expect(view.container.querySelector('[data-slot="sidebar.right.tab.document.actions"]')).toBe(handoff)
    expect(toggle?.previousElementSibling).toBe(handoff)
    expect(document.activeElement).toBe(navigator)
    expect(navigator.scrollTop).toBe(64)
  })

  it.each([false, true])('owns the navigator open callback and replaces itself (floating: %s)', async (isFloating) => {
    const h = harness({ 1: page(1, ['a'], true) })
    const props = h.props()
    const info = props.useTabInfo()
    const openResource = vi.fn()
    const useTabInfo: TextPreviewProps['useTabInfo'] = () => ({
      ...info, panel: { ...info.panel, isFloating }, tab: { ...info.tab, actions: { ...info.tab.actions, openResource } },
    })
    let open: ((address: string) => void) | undefined
    const renderFactorySlot: TextPreviewProps['renderFactorySlot'] = (name, input) => {
      if (name === 'sidebar.files.navigator') open = (input as FileNavigatorInput).onOpen
      return null
    }
    render(<TextPreview {...props} useTabInfo={useTabInfo} renderFactorySlot={renderFactorySlot} />)
    await settle()
    expect(open).toBeTypeOf('function')
    open!('dsh-resource://file/session/s-1/b.txt')
    expect(openResource).toHaveBeenCalledExactlyOnceWith('dsh-resource://file/session/s-1/b.txt', { replaceTab: true })
  })

  it('starts a text preview without a notice with its header', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    const preview = view.container.querySelector('[data-textpreview-state="text"]')
    expect(preview?.firstElementChild?.contains(view.container.querySelector('[data-textpreview-path]'))).toBe(true)
    expect(view.container.querySelector('[data-textpreview-changed], [data-textpreview-meta-failed]')).toBeNull()
  })

  it('keeps the navigator\'s and the toggle\'s DOM nodes from unsupported through loading to text', async () => {
    const h = harness({ 1: page(1, ['a'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const address = 'dsh-resource://file/session/s-1/work/clip.mp4'
    const useTabInfo: TextPreviewProps['useTabInfo'] = () => (
      { ...info, tab: { ...info.tab, contentId: address, navigation: { ...info.tab.navigation, address } } }
    )
    const video: DocumentPreviewDefinition = { id: 'video', extensions: ['mp4'], title: () => 'Video', loading: 'text-pages' }
    const none: TextPreviewProps['useDocumentPreviews'] = select => select([])
    const some: TextPreviewProps['useDocumentPreviews'] = select => select([video])
    const props = { ...base, useTabInfo }
    const view = render(<TextPreview {...props} useDocumentPreviews={none} />)
    await settle()
    const nodes = () => ({
      navigator: view.container.querySelector('[data-textpreview-content]')?.lastElementChild,
      toggle: view.container.querySelector('[data-textpreview-path]')?.parentElement?.lastElementChild,
    })
    expect(view.container.querySelector('[data-textpreview-state="unsupported"]')).not.toBeNull()
    const first = nodes()
    expect(first.navigator?.getAttribute('data-navigator-factory')).toBe('sidebar.files.navigator')
    expect(first.toggle?.getAttribute('data-navigator-factory')).toBe('sidebar.files.navigator.toggle')
    const live = h.useResource()
    h.useResource.mockReturnValue({ status: 'none', value: undefined, failure: undefined })
    view.rerender(<TextPreview {...props} useDocumentPreviews={some} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-state="loading"]')).not.toBeNull()
    expect(nodes().navigator).toBe(first.navigator)
    expect(nodes().toggle).toBe(first.toggle)
    h.useResource.mockReturnValue(live)
    view.rerender(<TextPreview {...props} useDocumentPreviews={some} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-state="text"]')).not.toBeNull()
    expect(nodes().navigator).toBe(first.navigator)
    expect(nodes().toggle).toBe(first.toggle)
  })

  it('does not re-render the navigator Factories for a preview-only update', async () => {
    const h = harness({ 1: page(1, ['a', 'b'], true) })
    const props = h.props()
    const renderFactorySlot = vi.fn(props.renderFactorySlot)
    const view = render(<TextPreview {...props} renderFactorySlot={renderFactorySlot} />)
    await settle()
    renderFactorySlot.mockClear()
    h.useResource.mockClear()
    fireEvent.scroll(body(view.container), { target: { scrollTop: 40 } })
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.scrollTop).toBe(40)
    // The preview read its metadata again, so it re-rendered.
    expect(h.useResource).toHaveBeenCalled()
    expect(renderFactorySlot).not.toHaveBeenCalled()
  })

})
