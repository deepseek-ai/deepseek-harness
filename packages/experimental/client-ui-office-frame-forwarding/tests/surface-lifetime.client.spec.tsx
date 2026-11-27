// @vitest-environment jsdom
/** Surface shutdown joins admitted work before its successor mounts. */
import { officeLease } from './helpers/office-lease.client.ts'
import { act, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DocumentSurface } from '../src/client/DocumentSurface.tsx'
import { OfficeConnection, type OfficePreviewRemote } from '../src/client/connection.ts'
import { FrameForwardingOfficeSession } from '../src/client/frame-forwarding.ts'
import { fakeFrameForwarding } from './helpers/frame-forwarding.client.ts'
import { mountEnvironment } from './helpers/mount-environment.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const documentId = brandString<import('../src/types.ts').OfficeDocumentId>('doc')
type Props = ComponentProps<typeof DocumentSurface>
function fixture(kind: 'text' | 'spreadsheet' | 'presentation' = 'text', configure?: (props: Props) => void) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const env = mountEnvironment(), wire = fakeFrameForwarding()
  const rx = wire.client.connect(brandString<FrameRxId>('surface')), session = new FrameForwardingOfficeSession(rx, 1000)
  const connection = new OfficeConnection(wire.client, {} as OfficePreviewRemote, officeLease)
  vi.spyOn(connection, 'frameForwardingSession').mockReturnValue(session)
  const scroll = document.createElement('div'), content = document.createElement('div'), layer = document.createElement('div')
  const mount = document.createElement('div')
  scroll.setAttribute('data-office-viewport', ''); scroll.append(content); content.append(layer, mount); document.body.append(scroll)
  const send = { viewport: vi.fn(async () => ({ documentId })), playback: vi.fn(async () => ({ documentId })),
    values: vi.fn(async () => ({ value: JSON.stringify({ rows: [{ text: '0', size: 0 }, { text: '1', size: 300 }],
      columns: [{ text: '0', size: 0 }, { text: 'A', size: 600 }] }) })),
    pagePreview: vi.fn(async () => ({ documentId, width: 1, height: 1, rgba: new Uint8Array(4) })),
  } satisfies Props['send']
  const paint = vi.fn<Props['paint']>(async () => {})
  const failure = vi.fn(), ready = vi.fn(), waiting = vi.fn(), size = vi.fn()
  const props: Props = {
    document: { id: documentId, info: { renderBackend: 'ganesh', documentType: kind, width: 12000, height: 18000, part: 0,
      parts: [], rectangles: kind === 'text' ? '0,0,12000,18000' : '' },
    rendering: { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 120,
      creditRetryLimit: 1, maxPagePreviewBytes: 4 } },
    connection, channelEpoch: 0, playing: false, suspended: false, failed: false, visible: true, zoom: 1,
    viewport: { current: scroll }, documentElement: { current: content }, previewLayer: { current: layer },
    rows: { current: kind === 'spreadsheet' ? document.createElement('div') : null },
    columns: { current: kind === 'spreadsheet' ? document.createElement('div') : null },
    contentView: { current: undefined }, controls: { current: undefined }, send, paint, failure, waiting, initial: vi.fn(),
    pageReady: ready, size, t: (key, parameters) => en[key as keyof typeof en].replace('{label}', String(parameters?.label)),
  }
  configure?.(props)
  const view = render(<DocumentSurface {...props} />, { container: mount })
  const flush = async () => { await act(async () => { await env.flush() }) }
  const close = async () => {
    const stopped = props.controls.current?.stop()
    view.unmount()
    try { await stopped } finally {
      try { await session.close() } finally { wire.dispose(); scroll.remove(); env.restore() }
    }
  }
  return { props, view, send, paint, failure, ready, waiting, size, env, wire, session, scroll, layer, flush,
    rerender: () => { view.rerender(<DocumentSurface {...props} />) },
    close, [Symbol.asyncDispose]: close }
}

test('headers refresh at the same viewport and stale values are replaced before display', async () => {
  const f = fixture('spreadsheet'), pending = Promise.withResolvers<{ value: string }>()
  try {
    await f.flush()
    f.send.values.mockImplementationOnce(async () => pending.promise)
    act(() => { f.props.controls.current!.headers(); f.props.controls.current!.headers() })
    pending.resolve({ value: JSON.stringify({ rows: [{ text: '1', size: 300, start: 0 }], columns: [{ text: 'A', size: 600, start: 0 }] }) })
    await f.flush()
    expect(f.send.values.mock.calls).toHaveLength(3)
  } finally { pending.resolve({ value: '{}' }); await f.close() }
})

