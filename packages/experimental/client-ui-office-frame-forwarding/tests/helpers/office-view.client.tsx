/** A real Office View and FF receiver, with only Host/engine and browser geometry replaced. */
import { officeLease } from './office-lease.client.ts'
import { readFileSync } from 'node:fs'
import { act, render } from '@testing-library/react'
import { vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeDocumentId, OfficeOpenedDocument, OfficePaintRequest, OfficePagePreviewRequest } from '../../src/types.ts'
import { OfficeConnection, type OfficePreviewRemote } from '../../src/client/connection.ts'
import { OfficeView, type Props } from '../../src/client/View.tsx'
import type { PresentationAction } from '../../src/client/presentation-store.ts'
import { en } from '../../src/client/locales.ts'
import css from '../../src/client/Editor.module.css'
import selectionCss from '../../src/client/Selection.module.css'
import { fakeVideoFrame, fakeFrameForwarding, fakeFullscreen } from './frame-forwarding.client.ts'
import { mountEnvironment } from './mount-environment.client.ts'

/** Mount a real document view; frame completion and engine failure remain independently controllable.
 * @param kind - Document kind.
 * @param docked - Whether the preview is in a docked tab.
 * @param configure - Optional setup before the first mount and its open request.
 * @param wire - Frame service shared with a mounted Client plugin.
 * @returns UI, typed RPC spies and compositor controls.
 */
