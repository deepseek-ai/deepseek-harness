// @vitest-environment jsdom
/** Native Office documents survive real body unmounts and close with their tab occurrence. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { Preview, type PreviewProps } from '../src/client/Preview.tsx'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import { RetainedViews } from '../src/client/RetainedViews.tsx'
import { OfficePreviewClient } from '../src/client/service.ts'
import { createPresentationStore } from '../src/client/presentation-store.ts'
import { en } from '../src/client/locales.ts'
import type { OfficeOpenedDocument, OfficeDocumentId, OfficePagePreviewRequest } from '../src/types.ts'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import css from '../src/client/Editor.module.css'
import { mountEnvironment } from './helpers/mount-environment.client.ts'
import { fakeVideoFrame, fakeFrameForwarding } from './helpers/frame-forwarding.client.ts'
import { FrameForwardingOfficeSession } from '../src/client/frame-forwarding.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'error')
})
afterEach(() => {
  cleanup()
  try { expect(console.error).not.toHaveBeenCalled() }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() }
})

const formats = [
  { extension: 'docx', documentType: 'text' },
  { extension: 'xlsx', documentType: 'spreadsheet' },
  { extension: 'pptx', documentType: 'presentation' },
] as const

function fixture() {
  const env = mountEnvironment(), wire = fakeFrameForwarding()
  const sessions = new Map<string, FrameForwardingOfficeSession>()
  const visibility = vi.fn()
  wire.setViewport.mockImplementation(async (rx, viewport) => { visibility(rx, viewport.visible); return undefined })
  const ctx = new Context()
  ctx.effect(() => () => { env.restore() })
  const calls: { op: string; id: string | undefined }[] = []
  const closed = new Set<string>()
  const status = (op: string, id: OfficeDocumentId) => {
    if (closed.has(id)) throw new Error('Office document is closed.')
    calls.push({ op, id })
    return { documentId: id }
  }
  ctx.provide('remote', { officePreview: {
    viewport: async (id: OfficeDocumentId) => ({ ok: true, value: status('viewport', id) }),
    values: async (id: OfficeDocumentId) => ({ ok: true, value: { ...status('values', id), value: '{"rows":[],"columns":[]}' } }),
    pagePreview: async (id: OfficeDocumentId, value: OfficePagePreviewRequest) => ({ ok: true, value: { ...status('pagePreview', id),
      width: value.pixelWidth, height: value.pixelHeight, rgba: new Uint8Array(value.pixelWidth * value.pixelHeight * 4) } }),
  }, $stream: () => ({ [Symbol.asyncIterator]: async function* () {}, dispose: async () => {} }) } as never)
  const office = new OfficePreviewClient(ctx, wire.client)
  vi.spyOn(office.connection, 'frameForwardingSession').mockImplementation(id => sessions.get(id))
  ctx.effect(() => async () => { await Promise.all([...sessions.values()].map(session => session.close())) })
  let opens = 0
  const open = vi.spyOn(office.connection, 'open').mockImplementation(async ({ address }): Promise<OfficeOpenedDocument> => {
    calls.push({ op: 'open', id: undefined })
    const format = formats.find(format => address.endsWith(format.extension))!
    const id = brandString<OfficeDocumentId>(`${format.extension}-${++opens}`)
    sessions.set(id, new FrameForwardingOfficeSession(wire.client.connect(brandString<FrameRxId>(id)), 1000))
    return {
      documentId: id, format: format.extension, version: 'v1',
      rendering: { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 0, creditRetryLimit: 3,
        maxPagePreviewBytes: 1048576 },
      info: { renderBackend: 'ganesh', documentType: format.documentType, width: 15000, height: 18000, rectangles: '0,0,15000,18000',
        part: 0, parts: [{ index: 0, name: 'First' }, { index: 1, name: 'Second' }] },
    }
  })
  const release = vi.spyOn(office.connection, 'release').mockImplementation(async (id) => { status('release', id); closed.add(id) })
  vi.spyOn(office.connection, 'requestFrame').mockImplementation(async (id, _value, generation) => {
    const rx = brandString<FrameRxId>(id)
    wire.receive({ frame: fakeVideoFrame(), release: vi.fn(), metadata: {
      rx, connectionId: wire.connection(rx), requestId: 'kit', generation, frameId: 1, revision: 0, width: 1, height: 1 } })
    return { ...status('paint', id), width: 1, height: 1 }
  })
  const entries = formats.map((format) => {
    const controller = new AbortController()
    const address = `dsh-resource://file/session/fixture/file.${format.extension}`
    const info: ReturnType<PreviewProps['useTabInfo']> = {
      sidebar: { expanded: true, fullscreen: false }, panel: { id: brandString<PaneId>('pane'), isFloating: false },
      tab: { id: brandString<TabId>(format.extension), title: `file.${format.extension}`, kind: 'file',
        contentId: address, visible: true, signal: controller.signal,
        navigation: { address, revision: 1, params: undefined },
        actions: { bindCommands: () => () => {}, openResource: () => {}, openTab: () => {}, close: () => {} } },
    }
    const partial: Partial<PreviewProps> = {
      office, resourceAddress: address, onNativeUnavailable: vi.fn(),
      content: { kind: 'renderer', revision: 1, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() },
      actions: createPresentationStore().create().actions,
      useTabInfo: () => info,
      useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
      t: (key, params) =>
        (key in en ? en[key as keyof typeof en] : key).replace(/\{(\w+)\}/g, (token, name: string) => {
          const value = params?.[name]
          return typeof value === 'string' || typeof value === 'number' ? String(value) : token
        }),
    }
    return { controller, props: partial as PreviewProps }
  })
  const flush = async (): Promise<void> => {
    await act(async () => { await env.flush() })
    // Fit and manual zoom finish through the configured zero-delay timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await env.flush() })
  }
  function Harness({ selected }: { selected: number | undefined }) {
    const held = useSyncExternalStore(office.views.subscribe, office.views.getSnapshot)
    return <><RetainedViews useViews={observableHook(office.views)} />
      <output data-retained-count>{held.length}</output>
      {selected === undefined ? null : <Preview key={selected} {...entries[selected]!.props} />}</>
  }
  return { ctx, office, entries, calls, open, release, closed, visibility, flush, Harness }
}

test.each(formats)('$extension retains its session, scroll, zoom, selection and mounted image across tab switches', async (format) => {
  const f = fixture(), index = formats.indexOf(format)
  const others = [(index + 1) % formats.length, (index + 2) % formats.length]
  const view = render(<f.Harness selected={index} />)
  try {
    await act(async () => {})
    expect(view.container.querySelector('canvas')).not.toBeNull()
    await f.flush()
    const drawing = view.container.querySelector<HTMLElement>('[data-office-document-area]')!
    const scroll = drawing.querySelector<HTMLDivElement>(`.${css.viewport}`)!
    fireEvent.click(within(view.container).getByRole('button', { name: en.zoomIn }))
    await f.flush()
    const retainedZoom = within(view.container).getByRole('button', { name: en.zoom }).textContent
    scroll.scrollLeft = 85; scroll.scrollTop = 125
    fireEvent.scroll(scroll)
    await f.flush()
    const id = f.calls.find(call => call.op === 'viewport')!.id!
    act(() => {
      for (const listener of f.office.connection.listeners)
        listener({ documentId: brandString<OfficeDocumentId>(id), event: { kind: 'callback', type: 2, payload: '1500,3000,900,450' } })
    })
    const selection = drawing.querySelector<HTMLElement>('[data-office-selection]')!
    const images = [...drawing.querySelectorAll<HTMLVideoElement>('[data-office-surface] video')]
    expect(images.length).toBeGreaterThan(0)
    const painted = f.calls.filter(call => call.op === 'paint' && call.id === id).length
    for (const [opened, other] of others.entries()) {
      view.rerender(<f.Harness selected={other} />)
      await act(async () => {})
      expect(f.calls.filter(call => call.op === 'open')).toHaveLength(opened + 2)
      await f.flush()
    }
    expect(f.calls.filter(call => call.op === 'release')).toEqual([])
    expect(f.visibility).toHaveBeenCalledWith(id, false)
    view.rerender(<f.Harness selected={index} />)
    await f.flush()
    for (const other of [...others, index]) {
      view.rerender(<f.Harness selected={other} />)
      await f.flush()
    }
    expect(view.container.querySelector('[data-office-document-area]')).toBe(drawing)
    expect(drawing.querySelector('[data-office-selection]')).toBe(selection)
    expect([...drawing.querySelectorAll('[data-office-surface] video')]).toEqual(images)
    expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([85, 125])
    expect(within(view.container).getByRole('button', { name: en.zoom }).textContent).toBe(retainedZoom)
    expect(f.calls.filter(call => call.op === 'paint' && call.id === id).length).toBeGreaterThanOrEqual(painted)
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(3)
    expect(f.calls.filter(call => call.op === 'release')).toEqual([])
    expect(f.visibility.mock.calls.filter(call => call[0] === id).at(-1)).toEqual([id, true])
    expect({ format: format.extension, scroll: [scroll.scrollLeft, scroll.scrollTop],
      zoom: within(view.container).getByRole('button', { name: en.zoom }).textContent,
      selection: selection.style.cssText, retained: view.container.querySelector('output')!.textContent,
      loading: view.container.querySelector('[data-office-interaction-overlay]')!.getAttribute('style'),
    }).toMatchSnapshot('restored native view')
    view.rerender(<f.Harness selected={undefined} />)
    act(() => { f.entries[index]!.controller.abort() })
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'release' && call.id === id)).toHaveLength(1)
    expect(f.office.views.getSnapshot()).toHaveLength(2)
    expect(images.every(image => image.width === 0 && image.height === 0)).toBe(true)
    act(() => { for (const other of others) f.entries[other]!.controller.abort() })
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'release')).toHaveLength(3)
  } finally { view.unmount(); await f.ctx.fiber.dispose() }
})

test('closing a hidden tab while its native open is pending releases the eventual document once', async () => {
  const f = fixture(), opening = Promise.withResolvers<undefined>()
  const open = f.open.getMockImplementation()!
  f.open.mockImplementationOnce(async (...args) => { await opening.promise; return open(...args) })
  const view = render(<f.Harness selected={0} />)
  try {
    view.rerender(<f.Harness selected={undefined} />)
    expect(f.calls.filter(call => call.op === 'release')).toEqual([])
    act(() => { f.entries[0]!.controller.abort() })
    await act(async () => { opening.resolve(undefined) })
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'release')).toEqual([{ op: 'release', id: 'docx-1' }])
    expect(f.office.views.getSnapshot()).toEqual([])
  } finally { view.unmount(); await f.ctx.fiber.dispose() }
})

test('unloading Office releases attached and hidden bodies', async () => {
  const f = fixture(), view = render(<f.Harness selected={0} />)
  try {
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(1)
    view.rerender(<f.Harness selected={1} />)
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(2)
    await act(async () => { await f.ctx.fiber.dispose() })
    await act(async () => {})
    expect(f.calls.filter(call => call.op === 'release')).toHaveLength(2)
    expect(f.office.views.getSnapshot()).toEqual([])
  } finally { view.unmount(); await f.ctx.fiber.dispose() }
})

test.each(formats)('$extension refresh opens a new session while the previous revision is still releasing', async (format) => {
  const f = fixture(), index = formats.indexOf(format), open = f.open.getMockImplementation()!
  const owned = new Map<string, OfficeOpenedDocument>(), closing = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  const closed = new Set<string>(), opens: string[] = []
  let blockRelease = true
  f.open.mockImplementation(async (fields, progress) => {
    const key = JSON.stringify([fields.address, fields.owner, fields.revision])
    const reply = owned.get(key) ?? await open(fields, progress)
    owned.set(key, reply)
    opens.push(reply.documentId)
    return reply
  })
  f.release.mockImplementation(async (id) => {
    f.calls.push({ op: 'release', id })
    const release = Promise.withResolvers<undefined>()
    closing.set(id, release)
    if (blockRelease) await release.promise
    closed.add(id)
    f.closed.add(id)
    for (const [key, reply] of owned) if (reply.documentId === id) owned.delete(key)
  })
  const view = render(<f.Harness selected={index} />)
  const visible: { revision: number; native: boolean; nativeUnavailableReported: boolean }[] = []
  try {
    await act(async () => {})
    expect(view.container.querySelector('canvas')).not.toBeNull()
    await f.flush()
    for (const revision of [2, 3, 4]) {
      const previous = opens.at(-1)!
      f.entries[index]!.props = { ...f.entries[index]!.props,
        content: { kind: 'renderer', revision, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() } }
      view.rerender(<f.Harness selected={index} />)
      await act(async () => {})
      expect(closing.has(previous)).toBe(true); expect(opens).toHaveLength(revision)
      expect(closed.has(previous)).toBe(false)
      expect(opens.at(-1)).not.toBe(previous)
      await act(async () => { closing.get(previous)!.resolve(undefined) })
      await f.flush()
      await act(async () => {})
      expect(f.calls.some(call => call.op === 'paint' && call.id === opens.at(-1))).toBe(true)
      visible.push({ revision, native: view.container.querySelector('canvas') !== null,
        nativeUnavailableReported: vi.mocked(f.entries[index]!.props.onNativeUnavailable).mock.calls.length > 0 })
      expect(visible.at(-1)).toEqual({ revision, native: true, nativeUnavailableReported: false })
      expect(f.office.views.getSnapshot()).toHaveLength(1)
    }
    expect(visible).toMatchSnapshot('native views after repeated refresh')
    act(() => { f.entries[index]!.controller.abort() })
    await act(async () => {})
    expect(closing.has(opens.at(-1)!)).toBe(true)
    await act(async () => { closing.get(opens.at(-1)!)!.resolve(undefined) })
    expect(closed.size).toBe(4)
    expect(owned.size).toBe(0)
  } finally {
    blockRelease = false
    view.unmount()
    await act(async () => { for (const release of closing.values()) release.resolve(undefined) })
    await f.ctx.fiber.dispose()
  }
})

test('a failed native open reports unavailability once and leaves the retained body empty', async () => {
  const f = fixture()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const open = f.open.getMockImplementation()!
  f.open.mockImplementation(async (fields, progress) => {
    if (fields.address.endsWith('docx')) {
      f.calls.push({ op: 'open', id: undefined })
      throw new Error('open failed')
    }
    return open(fields, progress)
  })
  const view = render(<f.Harness selected={0} />)
  try {
    await act(async () => {})
    expect(f.entries[0]!.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-office-document-area]')).toBeNull()
    view.rerender(<f.Harness selected={1} />)
    view.rerender(<f.Harness selected={0} />)
    expect(f.entries[0]!.props.onNativeUnavailable).toHaveBeenCalledOnce()
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(2)
  } finally { view.unmount(); await act(async () => { await f.ctx.fiber.dispose() }) }
})

test('registry observers, stale detach callbacks and aborted occurrences cannot lose another mounted body', async () => {
  const f = fixture()
  const props = f.entries[0]!.props, signal = f.entries[0]!.controller.signal
  const a = document.createElement('div'), b = document.createElement('div')
  try {
    const log = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const unsubscribe = f.office.views.subscribe(() => { throw new Error('observer failed') })
    const oldDetach = f.office.views.attach(signal, a, props)
    const newDetach = f.office.views.attach(signal, b, props)
    oldDetach()
    expect(b.childElementCount).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer failed' }))
    f.office.views.update(new AbortController().signal, props)
    f.office.views.update(signal, props)
    newDetach(); newDetach()
    f.entries[0]!.controller.abort()
    f.office.views.attach(signal, a, props)()
    unsubscribe()
    f.office.views.dispose(); f.office.views.dispose()
    f.office.views.attach(new AbortController().signal, a, props)()
    expect(f.office.views.getSnapshot()).toEqual([])
  } finally { await f.ctx.fiber.dispose() }
})
