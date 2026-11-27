// @vitest-environment jsdom
/**
 * Office views in two panes and in a floating window keep their own documents, channels, and visibility, and share
 * the document's fullscreen through frame forwarding: the slideshow holds it and covered views stop rendering.
 */
import { officeLease } from './helpers/office-lease.client.ts'
import { useCallback, useSyncExternalStore } from 'react'
import { OfficeBody, type OfficeBodyProps, type OfficeNativeOwner } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/office/OfficeBody.tsx'
import { createOfficeStore, type OfficeState } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/office/store.ts'
import { officeFace } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/office/face.ts'
import type { DocumentBodyOwner } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/document/contract.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeDocumentId } from '../src/types.ts'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import type { FrameForwardingViewport, FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import { Preview, type PreviewProps } from '../src/client/Preview.tsx'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import { RetainedViews } from '../src/client/RetainedViews.tsx'
import { OfficePreviewClient } from '../src/client/service.ts'
import { createPresentationStore } from '../src/client/presentation-store.ts'
import { en } from '../src/client/locales.ts'
import { mountEnvironment } from './helpers/mount-environment.client.ts'
import type { OfficePaintRequest, OfficePagePreviewRequest } from '../src/types.ts'
import { fakeVideoFrame, fakeFrameForwarding, fakeFullscreen } from './helpers/frame-forwarding.client.ts'

const restores: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => {
  cleanup()
  for (const restore of restores.splice(0)) restore()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

const kinds = { docx: 'text', xlsx: 'spreadsheet', pptx: 'presentation' } as const
type Extension = keyof typeof kinds

function fixture() {
  const env = mountEnvironment()
  restores.push(env.restore)
  const fullscreen = fakeFullscreen()
  restores.push(() => { fullscreen.restore() })
  const wire = fakeFrameForwarding()
  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const documents = new Map<string, { extension: Extension; rx: string }>()
  const status = (id: string) => ({ documentId: id,
    nativeView: { rx: documents.get(id)!.rx, frameTimeoutMs: 60_000 } })
  const info = (id: string, part = 0) => ({ documentType: kinds[documents.get(id)!.extension], width: 15000, height: 18000,
    rectangles: '0,0,15000,18000', part, parts: [{ index: 0, name: 'First' }, { index: 1, name: 'Second' }] })
  let opened = 0
  /** Viewport requests in flight per document, to observe serialization. */
  const inFlight = new Map<string, number>(), peak = new Map<string, number>()
  let viewportGate: Promise<void> | undefined
  const remote = {
    open: vi.fn((_session: unknown, request: { path: string }) => (async function* () {
      const id = `doc-${String(++opened)}`
      documents.set(id, { extension: request.path.split('.').at(-1) as Extension, rx: `rx-${String(opened)}` })
      yield { kind: 'opened', document: { ...status(id), format: documents.get(id)!.extension, version: 'v1', info: info(id),
        rendering: { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 0, creditRetryLimit: 3,
          maxPagePreviewBytes: 1048576 },
      } }
    })()),
    events: vi.fn(),
    paint: vi.fn(async (id: string, request: OfficePaintRequest) => {
      const rx = brandString<FrameRxId>(documents.get(id)!.rx)
      wire.receive({ frame: fakeVideoFrame(), release: vi.fn(), metadata: {
        rx, connectionId: wire.connection(rx), generation: request.frame.generation, requestId: 'kit', frameId: 1, revision: 0,
        width: request.pixelWidth, height: request.pixelHeight } })
      return ok({ ...status(id), width: request.pixelWidth, height: request.pixelHeight })
    }),
    pagePreview: vi.fn(async (id: string, request: OfficePagePreviewRequest) => ok({ ...status(id), width: request.pixelWidth,
      height: request.pixelHeight, rgba: new Uint8Array(request.pixelWidth * request.pixelHeight * 4) })),
    info: vi.fn(async (id: string) => ok({ ...status(id), info: info(id) })),
    viewport: vi.fn(async (id: string, _viewport: unknown) => {
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1)
      peak.set(id, Math.max(peak.get(id) ?? 0, inFlight.get(id)!))
      try { await viewportGate } finally { inFlight.set(id, inFlight.get(id)! - 1) }
      return ok({ ...status(id), info: info(id) })
    }),
    part: vi.fn(async (id: string, part: number) => ok({ ...status(id), info: info(id, part) })),
    values: vi.fn(async () => ok({ value: JSON.stringify({ rows: [], columns: [] }) })),
    presentation: vi.fn(async (id: string, _control: { action: string }) => ok(status(id))),
    release: vi.fn(async () => ok(undefined)),

  }
  const ctx = new Context()
  // Engine events stay open until disposal, or until a spec ends them with a terminal error.
  const events = Promise.withResolvers<Error | undefined>()
  ctx.provide('remote', { officePreview: remote, $stream: ({ name }: { name: string }) => name === 'Office document lease' ? officeLease() : ({
    [Symbol.asyncIterator]: async function* () { const error = await events.promise; if (error !== undefined) throw error },
    dispose: async () => { events.resolve(undefined) },
  }) } as never)
  const office = new OfficePreviewClient(ctx, wire.client)
  const presentations = createPresentationStore().create()
  const fallbackStore = createOfficeStore().create()
  const fallbackRead = vi.fn(async (file: { path: string }) => ({ ok: true as const, value: {
    absolutePath: file.path, version: 'v1', offset: 0, eof: true,
    data: new TextEncoder().encode(file.path.endsWith('.xlsx') ? 'Browser spreadsheet' : 'PDF preview'),
  } }))
  const fallback = officeFace(fallbackRead, error => error.message)(brandString<SessionId>('fixture'), fallbackStore.actions)
  function useFallback<T>(selector: (state: OfficeState) => T): T {
    return selector(useSyncExternalStore(fallbackStore.subscribe.bind(fallbackStore), fallbackStore.getSnapshot.bind(fallbackStore)))
  }
  /** One tab occurrence; `visible` and `pane` change as the sidebar moves it. */
  function tab(name: string, extension: Extension, file = name) {
    const controller = new AbortController()
    const address = `dsh-resource://file/session/fixture/${file}.${extension}`
    let current: ReturnType<PreviewProps['useTabInfo']> = {
      sidebar: { expanded: true, fullscreen: false }, panel: { id: brandString<PaneId>('pane'), isFloating: false },
      tab: { id: brandString<TabId>(name), title: `${name}.${extension}`, kind: 'file', contentId: address, visible: true,
        signal: controller.signal, navigation: { address, revision: 1, params: undefined },
        actions: { bindCommands: () => () => {}, openResource: () => {}, openTab: () => {}, close: () => {} } },
    }
    const partial: Partial<PreviewProps> = {
      office, resourceAddress: address, onNativeUnavailable: vi.fn(),
      content: { kind: 'renderer', revision: 1, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() },
      actions: presentations.actions, useTabInfo: () => current,
      useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
      t: (key, params) => (key in en ? en[key as keyof typeof en] : key)
        .replace(/\{(\w+)\}/g, (token, field: string) => String(params?.[field] as string | number | undefined ?? token)),
    }
    const props = partial as PreviewProps
    return {
      name, controller, props,
      show: (visible: boolean) => { current = { ...current, tab: { ...current.tab, visible } } },
      play: () => { presentations.getSnapshot().byTab[brandString<TabId>(name)]!.play() },
    }
  }
  type Tab = ReturnType<typeof tab>
  function Native({ occupant, owner }: { occupant: Tab; owner: OfficeNativeOwner }) {
    const onNativeUnavailable = useCallback(() => {
      occupant.props.onNativeUnavailable()
      owner.onNativeUnavailable()
    }, [occupant, owner.onNativeUnavailable])
    return <Preview {...occupant.props} {...owner} onNativeUnavailable={onNativeUnavailable} />
  }
  function Body({ occupant }: { occupant: Tab }) {
    const partial: Partial<OfficeBodyProps> = {
      ...occupant.props, ...fallback, useStore: useFallback, actions: fallbackStore.actions,
      retainTab: () => {}, t: key => key, wrap: false, scrollportRef: () => {}, addResource: () => {}, setResources: () => {},
      renderSlot: (name, owner: object) => {
        if (name === 'sidebar.right.tab.document.office.native') return <Native occupant={occupant} owner={owner as OfficeNativeOwner} />
        const { content } = owner as DocumentBodyOwner
        return <p data-office-fallback={name.endsWith('.spreadsheet') ? 'spreadsheet' : 'pdf'}>
          {content.kind === 'bytes' ? new TextDecoder().decode(content.data) : ''}</p>
      },
    }
    return <OfficeBody {...partial as OfficeBodyProps} />
  }
  /** Render the retained bodies and each pane's tab; a tab moves by appearing under another pane. */
  function Layout({ panes }: { readonly panes: Readonly<Record<string, Tab | undefined>> }) {
    return <>
      <RetainedViews useViews={observableHook(office.views)} />
      {Object.entries(panes).map(([pane, occupant]) => <section key={pane} data-pane={pane}>
        {occupant === undefined ? null : <Body key={occupant.name} occupant={occupant} />}
      </section>)}
    </>
  }
  const flush = async (): Promise<void> => {
    await act(async () => { await env.flush() })
    // A zero quiet period still schedules a timer. Run it after React commits fit.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await env.flush() })
  }
  const resize = async (width: number): Promise<void> => {
    for (const scroll of document.querySelectorAll<HTMLElement>('[data-office-viewport]')) scroll.dataset.width = String(width)
    await act(async () => { env.resize() }); await flush()
  }
  /** The viewports the Host received for one channel, in order. */
  const viewports = (rx: string): FrameForwardingViewport[] =>
    wire.setViewport.mock.calls.filter(([channel]) => channel === rx).map(([, viewport]) => viewport)
  const pane = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-pane="${name}"]`)!
  return {
    ctx, office, wire, remote, fullscreen, tab, Layout, flush, resize, viewports, pane, peak, fallbackRead,
    gateViewports: () => { const gate = Promise.withResolvers<undefined>(); viewportGate = gate.promise.then(() => {}); return gate },
    dispose: async () => { await ctx.fiber.dispose() },
    /** End the engine event stream as the Gateway does when it cannot resume it. */
    endEvents: (error: Error) => { events.resolve(error) },
  }
}

/** Wait until every view opened its document and sent its first channel viewport. */
const settled = async (f: ReturnType<typeof fixture>, count: number): Promise<void> => {
  // Own the drain to completion: waitFor's wall-clock deadline can abandon a
  // pending async act, leaving its callbacks running during the next test.
  await f.flush()
  expect(f.remote.open).toHaveBeenCalledTimes(count)
  expect(new Set(f.wire.setViewport.mock.calls.map(([rx]) => rx)).size).toBe(count)
  expect(new Set(f.remote.paint.mock.calls.map(([id]) => id)).size).toBe(count)
}

test.each([
  ['different files', 'left', 'right'],
  ['the same file', 'same', 'same'],
] as const)('two panes showing %s keep separate documents, channels, and visibility', async (_case, leftName, rightName) => {
  const f = fixture()
  const left = f.tab(`${leftName}-a`, 'docx', leftName), right = f.tab(`${rightName}-b`, 'docx', rightName)
  const view = render(<f.Layout panes={{ a: left, b: right }} />)
  try {
    await settled(f, 2)
    expect(f.remote.open.mock.calls.map(([, request]) => request.path)).toEqual([`${leftName}.docx`, `${rightName}.docx`])
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
    expect(f.viewports('rx-2').at(-1)).toMatchObject({ visible: true })
    expect(f.pane(view.container, 'a').querySelector('canvas')).not.toBeNull()
    expect(f.pane(view.container, 'b').querySelector('canvas')).not.toBeNull()
    // Switching the tab of one pane hides only that pane's view.
    const before = f.viewports('rx-2').length
    left.show(false)
    view.rerender(<f.Layout panes={{ a: undefined, b: right }} />)
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: false })
    expect(f.viewports('rx-2')).toHaveLength(before)
    left.show(true)
    view.rerender(<f.Layout panes={{ a: left, b: right }} />)
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
    // A failed document releases only its own channel.
    act(() => { for (const listener of f.office.connection.listeners) listener({ documentId: brandString<OfficeDocumentId>('doc-1'), event: { kind: 'failure', error: 'engine exited' } }) })
    await act(async () => {})
    expect(f.wire.close).toHaveBeenCalledWith('rx-1')
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-1')
    expect(left.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.wire.close).not.toHaveBeenCalledWith('rx-2')
    expect(f.viewports('rx-2').every(viewport => viewport.visible)).toBe(true)
    expect(within(f.pane(view.container, 'b')).queryByRole('alert')).toBeNull()
  } finally { view.unmount(); await f.dispose() }
})

test('a floating window keeps its document when it docks back, shows beside an overlapping pane, and resizes serially', async () => {
  const f = fixture()
  const docked = f.tab('docked', 'docx'), floating = f.tab('floating', 'xlsx')
  const view = render(<f.Layout panes={{ a: docked, float: floating }} />)
  try {
    await settled(f, 2)
    // A floating window over a docked pane leaves both views visible.
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
    expect(f.viewports('rx-2').at(-1)).toMatchObject({ visible: true })
    // Dragging the window resizes it several times while the first viewport is still applying; the requests stay
    // serial and the last size wins.
    const gate = f.gateViewports()
    const sent = f.remote.viewport.mock.calls.filter(([id]) => id === 'doc-2').length
    for (const next of [300, 360, 420]) await f.resize(next)
    await act(async () => { gate.resolve(undefined) })
    await f.flush()
    await f.resize(420)
    const widths = f.remote.viewport.mock.calls.filter(([id]) => id === 'doc-2').slice(sent).map(([, request]) => (request as { width: number }).width)
    expect(widths.length).toBeGreaterThanOrEqual(2)
    expect(f.peak.get('doc-2')).toBe(1)
    expect(widths.at(-1)).toBe(Math.max(...widths))
    // Docking the window back moves the same body: no new document, no release, and the channel stays open.
    const target = f.pane(view.container, 'float').firstElementChild!.firstElementChild!
    view.rerender(<f.Layout panes={{ a: floating, float: undefined }} />)
    await f.flush()
    expect(f.pane(view.container, 'a').contains(target)).toBe(true)
    expect(f.remote.open).toHaveBeenCalledTimes(2)
    expect(f.remote.release).not.toHaveBeenCalled()
    expect(f.wire.close).not.toHaveBeenCalled()
    // Floating it again and switching the session hides it; closing the window releases its document and channel.
    view.rerender(<f.Layout panes={{ a: docked, float: floating }} />)
    floating.show(false)
    view.rerender(<f.Layout panes={{ a: docked, float: floating }} />)
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-2').at(-1)).toMatchObject({ visible: false })
    act(() => { floating.controller.abort() })
    view.rerender(<f.Layout panes={{ a: docked, float: undefined }} />)
    await act(async () => {})
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-2')
    await act(async () => {})
    expect(f.wire.close).toHaveBeenCalledWith('rx-2')
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
  } finally { view.unmount(); await f.dispose() }
})

test.each(['pane', 'float'] as const)('a slideshow started from a %s holds fullscreen in place while the views it covers pause', async (host) => {
  const f = fixture()
  const covered = f.tab('covered', 'pptx'), slideshow = f.tab('slideshow', 'pptx')
  const view = render(<f.Layout panes={{ a: covered, [host === 'pane' ? 'b' : 'float']: slideshow }} />)
  try {
    await settled(f, 2)
    await act(async () => { slideshow.play() })
    await f.flush()
    await act(async () => {})
    expect(f.remote.presentation).toHaveBeenCalledWith('doc-2', expect.objectContaining({ action: 'start' }))
    const holder = document.fullscreenElement!
    expect(f.pane(view.container, host === 'pane' ? 'b' : 'float').contains(holder)).toBe(true)
    expect(within(holder as HTMLElement).getByRole('toolbar', { name: en.playbackControls })).toBeDefined()
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: false })
    expect(f.viewports('rx-2').at(-1)).toMatchObject({ visible: true })
    // Only one view holds fullscreen: the covered view cannot start a slideshow of its own meanwhile.
    await act(async () => { covered.play() })
    await act(async () => {})
    expect(within(f.pane(view.container, 'a')).getByRole('alert').textContent).toContain('Another view is already fullscreen.')
    expect(f.remote.presentation).not.toHaveBeenCalledWith('doc-1', expect.anything())
    // Escape leaves fullscreen on its own: the slideshow ends and the covered view renders again.
    act(() => { f.fullscreen.change(null) }); await f.flush()
    await act(async () => {})
    expect(f.remote.presentation).toHaveBeenCalledWith('doc-2', { action: 'stop' })
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
    expect(within(holder as HTMLElement).queryByRole('toolbar', { name: en.playbackControls })).toBeNull()
  } finally { view.unmount(); await f.dispose() }
})

test('closing the tab that holds fullscreen leaves fullscreen and uncovers the other views', async () => {
  const f = fixture()
  const covered = f.tab('covered', 'docx'), slideshow = f.tab('slideshow', 'pptx')
  const view = render(<f.Layout panes={{ a: covered, b: slideshow }} />)
  try {
    await settled(f, 2)
    await act(async () => { slideshow.play() })
    await act(async () => {})
    expect(document.fullscreenElement).not.toBeNull()
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: false })
    act(() => { slideshow.controller.abort() })
    view.rerender(<f.Layout panes={{ a: covered, b: undefined }} />)
    await act(async () => {})
    expect(f.wire.close).toHaveBeenCalledWith('rx-2')
    expect(document.fullscreenElement).toBeNull()
    expect(f.fullscreen.exit).toHaveBeenCalledOnce()
    await f.flush()
    await act(async () => {})
    expect(f.viewports('rx-1').at(-1)).toMatchObject({ visible: true })
  } finally { view.unmount(); await f.dispose() }
})


test.each([
  ['docx', 'crash'], ['docx', 'render'], ['docx', 'unavailable'],
  ['pptx', 'crash'], ['pptx', 'render'], ['pptx', 'unavailable'],
  ['xlsx', 'crash'], ['xlsx', 'render'], ['xlsx', 'unavailable'],
] as const)('%s %s after first paint reports once and displays its format fallback', async (extension, fault) => {
  const f = fixture(), tab = f.tab('document', extension)
  const view = render(<f.Layout panes={{ a: tab }} />)
  try {
    await settled(f, 1)
    expect(f.pane(view.container, 'a').querySelector('canvas')).not.toBeNull()
    await act(async () => {
      if (fault === 'render') f.wire.fail(brandString<FrameRxId>('rx-1'), 'GPU rendering failed')
      else f.office.connection.dispatch({ documentId: brandString<OfficeDocumentId>('doc-1'), event: fault === 'crash'
        ? { kind: 'failure', error: 'engine exited' } : { kind: 'channel', state: 'unavailable', message: 'GPU unavailable' } })
      f.office.connection.dispatch({ documentId: brandString<OfficeDocumentId>('doc-1'), event: { kind: 'failure', error: 'duplicate failure' } })
    })
    await f.flush()
    const expected = extension === 'xlsx' ? 'Browser spreadsheet' : 'PDF preview'
    await act(async () => {})
    expect(within(f.pane(view.container, 'a')).getByText(expected)).toBeDefined()
    expect(tab.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-1')
    expect(f.pane(view.container, 'a').querySelector('canvas')).toBeNull()
    expect(f.pane(view.container, 'a').querySelector('[data-office-fallback]')?.outerHTML).toMatchSnapshot('format fallback')
    act(() => { tab.controller.abort() })
    expect(f.remote.release).toHaveBeenCalledOnce()
  } finally { view.unmount(); await f.dispose() }
})

test('a terminally ended engine event stream switches every open view to its format fallback once', async () => {
  const f = fixture(), text = f.tab('text', 'docx'), sheet = f.tab('sheet', 'xlsx')
  const view = render(<f.Layout panes={{ a: text, b: sheet }} />)
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    await settled(f, 2)
    await act(async () => { f.endEvents(new Error('Office preview events ended.')) })
    await f.flush()
    await act(async () => {})
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'Office preview events ended.' }))
    expect(within(f.pane(view.container, 'a')).getByText('PDF preview')).toBeDefined()
    expect(within(f.pane(view.container, 'b')).getByText('Browser spreadsheet')).toBeDefined()
    expect(text.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(sheet.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.remote.release).toHaveBeenCalledTimes(2)
    expect(f.remote.release).toHaveBeenCalledWith('doc-1')
    expect(f.remote.release).toHaveBeenCalledWith('doc-2')
    await f.flush()
    expect(text.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(sheet.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.remote.open).toHaveBeenCalledTimes(2)
  } finally { view.unmount(); await f.dispose() }
})

test('a hidden tab failure releases once and shows PDF when reattached instead of an empty tab', async () => {
  const f = fixture(), tab = f.tab('hidden', 'docx')
  const view = render(<f.Layout panes={{ a: tab }} />)
  try {
    await settled(f, 1)
    tab.show(false)
    view.rerender(<f.Layout panes={{ a: undefined }} />)
    await act(async () => { f.office.connection.dispatch({ documentId: brandString<OfficeDocumentId>('doc-1'), event: { kind: 'failure', error: 'hidden engine exited' } }) })
    await f.flush()
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-1')
    expect(tab.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.fallbackRead).not.toHaveBeenCalled()
    tab.show(true)
    view.rerender(<f.Layout panes={{ a: tab }} />)
    await act(async () => {})
    expect(within(f.pane(view.container, 'a')).getByText('PDF preview')).toBeDefined()
    expect(f.remote.open).toHaveBeenCalledOnce()
    act(() => { tab.controller.abort() })
    expect(f.remote.release).toHaveBeenCalledOnce()
  } finally { view.unmount(); await f.dispose() }
})

test.each(['pane', 'float'] as const)('failure during a %s slideshow exits fullscreen and releases once while switching to PDF', async (host) => {
  const f = fixture(), tab = f.tab('slideshow', 'pptx'), pane = host === 'pane' ? 'a' : 'float'
  const view = render(<f.Layout panes={{ [pane]: tab }} />)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await settled(f, 1)
    await act(async () => { tab.play() }); await f.flush()
    expect(document.fullscreenElement).not.toBeNull()
    await act(async () => { f.office.connection.dispatch({ documentId: brandString<OfficeDocumentId>('doc-1'), event: { kind: 'failure', error: 'slideshow engine exited' } }) })
    await f.flush()
    await act(async () => {})
    expect(within(f.pane(view.container, pane)).getByText('PDF preview')).toBeDefined()
    expect(document.fullscreenElement).toBeNull()
    expect(f.fullscreen.exit).toHaveBeenCalledOnce()
    expect(tab.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-1')
    expect(log).not.toHaveBeenCalled()
    view.rerender(<f.Layout panes={{ a: tab }} />)
    await f.flush()
    expect(within(f.pane(view.container, 'a')).getByText('PDF preview')).toBeDefined()
    expect(f.remote.open).toHaveBeenCalledOnce()
  } finally { view.unmount(); await f.dispose() }
})

test('a renderer reattachment rejected by the Host reports once and displays PDF without a second release', async () => {
  const f = fixture(), tab = f.tab('reattached', 'docx')
  // The Host already closes the failed retained engine before rejecting this reattachment.
  f.remote.open.mockImplementationOnce(() => (async function* () { yield* []; throw new Error('retained engine exited') })())
  const view = render(<f.Layout panes={{ a: tab }} />)
  try {
    await act(async () => {})
    expect(within(f.pane(view.container, 'a')).getByText('PDF preview')).toBeDefined()
    expect(tab.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.remote.release).not.toHaveBeenCalled()
    view.rerender(<f.Layout panes={{ float: tab }} />)
    await f.flush()
    expect(within(f.pane(view.container, 'float')).getByText('PDF preview')).toBeDefined()
    expect(f.remote.open).toHaveBeenCalledOnce()
  } finally { view.unmount(); await f.dispose() }
})


test('fallback release waits for the final slideshow stream command', async () => {
  const f = fixture(), tab = f.tab('slideshow', 'pptx'), stopped = Promise.withResolvers<undefined>()
  const view = render(<f.Layout panes={{ a: tab }} />)
  const original = f.remote.presentation.getMockImplementation()!
  try {
    await settled(f, 1)
    await act(async () => { tab.play() }); await f.flush()
    f.remote.presentation.mockImplementation(async (id, control) => {
      if (control.action === 'stream' && 'enabled' in control && control.enabled === false) await stopped.promise
      return original(id, control)
    })
    await act(async () => { f.office.connection.dispatch({ documentId: brandString<OfficeDocumentId>('doc-1'), event: { kind: 'failure', error: 'engine exited' } }) })
    await f.flush()
    expect(f.remote.presentation).toHaveBeenCalledWith('doc-1', expect.objectContaining({ action: 'stream', enabled: false }))
    expect(f.remote.release).not.toHaveBeenCalled()
    expect(document.fullscreenElement).toBeNull()
    await act(async () => { stopped.resolve(undefined) }); await f.flush()
    expect(f.remote.release).toHaveBeenCalledExactlyOnceWith('doc-1')
    expect(within(f.pane(view.container, 'a')).getByText('PDF preview')).toBeDefined()
  } finally { stopped.resolve(undefined); view.unmount(); await f.dispose() }
})