test.each(['viewport', 'values'] as const)('stopping during %s does not publish late geometry or paint', async (operation) => {
  const pending = Promise.withResolvers<{ value: string }>()
  const f = fixture('spreadsheet', (props) => {
    if (operation === 'values') props.send.values = () => pending.promise
    else props.send.viewport = async () => { await pending.promise; return { documentId } }
  })
  try {
    await f.flush()
    const controls = f.props.controls.current!, stopped = controls.stop()
    controls.refresh(); f.env.resize()
    pending.resolve({ value: JSON.stringify({ rows: [], columns: [] }) }); await stopped
    expect(f.paint).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  } finally { pending.resolve({ value: '{}' }); await f.close() }
})

test('a successor waits for the preceding page request to settle before attaching', async () => {
  const pending = Promise.withResolvers<{ width: number; height: number; rgba: Uint8Array<ArrayBuffer> }>()
  const f = fixture('text', (props) => {
    props.send.pagePreview = async () => ({ documentId, ...await pending.promise })
  })
  try {
    await f.flush()
    const mount = vi.spyOn(f.session, 'mount')
    f.props.channelEpoch++; f.rerender(); await f.flush()
    expect(mount).not.toHaveBeenCalled()
    f.props.channelEpoch++; f.rerender(); await f.flush()
    pending.resolve({ width: 1, height: 1, rgba: new Uint8Array(4) }); await f.flush()
    expect(mount).toHaveBeenCalledOnce()
    expect(f.failure).not.toHaveBeenCalled()
  } finally { pending.resolve({ width: 1, height: 1, rgba: new Uint8Array(4) }); await f.close() }
})

test.each(['paint', 'trim'] as const)('stop cancels the producer acknowledgement for %s before the frame deadline', async (phase) => {
  const f = fixture(), ack = Promise.withResolvers<undefined>()
  const ready = vi.spyOn(f.session.rx, 'ready')
  f.wire.setViewport.mockImplementation(async (_rx, viewport) => viewport.visible === (phase === 'paint') ? ack.promise : undefined)
  if (phase === 'trim') f.paint.mockRejectedValueOnce(new RemoteError('office/frame-retry', 'retry', { reason: 'credit-timeout' }))
  try {
    await f.flush()
    expect(f.session.rx.viewport?.visible).toBe(phase === 'paint')
    expect(ready.mock.settledResults.at(-1)?.type).toBe('incomplete')
    const finished = vi.fn()
    const stopped = f.props.controls.current!.stop().then(finished)
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toHaveBeenCalledOnce()
    await stopped
    expect(f.failure).not.toHaveBeenCalled()
  } finally { ack.resolve(undefined); await f.close() }
})

test('stop joins a paint already sent to the engine', async () => {
  const f = fixture(), painted = Promise.withResolvers<undefined>()
  f.paint.mockReturnValueOnce(painted.promise)
  try {
    await f.flush()
    expect(f.paint).toHaveBeenCalledOnce()
    const finished = vi.fn()
    const stopped = f.props.controls.current!.stop().then(finished)
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).not.toHaveBeenCalled()
    painted.resolve(undefined); await stopped
    expect(finished).toHaveBeenCalledOnce()
    expect(f.failure).not.toHaveBeenCalled()
  } finally { painted.resolve(undefined); await f.close() }
})

test.each(['width', 'height', 'rgba'] as const)('an invalid page %s is reported without becoming a ready preview', async (field) => {
  await using f = fixture('text', (props) => {
    props.send.pagePreview = async () => ({ documentId, width: 1, height: 1, rgba: new Uint8Array(4), [field]: 'invalid' })
  })
  await f.flush()
  expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid Office page response.' }))
  expect(f.ready).not.toHaveBeenCalledWith(0)
})

test.each(['stale', 'credit-timeout'] as const)('%s retries the latest paint without failing the document', async (reason) => {
  await using f = fixture('spreadsheet')
  const trim = vi.spyOn(f.session, 'trim').mockResolvedValue()
  f.paint.mockRejectedValueOnce(new RemoteError('office/frame-retry', 'retry', { reason }))
  await f.flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await f.flush()
  expect(f.paint.mock.calls.length).toBeGreaterThan(1)
  expect(f.failure).not.toHaveBeenCalled()
  expect(trim).toHaveBeenCalledTimes(reason === 'credit-timeout' ? 1 : 0)
})