export function officeViewFixture(kind: 'text' | 'spreadsheet' | 'presentation' = 'text', docked = false,
  configure?: (setup: {
    remote: Partial<OfficePreviewRemote>
    lease: ReturnType<typeof vi.fn<ConstructorParameters<typeof OfficeConnection>[2]>>
    props: Props
    opened: OfficeOpenedDocument
    fullscreen: ReturnType<typeof fakeFullscreen>
  }) => void, wire = fakeFrameForwarding()) {
  const fakeTimers = vi.isFakeTimers()
  if (!fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const env = mountEnvironment(), fullscreen = fakeFullscreen()
  let channelNumber = 1, rx = brandString<FrameRxId>('rx')
  const nativeView = () => ({ rx, frameTimeoutMs: 1000 })
  const opened: OfficeOpenedDocument = { documentId: brandString<OfficeOpenedDocument['documentId']>('doc'),
    format: kind === 'text' ? 'docx' : kind === 'spreadsheet' ? 'xlsx' : 'pptx', version: 'v1',
    nativeView: nativeView(),
    rendering: { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 120, creditRetryLimit: 3,
      maxPagePreviewBytes: 1048576 },
    info: { documentType: kind, renderBackend: 'ganesh', width: 12000, height: kind === 'presentation' ? 6750 : kind === 'text' ? 36300 : 36000,
      rectangles: kind === 'text' ? '0,0,12000,18000;0,18300,12000,18000' : '', part: 0,
      parts: [{ index: 0, name: 'First' }, { index: 1, name: 'Second' }] },
  }
  let autoDisplay = true
  const submit = (request: OfficePaintRequest, channel = rx) => {
    wire.receive({
      frame: fakeVideoFrame(),
      release: vi.fn(), metadata: {
        rx: channel, connectionId: wire.connection(channel), generation: request.frame.generation, requestId: 'kit-only', frameId: 1,
        revision: 0, width: request.pixelWidth, height: request.pixelHeight },
    })
  }
  const paint = vi.fn(async (_id: string, request: OfficePaintRequest) => {
    if (autoDisplay) submit(request)
    return { ok: true as const, value: { documentId: opened.documentId,
      width: request.pixelWidth, height: request.pixelHeight } }
  })
  const pagePreview = vi.fn(async (_id: string, request: OfficePagePreviewRequest) => ({ ok: true as const, value: {
    documentId: opened.documentId,
    width: request.pixelWidth, height: request.pixelHeight, rgba: new Uint8Array(request.pixelWidth * request.pixelHeight * 4) } }))
  let currentInfo = opened.info
  const status = () => ({ ...opened, nativeView: nativeView(), info: currentInfo })
  const remote: Partial<OfficePreviewRemote> = {
    open: vi.fn(async function* () { yield { kind: 'opened' as const, document: { ...opened, nativeView: nativeView() } } }),
    reconnect: vi.fn<OfficePreviewRemote['reconnect']>(async (documentId: OfficeDocumentId) => {
      rx = brandString<FrameRxId>(`rx-${++channelNumber}`)
      return { ok: true, value: { outcome: 'reconnected', status: { documentId, nativeView: nativeView() } } }
    }),
    info: vi.fn(async () => ({ ok: true, value: status() })),
    viewport: vi.fn(async () => ({ ok: true, value: status() })),
    paint, pagePreview,
    part: vi.fn(async (_id: string, part: number) => { currentInfo = { ...currentInfo, part }; return { ok: true, value: status() } }),
    values: vi.fn(async () => ({ ok: true, value: { value: JSON.stringify({ rows: [], columns: [] }) } })),
    input: vi.fn(async () => ({ ok: true, value: status() })),
    command: vi.fn(async () => ({ ok: true, value: status() })),
    selection: vi.fn(async () => ({ ok: true, value: { ...status(), text: 'selected' } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    presentation: vi.fn(async () => ({ ok: true,
      value: { documentId: opened.documentId } })),

  }
  const lease = vi.fn<ConstructorParameters<typeof OfficeConnection>[2]>(officeLease)
  const connection = new OfficeConnection(wire.client, remote as OfficePreviewRemote, lease)
  let presentation: PresentationAction | undefined, refresh: (() => void) | undefined
  const controller = new AbortController()
  let tab: ReturnType<Props['useTabInfo']> = {
    sidebar: { expanded: true, fullscreen: false }, panel: { id: brandString<ReturnType<Props['useTabInfo']>['panel']['id']>('pane'), isFloating: !docked },
    tab: { id: brandString<ReturnType<Props['useTabInfo']>['tab']['id']>('tab'), title: 'file.docx', kind: 'office-editor',
      contentId: 'dsh-resource://file/session/fixture/file.docx', visible: true, signal: controller.signal,
      navigation: { address: 'document-address', params: undefined, revision: 1 },
      actions: { bindCommands: (commands) => { refresh = commands.refresh; return () => {} },
        openResource: () => {}, openTab: () => {}, close: () => {} } },
  }
  const onFailure = vi.fn()
  const props: Props = { onFailure, revision: 1, connection, useTabInfo: () => tab,
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    registerPresentation: (_tab, value) => { presentation = value; return () => { if (presentation === value) presentation = undefined } },
    t: (key, params) => (key in en ? en[key as keyof typeof en] : key)
      .replace(/\{(\w+)\}/g, (token, name: string) => String(params?.[name] as string | number | undefined ?? token)),
  }
  const host = document.createElement('div')
  document.body.append(host)
  const style = document.createElement('style')
  style.textContent = ([['Editor', css], ['Selection', selectionCss]] as const).map(([file, classes]) =>
    readFileSync(`${import.meta.dirname}/../../src/client/${file}.module.css`, 'utf8')
      .replace(/\.([a-zA-Z][\w-]*)/g, (selector, name: string) => {
        const mapped = classes[name]
        return mapped === undefined ? selector : `.${mapped}`
      })).join('\n')
  document.head.append(style)
  configure?.({ remote, lease, props, opened, fullscreen })
  const view = render(<OfficeView {...props} />, { container: host })
  const drain = async () => { for (let i = 0; i < 4; i++) await act(async () => { await env.flush() }) }
  const flush = async () => {
    await drain()
    // Zoom paints wait for the configured quiet period, not the test's CPU time.
    await act(async () => { await vi.advanceTimersByTimeAsync(opened.rendering.zoomSettleMs) })
    await drain()
  }
  const close = async () => {
    try { view.unmount(); await env.flush() }
    finally {
      style.remove(); host.remove(); fullscreen.restore(); env.restore()
      if (!fakeTimers) vi.useRealTimers()
    }
  }
  return { view, submit, lease, connection, remote, onFailure, paint, pagePreview, wire, env, opened, controller, flush, props, fullscreen,
    presentation: () => presentation,
    setInfo: (value: OfficeOpenedDocument['info']) => { currentInfo = value },
    rerender: () => { view.rerender(<OfficeView {...props} />) },
    display: (value: boolean) => { autoDisplay = value },
    emit: async (event: import('../../src/client/connection.ts').OfficeViewEvent['event']) => {
      await act(async () => { connection.dispatch({ documentId: opened.documentId, event }) }); await flush()
    },
    area: () => view.baseElement.querySelector<HTMLDivElement>('[data-office-viewport]')!,
    play: async () => { await act(async () => { presentation?.play() }); await flush() },
    beginRefresh: () => refresh?.(),
    refresh: async () => { await act(async () => { refresh?.() }); await flush() },
    visibility: async (visible: boolean) => {
      tab = { ...tab, tab: { ...tab.tab, visible } }; view.rerender(<OfficeView {...props} />); await flush()
    },
    close, [Symbol.asyncDispose]: close,
  }
}