test('a slide can show its static preview while waiting for the first native frame credit', async () => {
  await using f = fixture('presentation', (props) => {
    props.document.info = { ...props.document.info, parts: [{ index: 0, name: 'First' }] }
  })
  f.paint.mockRejectedValueOnce(new RemoteError('office/frame-retry', 'retry', { reason: 'credit-timeout' }))
  await f.flush()
  expect(f.waiting).toHaveBeenCalledWith(true)
  expect(f.ready).toHaveBeenCalledWith(0)
  expect(f.layer.querySelector('[data-office-page-preview="0"]')).not.toBeNull()
})

test('cleanup failure is logged while the following mount can still start', async () => {
  await using f = fixture('spreadsheet')
  const error = new Error('stop failed')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await f.flush()
  const controls = f.props.controls.current!, stop = controls.stop.bind(controls)
  vi.spyOn(controls, 'stop').mockImplementationOnce(async () => { await stop(); throw error })
  f.props.channelEpoch++; f.rerender(); await f.flush()
  expect(warn).toHaveBeenCalledWith('Office display cleanup failed.', error)
  expect(f.props.controls.current).not.toBe(controls)
})

test('zero client dimensions use the browser rectangle and adapter disposal reports terminal failure', async () => {
  await using f = fixture('spreadsheet', (props) => {
    props.document = { ...props.document, rendering: { ...props.document.rendering, overscanViewports: 0 } }
  })
  vi.stubGlobal('devicePixelRatio', 1)
  const element = f.view.container.querySelector<HTMLElement>('[data-office-surface]')!, rectangle = new DOMRect(0, 0, 320, 240)
  Object.defineProperties(element, { clientWidth: { configurable: true, value: 0 }, clientHeight: { configurable: true, value: 0 } })
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rectangle)
  await f.flush()
  expect(f.paint).toHaveBeenCalledWith(
    expect.objectContaining({ pixelWidth: rectangle.width, pixelHeight: rectangle.height }), expect.any(Number))
  act(() => { f.wire.dispose() })
  expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'Frame-forwarding Client disposed.' }))
})

test('a browser resize already admitted at shutdown cannot report another size', async () => {
  let admitted: ResizeObserverCallback | undefined
  await using f = fixture('spreadsheet', () => {
    const Observer = ResizeObserver
    vi.stubGlobal('ResizeObserver', class extends Observer {
      constructor(callback: ResizeObserverCallback) { super(callback); admitted ??= callback }
    })
  })
  await f.flush()
  const calls = f.size.mock.calls.length
  await f.props.controls.current!.stop()
  admitted!([], {} as ResizeObserver)
  expect(f.size).toHaveBeenCalledTimes(calls)
})

test('slideshow shutdown rejection is logged and does not block the next mount', async () => {
  const failure = new Error('stream shutdown failed'), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await using f = fixture('presentation', (props) => {
    props.playing = true
    props.send.playback = async (_session, value) => {
      if ((value as { enabled?: boolean }).enabled === false) throw failure
      return { documentId }
    }
  })
  await f.flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(f.waiting).toHaveBeenCalledWith(true)
  f.props.playing = false; f.rerender(); await f.flush()
  expect(warn).toHaveBeenCalledWith('Office display cleanup failed.', failure)
  expect(f.view.container.querySelector('[data-dsh-frame-mount="video"]')).not.toBeNull()
})

test('late viewport rejection after stopping does not report a rendering failure', async () => {
  const pending = Promise.withResolvers<Record<string, unknown>>(), error = new Error('viewport failed')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = fixture('spreadsheet', (props) => { props.send.viewport = async () => { await pending.promise; return { documentId } } })
  try {
    await f.flush()
    const stopped = f.props.controls.current!.stop(), rejected = expect(stopped).rejects.toBe(error)
    pending.reject(error); await rejected; await f.flush()
    expect(f.failure).not.toHaveBeenCalled()
  } finally {
    pending.reject(error)
    await expect(f.close()).rejects.toBe(error)
    expect(warn).toHaveBeenCalledWith('Office display cleanup failed.', error)
  }
})
