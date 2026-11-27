/** The Office Remote service opens Session files read-only and drives native documents through frame-forwarding channels. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { FrameChannel, FrameForwardingService, FrameTx } from '@deepseek-ai/dsh-frame-forwarding'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { EditorDocument, EditorEvent, EditorInfo, OfficeEditorRequest, OfficeKit, RuntimeInfo } from '@deepseek-ai/dsh-office-kit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, test, vi } from 'vitest'
import OfficePreview, { type Config, type OfficeClientId, type OfficeDocumentEvent, type OfficeDocumentId, type OfficeOpenRequest,
  type OfficeOpenedDocument } from '../src/index.ts'

afterEach(() => { vi.restoreAllMocks() })

const nativeRuntime: RuntimeInfo = { backend: 'native', version: '0.2.4', nativePreview: true, cliPath: '/kit/cli.js', nodeApiPath: '/kit' }

const scope = { sessionId: brandString<SessionId>('fixture'), workspaceRoot: '/workspace' }
const source: OfficeOpenRequest = { address: 'dsh-resource://file/session/fixture/file.docx', owner: brandString<OfficeOpenRequest['owner']>('tab'), revision: 1, path: 'file.docx' }
const info = { documentType: 'text', renderBackend: 'ganesh', width: 100, height: 100, part: 0,
  rectangles: '0,0,100,100', parts: [{ index: 0, name: 'Page' }] } as const
const slideInfo = { ...info, documentType: 'presentation', parts: [{ index: 0, name: 'First' }, { index: 1, name: 'Second' }] } as const
const slides = { ...source, address: 'dsh-resource://file/session/fixture/slides.pptx', path: 'slides.pptx' }

function documentMock(close: () => Promise<void>, initialInfo: EditorDocument['initialInfo'] = info) {
  const listeners = new Set<(event: EditorEvent) => void>()
  let currentInfo = initialInfo
  const checkPaintPart = (area: Parameters<EditorDocument['render']>[0]): void => {
    if (area.part !== undefined && currentInfo.documentType !== 'presentation')
      throw new Error('A background part requires a presentation')
  }
  const document = {
    processId: 7, initialInfo, missingFonts: [], writable: false, revision: 0, close,
    onEvent: (listener: (event: EditorEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    attachSurfaceTransport: vi.fn<EditorDocument['attachSurfaceTransport']>(async () => {}),
    detachSurfaceTransport: vi.fn<EditorDocument['detachSurfaceTransport']>(async () => {}),
    waitForInput: vi.fn(async () => {}), getInfo: vi.fn<EditorDocument['getInfo']>(async () => currentInfo),
    setPart: vi.fn(async (part: number) => { currentInfo = { ...currentInfo, part }; return currentInfo }),
    setViewport: vi.fn(async () => {}), getValues: vi.fn(async () => 'metadata'),
    render: vi.fn<EditorDocument['render']>(async (area) => {
      checkPaintPart(area)
      return { width: 1, height: 1, pixels: Uint8Array.of(1, 2, 3, 4), revision: 0 }
    }),
    renderSurface: vi.fn<EditorDocument['renderSurface']>(async (area) => {
      checkPaintPart(area)
      return { width: 1, height: 2, shared: true as const, requestId: 'frame', revision: 0 }
    }),
    presentation: vi.fn<EditorDocument['presentation']>(async () => {}), getSelection: vi.fn(async () => 'selected'), dispatch: vi.fn(async () => {}),
    input: vi.fn(async () => {}),
  } satisfies Partial<EditorDocument>
  return { document: document as Partial<EditorDocument> as EditorDocument, mock: document,
    emit: (event: EditorEvent) => { for (const listener of listeners) listener(event) } }
}

type FrameSupport = 'unsupported' | 'unsupported-without-reason' | 'unavailable' | 'unavailable-non-error' | 'absent'
async function fixture(options: {
  capabilities?: FrameSupport
  officeKit?: 'absent' | { readonly runtime?: RuntimeInfo | undefined }
  config?: Partial<Config>
  documentInfo?: EditorDocument['initialInfo']
} = {}) {
  const ctx = new Context()
  const fs = {
    resolve: vi.fn(async (path: string, resolution: { cwd: string }) => ({ targetKey: `${resolution.cwd}/${path}`, displayPath: `${resolution.cwd}/${path}` })),
    processPath: (target: { targetKey: string }) => target.targetKey,
    processPathFromHostPath: vi.fn((path: string): string | undefined => path),
    stat: vi.fn(async (): Promise<{ type: string; version: string } | undefined> => ({ type: 'file', version: 'v1' })),
    readBytes: vi.fn(async () => Uint8Array.of(1)),
  }
  // Open channels; deleting one models Desktop invalidating it.
  const channels = new Set<FrameRxId>()
  let issued = 0
  const frameForwarding = {
    capabilities: vi.fn(async (): Promise<{ supported: boolean; reason?: string }> => {
      if (options.capabilities === 'unavailable') throw new Error('Desktop frame forwarding is unavailable')
      if (options.capabilities === 'unavailable-non-error') throw 'channel closed'
      if (options.capabilities === 'unsupported-without-reason') return { supported: false }
      return options.capabilities === 'unsupported' ? { supported: false, reason: 'unsupported-platform' } : { supported: true }
    }),
    channel: vi.fn(async (): Promise<FrameChannel> => {
      const index = ++issued
      const rx = brandString<FrameRxId>(`rx-${index}`)
      channels.add(rx)
      return { tx: brandString<FrameTx>(`tx-${index}`), rx }
    }),
    isOpen: vi.fn((rx: FrameRxId) => channels.has(rx)),
    close: vi.fn(async (rx: FrameRxId) => { channels.delete(rx) }),
  } satisfies FrameForwardingService
  const closed = vi.fn(async () => {})
  const documents: ReturnType<typeof documentMock>[] = []
  const openDocument = vi.fn(async (_request: OfficeEditorRequest): Promise<EditorDocument> => {
    const created = documentMock(closed, options.documentInfo)
    documents.push(created)
    return created.document
  })
  const runtime = options.officeKit !== 'absent' && options.officeKit !== undefined && 'runtime' in options.officeKit
    ? options.officeKit.runtime : nativeRuntime
  const discoverRuntime = vi.fn(async (): Promise<RuntimeInfo | undefined> => runtime)
  const officeKit = { discoverRuntime, openDocument } satisfies Pick<OfficeKit, 'discoverRuntime' | 'openDocument'>
  ctx.provide('fs', fs as never)
  ctx.provide('sandboxPolicy', { workspaceRoot: '/workspace' } as never)
  if (options.officeKit !== 'absent') ctx.provide('officeKit', officeKit as never)
  if (options.capabilities !== 'absent') ctx.provide('frameForwarding', frameForwarding)
  /** Arrange the next engine the service opens before it is used. */
  const next = (arrange: (created: ReturnType<typeof documentMock>) => void) => {
    openDocument.mockImplementationOnce(async () => {
      const created = documentMock(closed, options.documentInfo)
      arrange(created)
      documents.push(created)
      return created.document
    })
  }
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await ctx.plugin(OfficePreview, OfficePreview.Config(options.config ?? {})).await()
  const service = ctx.get('officePreview') as OfficePreview
  const open = async (request: OfficeOpenRequest = source, signal = new AbortController().signal) => {
    const stages: string[] = []
    for await (const item of service.open(scope, request, signal)) {
      if (item.kind === 'stage') stages.push(item.stage)
      else return { stages, document: item.document }
    }
    return { stages, document: undefined }
  }
  const dispose = async () => { await ctx.fiber.dispose() }
  return {
    ctx, service, fs, frameForwarding, officeKit, channels, closed, documents, next, warn, open, dispose, [Symbol.asyncDispose]: dispose,
  }
}

function subscribe(service: OfficePreview) {
  const controller = new AbortController()
  const received: OfficeDocumentEvent[] = []
  const done = (async () => {
    for await (const event of service.events(controller.signal)) received.push(event)
  })()
  return { received, done, cancel: () => { controller.abort() } }
}

const frame = { generation: 1 }
const area = { x: 0, y: 0, width: 15, height: 15 }
const rx = (index: number) => brandString<FrameRxId>(`rx-${index}`)
const connect = (index: number, timeoutMs = 10000) => [`tx-${index}`, { timeoutMs }]

/** Producer credentials stay between the Host and its engines; no Remote reply, status, or event carries one. */
function expectNoCredential(value: object): void {
  expect(JSON.stringify(value)).not.toMatch(/tx-\d/)
}

test.each([
  ['an absent officeKit service', { officeKit: 'absent' as const }],
  ['an unavailable runtime', { officeKit: { runtime: undefined } }],
  ['a WASM engine', { officeKit: { runtime: { ...nativeRuntime, backend: 'wasm' as const, nativePreview: false } } }],
  ['a conversion-only native engine', { officeKit: { runtime: { ...nativeRuntime, nativePreview: false } } }],
] as const)('%s leaves native preview unavailable to the renderer', async (_name, options) => {
  await using f = await fixture(options)
  await expect(f.service.availability()).resolves.toEqual({ local: false })
  await expect(f.open()).rejects.toThrow('Native Office preview is unavailable.')
})

test('unexpected runtime discovery failures propagate without caching and re-probe when officeKit reloads', async () => {
  await using f = await fixture()
  f.officeKit.discoverRuntime.mockRejectedValueOnce(new Error('broken discovery'))
  await expect(f.service.availability()).rejects.toThrow('broken discovery')
  await expect(f.service.availability()).resolves.toEqual({ local: true })
  expect(f.officeKit.discoverRuntime).toHaveBeenCalledTimes(2)

  // Replacing officeKit while a discovery rejects on an earlier instance must not clear the replacement's probe.
  const pending = Promise.withResolvers<RuntimeInfo | undefined>()
  const staleKit = { discoverRuntime: vi.fn(() => pending.promise), openDocument: f.officeKit.openDocument }
  const freshKit = { discoverRuntime: vi.fn(async () => nativeRuntime), openDocument: vi.fn(f.officeKit.openDocument) }
  f.ctx.set('officeKit', staleKit as never)
  const failedProbe = f.service.availability()
  f.ctx.set('officeKit', freshKit as never)
  await expect(f.service.availability()).resolves.toEqual({ local: true })
  pending.reject(new Error('stale kit failed'))
  await expect(failedProbe).rejects.toThrow('stale kit failed')
  await expect(f.service.availability()).resolves.toEqual({ local: true })
  expect(freshKit.discoverRuntime).toHaveBeenCalledOnce()
})

test('document operations are published under the officePreview Remote namespace', async () => {
  await using f = await fixture()
  expect(f.service.typertRemote).toMatchObject({ serviceKey: 'officePreview', namespace: 'officePreview' })
  expect(remoteMethods(f.service).map(({ method, mode }) => [method, mode ?? 'unary'])).toEqual([
    ['availability', 'unary'], ['open', 'stream'], ['events', 'stream'], ['retain', 'stream'], ['info', 'unary'], ['viewport', 'unary'], ['part', 'unary'], ['paint', 'unary'],
    ['pagePreview', 'unary'], ['values', 'unary'], ['presentation', 'unary'], ['selection', 'unary'], ['command', 'unary'],
    ['input', 'unary'], ['reconnect', 'unary'], ['release', 'unary'],
  ])
})

test('availability reports local rendering only for a local workspace filesystem with frame forwarding', async () => {
  const f = await fixture()
  try {
    await expect(f.service.availability()).resolves.toEqual({ local: true })
    f.fs.processPathFromHostPath.mockReturnValueOnce(undefined)
    await expect(f.service.availability()).resolves.toEqual({ local: false })
  } finally { await f.dispose() }
  for (const [capabilities, reason] of [
    ['unsupported', 'unsupported-platform'], ['unsupported-without-reason', 'frame forwarding is unsupported'],
    ['unavailable', 'Desktop frame forwarding is unavailable'], ['unavailable-non-error', 'channel closed'],
  ] as const) {
    await using unavailable = await fixture({ capabilities })
    await expect(unavailable.service.availability()).resolves.toEqual({ local: false })
    expect(unavailable.warn).toHaveBeenCalledWith('Native Office preview is unavailable: %s', reason)
    await expect(unavailable.open()).rejects.toThrow('Native Office preview is unavailable.')
  }
})

test('a Host without Desktop frame forwarding reports native rendering unavailable without probing', async () => {
  await using f = await fixture({ capabilities: 'absent' })
  await expect(f.service.availability()).resolves.toEqual({ local: false })
  expect(f.officeKit.discoverRuntime).not.toHaveBeenCalled()
  expect(f.frameForwarding.capabilities).not.toHaveBeenCalled()
  await expect(f.open()).rejects.toThrow('Native Office preview is unavailable.')
})

test('opens a Graphite document and preserves its backend in replies', async () => {
  await using f = await fixture({ config: { renderBackend: 'graphite' } })
  f.officeKit.openDocument.mockImplementationOnce(async () => {
    const created = documentMock(f.closed)
    f.documents.push(created)
    return { ...created.document, initialInfo: { ...info, renderBackend: 'graphite' } }
  })
  const opened = await f.open()
  expect(opened.document?.info.renderBackend).toBe('graphite')
  expect(f.officeKit.openDocument.mock.calls[0]![0].renderBackend).toBe('graphite')
})

test('a stopped service opens no further documents', async () => {
  const f = await fixture()
  await f.dispose()
  await expect(f.open()).rejects.toThrow('Native Office preview is unavailable.')
  expect(f.officeKit.openDocument).not.toHaveBeenCalled()
})

test('availability and opening reuse one runtime probe per officeKit instance and delegate opening to officeKit', async () => {
  await using f = await fixture()
  await expect(f.service.availability()).resolves.toEqual({ local: true })
  await f.open()
  expect(f.officeKit.discoverRuntime).toHaveBeenCalledOnce()
  expect(f.officeKit.openDocument).toHaveBeenCalledOnce()
  expect(f.officeKit.openDocument.mock.calls[0]![0].options).not.toHaveProperty('resolveEnginePackage')
})

test('opening reports loading stages, resolves the path in the Session workspace and connects the engine to a new channel', async () => {
  await using f = await fixture({ config: { renderBackend: 'ganesh', frameTimeoutMs: 1 } })
  const events = subscribe(f.service)
  f.officeKit.openDocument.mockImplementationOnce(async (options) => {
    options.onProgress?.('fonts')
    options.onProgress?.('engine')
    const created = documentMock(f.closed)
    f.documents.push(created)
    return created.document
  })
  const opened = await f.open()
  expect(opened.stages).toEqual(['fonts', 'engine'])
  expect(opened.document).toEqual({
    documentId: expect.any(String) as string as OfficeDocumentId,
    nativeView: { rx: rx(1), frameTimeoutMs: 1 },
    info, format: 'docx', version: 'v1',
    rendering: { operationTimeoutMs: 30000, overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 120, creditRetryLimit: 3,
      maxPagePreviewBytes: 32 * 1024 * 1024 },
  } satisfies OfficeOpenedDocument)
  expect(f.fs.resolve).toHaveBeenCalledWith('file.docx', { cwd: '/workspace' })
  expect(f.officeKit.openDocument.mock.calls[0]![0]).toMatchObject({ bytes: Uint8Array.of(1), format: 'docx',
    renderBackend: 'ganesh' })
  expect(f.frameForwarding.channel).toHaveBeenCalledExactlyOnceWith()
  expect(f.documents[0]!.mock.attachSurfaceTransport.mock.calls).toEqual([connect(1)])
  f.documents[0]!.emit({ kind: 'callback', type: 0, payload: '0,0,1,1' })
  await vi.waitFor(() => { expect(events.received).toHaveLength(1) })
  expectNoCredential([opened, events.received, await f.service.info(opened.document!.documentId)])
  const reattached = await f.open()
  expect(reattached.document?.documentId).toBe(opened.document!.documentId)
  expect(f.documents).toHaveLength(1)
  await expect(f.open({ ...source, path: 'other.docx' })).rejects.toThrow('Office view is already bound to another file.')
  await expect(f.service.open({ ...scope, sessionId: brandString<SessionId>('other') }, source,
    new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('already bound to another file')
  await f.service.release(opened.document!.documentId)
  await f.service.release(opened.document!.documentId)
  expect(f.closed).toHaveBeenCalledOnce()
  expect((await f.open({ ...source, path: 'other.docx' })).document?.documentId).not.toBe(opened.document!.documentId)
})

test('a restored tab replaces its previous revision and a late release leaves both live views of the file usable', async () => {
  await using f = await fixture()
  const old = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('pane:tab:7'), revision: 7 })).document!
  const other = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('pane:other:7'), revision: 7 })).document!
  const restored = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('pane:tab:7'), revision: 0 })).document!
  expect(restored.documentId).not.toBe(old.documentId)
  expect(f.closed).toHaveBeenCalledOnce()
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(old.nativeView!.rx)
  await expect(f.service.info(old.documentId)).rejects.toThrow('closed')
  await f.service.release(old.documentId)
  for (const live of [other, restored]) await expect(f.service.info(live.documentId)).resolves.toMatchObject({
    documentId: live.documentId, nativeView: live.nativeView,
  })
})

test('reopening an owned view detaches its engine, closes the old channel and connects the engine to a fresh channel', async () => {
  await using f = await fixture()
  const first = (await f.open()).document!, native = f.documents[0]!.mock
  const reopened = (await f.open()).document!
  expect(reopened).toMatchObject({ documentId: first.documentId, nativeView: { rx: rx(2) } })
  expectNoCredential(reopened)
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(rx(1))
  expect(native.attachSurfaceTransport.mock.calls).toEqual([connect(1), connect(2)])
  const [detached] = native.detachSurfaceTransport.mock.invocationCallOrder
  const [closed] = f.frameForwarding.close.mock.invocationCallOrder
  expect(detached).toBeLessThan(closed!)
  expect(closed).toBeLessThan(native.attachSurfaceTransport.mock.invocationCallOrder[1]!)
  expect(await f.service.info(first.documentId)).toMatchObject({ nativeView: { rx: rx(2) } })
})

test('reattaching a failed engine rejects open and closes its record without another channel', async () => {
  await using f = await fixture()
  const first = (await f.open()).document!, crashed = f.documents[0]!
  crashed.emit({ kind: 'failure', error: new Error('renderer exited') })
  await expect(f.open()).rejects.toThrow('renderer exited')
  expect(crashed.mock.attachSurfaceTransport.mock.calls).toEqual([connect(1)])
  expect(crashed.mock.detachSurfaceTransport).not.toHaveBeenCalled()
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(rx(1))
  expect(f.frameForwarding.channel).toHaveBeenCalledOnce()
  await f.service.release(first.documentId)
  expect(f.closed).toHaveBeenCalledOnce()
  await expect(f.service.info(first.documentId)).rejects.toThrow('Office document is closed.')
})

test.each([
  ['equal to', 1000], ['longer than', 1001],
] as const)('a channel connect deadline %s the operation deadline fails the plugin load', async (_name, channelConnectTimeoutMs) => {
  const ctx = new Context()
  ctx.provide('fs', {} as never)
  ctx.provide('sandboxPolicy', {} as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  try {
    await expect(ctx.plugin(OfficePreview, OfficePreview.Config({ operationTimeoutMs: 1000, channelConnectTimeoutMs })).await())
      .rejects.toThrow('Office channelConnectTimeoutMs must be shorter than operationTimeoutMs.')
  } finally { await ctx.fiber.dispose() }
})

test('every engine connects to the document channel within the configured connect deadline', async () => {
  await using f = await fixture({ config: { operationTimeoutMs: 1000, channelConnectTimeoutMs: 999 } })
  await f.open()
  expect(f.documents[0]!.mock.attachSurfaceTransport.mock.calls).toEqual([connect(1, 999)])
})

test('native backend configuration defaults to Ganesh and accepts only GPU backends', async () => {
  expect(OfficePreview.Config({}).renderBackend).toBe('ganesh')
  for (const renderBackend of ['ganesh', 'graphite'] as const) expect(OfficePreview.Config({ renderBackend }).renderBackend).toBe(renderBackend)
  for (const renderBackend of ['auto', 'raster']) expect(await OfficePreview.Config['~standard'].validate({ renderBackend })).toHaveProperty('issues')
})

test('a Kit document that did not use the GPU rejects open and closes before creating a channel', async () => {
  const f = await fixture({ documentInfo: { ...info, renderBackend: 'raster' } })
  try {
    await expect(f.open()).rejects.toThrow('Native Office requires GPU rendering.')
    expect(f.closed).toHaveBeenCalledOnce()
    expect(f.frameForwarding.channel).not.toHaveBeenCalled()
    expect(f.documents[0]!.mock.attachSurfaceTransport).not.toHaveBeenCalled()
    expect(f.channels.size).toBe(0)
  } finally { await f.dispose() }
  expect(f.closed).toHaveBeenCalledOnce()
})

test.each([
  ['a negative revision', { ...source, revision: -1 }, 'coordinate'],
  ['an unsafe revision', { ...source, revision: Number.MAX_SAFE_INTEGER + 1 }, 'coordinate'],
  ['an empty path', { ...source, path: '' }, 'explicit session file and view identity'],
  ['an empty address', { ...source, address: '' }, 'explicit session file and view identity'],
  ['an empty owner', { ...source, owner: brandString<OfficeOpenRequest['owner']>('') }, 'explicit session file and view identity'],
  ['an unsupported format', { ...source, path: 'file.txt' }, 'Unsupported native Office format.'],
] as const)('opening rejects %s before reading the file', async (_name, request, message) => {
  await using f = await fixture()
  await expect(f.open(request)).rejects.toThrow(message)
  expect(f.fs.readBytes).not.toHaveBeenCalled()
})

test('file admission rejects remote paths, missing files and changing versions', async () => {
  await using f = await fixture()
  f.fs.processPathFromHostPath.mockReturnValueOnce(undefined)
  await expect(f.open()).rejects.toThrow('Native Office requires a local filesystem.')
  f.fs.stat.mockResolvedValueOnce(undefined)
  await expect(f.open()).rejects.toThrow('Office file is missing or is not a regular file.')
  f.fs.stat.mockResolvedValueOnce({ type: 'file', version: 'v1' }).mockResolvedValueOnce({ type: 'file', version: 'v2' })
  await expect(f.open()).rejects.toThrow('Office file changed while opening.')
  expect(f.officeKit.openDocument).not.toHaveBeenCalled()
})

test('unsupported frame forwarding and a failed channel connection close the document before the PDF fallback', async () => {
  await using f = await fixture()
  await expect(f.service.availability()).resolves.toEqual({ local: true })
  f.frameForwarding.capabilities.mockResolvedValueOnce({ supported: false })
  await expect(f.open()).rejects.toThrow('Office FrameForwarding is unavailable.')
  expect(f.frameForwarding.channel).not.toHaveBeenCalled()
  expect(f.closed).toHaveBeenCalledOnce()
  f.frameForwarding.channel.mockRejectedValueOnce(new Error('channel unavailable'))
  await expect(f.open()).rejects.toThrow('channel unavailable')
  expect(f.closed).toHaveBeenCalledTimes(2)
  f.next(({ mock }) => { mock.attachSurfaceTransport.mockRejectedValueOnce(new Error('channel-busy')) })
  f.frameForwarding.close.mockRejectedValueOnce(new Error('channel close failed'))
  await expect(f.open()).rejects.toThrow('channel-busy')
  expect(f.documents.at(-1)!.mock.detachSurfaceTransport).not.toHaveBeenCalled()
  expect(f.frameForwarding.close).toHaveBeenLastCalledWith(rx(1))
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'channel close failed' }))
  f.next((created) => {
    created.mock.attachSurfaceTransport.mockImplementationOnce(async () => {
      created.emit({ kind: 'callback', type: 0, payload: 'ignored before subscription' })
      created.emit({ kind: 'failure', error: new Error('renderer failed while attaching') })
    })
  })
  await expect(f.open()).rejects.toThrow('renderer failed while attaching')
  expect(f.documents.at(-1)!.mock.detachSurfaceTransport).toHaveBeenCalledOnce()
  expect(f.frameForwarding.close).toHaveBeenLastCalledWith(rx(2))
  expect(f.closed).toHaveBeenCalledTimes(4)
})

test('the open deadline closes a late document and ignores late progress and rejections', async () => {
  const f = await fixture({ config: { operationTimeoutMs: 1000, channelConnectTimeoutMs: 999 } })
  try {
    vi.useFakeTimers()
    const late = Promise.withResolvers<EditorDocument>()
    let progress: ((stage: 'fonts' | 'engine' | 'document') => void) | undefined
    f.officeKit.openDocument.mockImplementationOnce(async (options) => { progress = options.onProgress; return late.promise })
    const opening = f.open()
    const rejected = expect(opening).rejects.toThrow('Office open exceeded 1000ms.')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    progress!('document')
    const close = vi.fn(async () => { throw new Error('late close failed') })
    late.resolve({ close } as Partial<EditorDocument> as EditorDocument)
    await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'late close failed' })) })
    for (const same of [true, false]) {
      const failing = Promise.withResolvers<EditorDocument>()
      let signal: AbortSignal | undefined
      f.officeKit.openDocument.mockImplementationOnce(async (options) => { signal = options.signal; return failing.promise })
      const attempt = expect(f.open()).rejects.toThrow('exceeded')
      await vi.advanceTimersByTimeAsync(1000)
      await attempt
      failing.reject(same ? signal!.reason : new Error('late engine failure'))
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'late engine failure' }))
    expect(f.warn).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Office open exceeded 1000ms.' }))
    vi.useRealTimers()
    f.officeKit.openDocument.mockRejectedValueOnce(new Error('engine could not open file'))
    await expect(f.open()).rejects.toThrow('engine could not open file')
  } finally { vi.useRealTimers(); await f.dispose() }
})

test('plugin disposal waits for a timed-out open to finish closing its late document', async () => {
  const f = await fixture({ config: { operationTimeoutMs: 1000, channelConnectTimeoutMs: 999 } })
  const late = Promise.withResolvers<EditorDocument>()
  const lateClose = Promise.withResolvers<undefined>()
  const close = vi.fn(() => lateClose.promise)
  let disposed = false
  try {
    vi.useFakeTimers()
    f.officeKit.openDocument.mockImplementationOnce(() => late.promise)
    const rejected = expect(f.open()).rejects.toThrow('Office open exceeded 1000ms.')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    const disposal = f.dispose().then(() => { disposed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(disposed).toBe(false)
    late.resolve({ close } as Partial<EditorDocument> as EditorDocument)
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(0)
    expect(disposed).toBe(false)
    lateClose.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
  } finally {
    vi.useRealTimers()
    lateClose.resolve(undefined)
    late.resolve({ close } as Partial<EditorDocument> as EditorDocument)
    await f.dispose()
  }
})

test('a cancelled open stream still completes its admitted document for the same view', async () => {
  await using f = await fixture()
  const controller = new AbortController()
  controller.abort()
  expect(await f.open(source, controller.signal)).toEqual({ stages: [], document: undefined })
  await vi.waitFor(() => { expect(f.documents).toHaveLength(1) })
  expect((await f.open()).document?.documentId).toBeDefined()
  expect(f.documents).toHaveLength(1)
})

test('render-window settings admit their boundaries and reject invalid fractions, delays and retry limits', () => {
  const defaults = OfficePreview.Config({})
  expect(defaults).toMatchObject({ overscanViewports: 0.5, reanchorHysteresis: 0.25, zoomSettleMs: 120, creditRetryLimit: 3 })
  for (const key of ['tilePixels', 'maxTileBytes', 'overscanTiles']) expect(defaults).not.toHaveProperty(key)
  for (const key of ['overscanViewports', 'reanchorHysteresis'] as const) {
    for (const value of [0, 0.25, 0.5, 1]) expect(OfficePreview.Config({ [key]: value })[key]).toBe(value)
    for (const value of [-0.01, 1.01, NaN, Infinity]) expect(() => OfficePreview.Config({ [key]: value })).toThrow()
  }
  for (const value of [0, 120, 2_147_483_646]) expect(OfficePreview.Config({ zoomSettleMs: value }).zoomSettleMs).toBe(value)
  for (const value of [-1, 0.5, 2_147_483_647, NaN, Infinity]) expect(() => OfficePreview.Config({ zoomSettleMs: value })).toThrow()
  for (const value of [1, 3, 10]) expect(OfficePreview.Config({ creditRetryLimit: value }).creditRetryLimit).toBe(value)
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => OfficePreview.Config({ creditRetryLimit: value })).toThrow()
})

test('opening forwards custom render-window settings without tile settings', async () => {
  const rendering = { operationTimeoutMs: 75000, overscanViewports: 1, reanchorHysteresis: 0, zoomSettleMs: 0, creditRetryLimit: 7,
    maxPagePreviewBytes: 1024 * 1024 }
  await using f = await fixture({ config: rendering })
  expect((await f.open()).document?.rendering).toEqual(rendering)
})

test('page previews return owned RGBA bytes and status without using frame forwarding', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  const pixels = Uint8Array.of(9, 0, 128, 255, 127, 1, 2, 3, 4, 9).subarray(1, 9)
  native.render.mockResolvedValueOnce({ width: 2, height: 1, pixels, revision: 0 })
  const reply = await f.service.pagePreview(id, { ...area, pixelWidth: 2, pixelHeight: 1 })
  expect(reply).toEqual({ documentId: id,
    nativeView: { rx: rx(1), frameTimeoutMs: 10000 }, width: 2, height: 1, rgba: pixels })
  expect(reply.rgba).toBe(pixels)
  expect(reply.rgba.byteLength).toBe(reply.width * reply.height * 4)
  expect(native.render).toHaveBeenCalledExactlyOnceWith(area, 2, 1)
  expect(native.renderSurface).not.toHaveBeenCalled()
  expect(f.frameForwarding.channel).toHaveBeenCalledOnce()
  expectNoCredential(reply)
  f.frameForwarding.capabilities.mockResolvedValueOnce({ supported: false })
  await expect(f.open()).rejects.toThrow('Office FrameForwarding is unavailable.')
  await expect(f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1 })).rejects.toThrow('Office document is closed.')
})

test('page previews reject invalid geometry and pixel sizes before rendering', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  for (const invalid of [
    { x: -1 }, { x: NaN }, { y: Infinity }, { width: 0 }, { height: 0.5 }, { part: -1 }, { part: 10001 },
    { pixelWidth: 0 }, { pixelWidth: 4097 }, { pixelHeight: 4097 }, { pixelWidth: NaN }, { pixelHeight: Infinity }, { pixelHeight: 1.5 },
  ]) await expect(f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1, ...invalid })).rejects.toThrow('Invalid Office coordinate.')
  expect(native.render).not.toHaveBeenCalled()
  await f.service.pagePreview(id, { ...area, pixelWidth: 4096, pixelHeight: 1 })
  expect(native.render).toHaveBeenCalledExactlyOnceWith(area, 4096, 1)
})

test('page-preview requests and returned bytes both respect the configured byte budget', async () => {
  const maxPagePreviewBytes = 1024 * 1024
  await using f = await fixture({ config: { maxPagePreviewBytes } })
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  const pixels = new Uint8Array(maxPagePreviewBytes)
  native.render.mockResolvedValueOnce({ width: 512, height: 512, pixels, revision: 0 })
  expect((await f.service.pagePreview(id, { ...area, pixelWidth: 512, pixelHeight: 512 })).rgba.byteLength).toBe(maxPagePreviewBytes)
  await expect(f.service.pagePreview(id, { ...area, pixelWidth: 513, pixelHeight: 512 })).rejects.toMatchObject({
    code: 'gateway/bad-request', details: { issues: [{ pixelWidth: 513, pixelHeight: 512, maxPagePreviewBytes }] },
  })
  expect(native.render).toHaveBeenCalledOnce()
  native.render.mockResolvedValueOnce({ width: 1024, height: 512, pixels: new Uint8Array(2 * maxPagePreviewBytes), revision: 0 })
  await expect(f.service.pagePreview(id, { ...area, pixelWidth: 512, pixelHeight: 512 })).rejects.toMatchObject({ code: 'gateway/internal' })
})

test('page previews serialize with their document release while another document stays usable', async () => {
  const f = await fixture()
  const rendering = Promise.withResolvers<Awaited<ReturnType<EditorDocument['render']>>>()
  const started = Promise.withResolvers<undefined>()
  const pixels = { width: 1, height: 1, pixels: Uint8Array.of(0, 128, 255, 255), revision: 0 }
  try {
    const id = (await f.open()).document!.documentId
    const other = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('other-tab') })).document!.documentId
    const native = f.documents[0]!.mock
    native.render.mockImplementationOnce(() => { started.resolve(undefined); return rendering.promise })
    const preview = f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1 })
    await started.promise
    const release = f.service.release(id)
    const closed = expect(f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1 })).rejects.toThrow('Office document is closed.')
    expect(await f.service.pagePreview(other, { ...area, pixelWidth: 1, pixelHeight: 1 })).toMatchObject({ documentId: other })
    expect(f.closed).not.toHaveBeenCalled()
    rendering.resolve(pixels)
    expect(await preview).toMatchObject({ rgba: pixels.pixels })
    await release
    await closed
    expect(native.render).toHaveBeenCalledOnce()
    await expect(f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1 })).rejects.toThrow('Office document is closed.')
  } finally { rendering.resolve(pixels); await f.dispose() }
})

test.each([
  ['Native frame viewport is stale', 'stale'],
  ['Native texture credit timed out', 'credit-timeout'],
] as const)('Kit %s becomes a structured Remote retry reason without retiring the engine', async (message, reason) => {
  await using f = await fixture()
  const opened = (await f.open()).document, engine = f.documents[0]
  if (opened === undefined || engine === undefined) throw new Error('Expected an opened document.')
  const id = opened.documentId, native = engine.mock, cause = new Error(message)
  const failure = { code: 'office/frame-retry', details: { reason }, message, cause }
  native.renderSurface.mockRejectedValueOnce(cause)
  await expect(f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 2, frame })).rejects.toMatchObject(failure)
  expect(await f.service.info(id)).not.toHaveProperty('failed')
  expect(await f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 2, frame: { ...frame, generation: 2 } }))
    .toMatchObject({ documentId: id, nativeView: { rx: rx(1) } })
  expect(native.renderSurface).toHaveBeenLastCalledWith(area, 1, 2, { requestId: expect.any(String) as string, generation: 2 })
  expect(native.detachSurfaceTransport).not.toHaveBeenCalled()
  expect(f.frameForwarding.close).not.toHaveBeenCalled()
})

test.each(['text', 'spreadsheet'] as const)('%s paints the active view and rejects background parts like Kit', async (documentType) => {
  await using f = await fixture({ documentInfo: { ...info, documentType,
    parts: [{ index: 0, name: 'First' }, { index: 1, name: 'Second' }] } })
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  const request = { ...area, pixelWidth: 1, pixelHeight: 2, frame }
  await expect(f.service.paint(id, request)).resolves.toMatchObject({ width: 1, height: 2 })
  expect(native.renderSurface).toHaveBeenLastCalledWith(area, 1, 2, { requestId: expect.any(String) as string, ...frame })
  if (documentType === 'spreadsheet') {
    for (const part of [1, 0]) {
      await expect(f.service.part(id, part)).resolves.toMatchObject({ info: { documentType, part } })
      expect(native.setPart).toHaveBeenLastCalledWith(part)
      await expect(f.service.paint(id, request)).resolves.toMatchObject({ width: 1, height: 2 })
      expect(native.renderSurface).toHaveBeenLastCalledWith(area, 1, 2, { requestId: expect.any(String) as string, ...frame })
      await expect(f.service.info(id)).resolves.toMatchObject({ info: { part } })
    }
  }
  await expect(f.service.paint(id, { ...request, part: 0 })).rejects.toThrow('A background part requires a presentation')
  await expect(f.service.pagePreview(id, { ...area, part: 0, pixelWidth: 1, pixelHeight: 1 }))
    .rejects.toThrow('A background part requires a presentation')
})

test('presentation paints target slides without changing the active slide and follow explicit slide selection', async () => {
  await using f = await fixture({ documentInfo: slideInfo })
  const id = (await f.open(slides)).document!.documentId, native = f.documents[0]!.mock
  await f.service.pagePreview(id, { ...area, part: 1, pixelWidth: 1, pixelHeight: 1 })
  expect(native.render).toHaveBeenLastCalledWith({ ...area, part: 1 }, 1, 1)
  await f.service.paint(id, { ...area, part: 1, pixelWidth: 1, pixelHeight: 2, frame })
  expect(native.renderSurface).toHaveBeenLastCalledWith({ ...area, part: 1 }, 1, 2, { requestId: expect.any(String) as string, ...frame })
  await expect(f.service.info(id)).resolves.toMatchObject({ info: { part: 0 } })
  expect(native.setPart).not.toHaveBeenCalled()
  for (const part of [1, 0]) {
    await expect(f.service.part(id, part)).resolves.toMatchObject({ info: { part } })
    expect(native.setPart).toHaveBeenLastCalledWith(part)
    await f.service.paint(id, { ...area, part, pixelWidth: 1, pixelHeight: 2, frame })
    expect(native.renderSurface).toHaveBeenLastCalledWith({ ...area, part }, 1, 2, { requestId: expect.any(String) as string, ...frame })
    await expect(f.service.info(id)).resolves.toMatchObject({ info: { part } })
  }
})

test('document operations bound native coordinates and render through the shared view', async () => {
  await using f = await fixture()
  const { document } = (await f.open())
  const id = document!.documentId, native = f.documents[0]!.mock
  expect(await f.service.info(id)).toMatchObject({ documentId: id, info })
  expect(await f.service.viewport(id, { ...area, pixelSize: 1, twipSize: 15 })).toMatchObject({ documentId: id })
  expect(native.setViewport).toHaveBeenCalledWith({ ...area, pixelSize: 1, twipSize: 15 })
  await expect(f.service.viewport(id, { ...area, width: 0, pixelSize: 1, twipSize: 15 })).rejects.toThrow('Invalid Office coordinate.')
  await expect(f.service.viewport(id, { ...area, x: 0.5, pixelSize: 1, twipSize: 15 })).rejects.toThrow('Invalid Office coordinate.')
  expect(await f.service.part(id, 0)).toMatchObject({ info: { part: 0 } })
  expect(await f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 2, frame }))
    .toMatchObject({ documentId: id, width: 1, height: 2 })
  expect(native.renderSurface).toHaveBeenLastCalledWith(area, 1, 2, { requestId: expect.any(String) as string, ...frame })
  await f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 1, frame })
  expect(native.renderSurface).toHaveBeenLastCalledWith(area, 1, 1, { requestId: expect.any(String) as string, ...frame })
  expect(native.renderSurface.mock.calls[0]?.[3]).not.toEqual(native.renderSurface.mock.calls[1]?.[3])
  expect(await f.service.values(id, { command: 'ViewRowColumnHeaders', area })).toEqual({ value: 'metadata' })
  expect(await f.service.selection(id, 'text/html')).toMatchObject({ text: 'selected' })
  expect(native.getSelection).toHaveBeenCalledWith('text/html')
  await f.service.command(id, { command: 'GoToCell', arguments: { ToPoint: { type: 'string', value: 'A1' } } })
  expect(native.dispatch).toHaveBeenCalledWith('GoToCell', { ToPoint: { type: 'string', value: 'A1' } })
  await expect(f.service.command(id, { command: 'Bold', arguments: {} } as never)).rejects.toThrow('Office document is read-only.')
  await f.service.input(id, { op: 'mouse', type: 0, x: 1, y: 2, count: 1, buttons: 1, modifiers: 0 })
  await f.service.input(id, { op: 'key', type: 0, character: 0, key: 1024 | 4096 })
  expect(native.input).toHaveBeenCalledTimes(2)
  await expect(f.service.input(id, { op: 'key', type: 0, character: 65, key: 1024 })).rejects.toThrow('read-only')
  await expect(f.service.input(id, { op: 'key', type: 0, character: 0, key: 65 })).rejects.toThrow('read-only')
  await expect(f.service.input(id, { op: 'mouse', type: 0, x: 1, y: 2, count: 4, buttons: 1, modifiers: 0 })).rejects.toThrow('coordinate')
  expect(native.waitForInput).not.toHaveBeenCalled()
  await f.service.release(id)
  await expect(f.service.info(id)).rejects.toThrow('Office document is closed.')
})

test('a document view waiting for its engine delays only its own later operations', async () => {
  await using f = await fixture()
  const first = (await f.open()).document!.documentId
  const second = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('other-tab') })).document!.documentId
  const [waiting, other] = [f.documents[0]!.mock, f.documents[1]!.mock]
  const rendered = Promise.withResolvers<Awaited<ReturnType<EditorDocument['renderSurface']>>>()
  waiting.renderSurface.mockReturnValueOnce(rendered.promise)
  const paint = f.service.paint(first, { ...area, pixelWidth: 1, pixelHeight: 2, frame })
  const behind = f.service.info(first)
  expect(await f.service.paint(second, { ...area, pixelWidth: 1, pixelHeight: 2, frame })).toMatchObject({ documentId: second })
  expect(await f.service.info(second)).toMatchObject({ documentId: second, info })
  expect(other.getInfo).toHaveBeenCalledOnce()
  expect(waiting.getInfo).not.toHaveBeenCalled()
  rendered.resolve({ width: 1, height: 2, shared: true, requestId: 'frame', revision: 0 })
  expect(await paint).toMatchObject({ documentId: first, width: 1, height: 2 })
  expect(await behind).toMatchObject({ documentId: first, info })
  expect(waiting.renderSurface.mock.invocationCallOrder[0]).toBeLessThan(waiting.getInfo.mock.invocationCallOrder[0]!)
})

test('operations queued behind the release of their document find it closed', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId
  const released = f.service.release(id)
  const again = f.service.release(id)
  const info = f.service.info(id)
  await released
  await again
  await expect(info).rejects.toThrow('Office document is closed.')
  expect(f.closed).toHaveBeenCalledOnce()
  await expect(f.service.release(id)).resolves.toBeUndefined()
})

test('slideshow controls bound sizes and attach shared streams to the native view', async () => {
  await using f = await fixture({ config: { presentationFrameRate: 30 } })
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  for (const control of [
    { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 }, { action: 'resize', pixelWidth: 2, pixelHeight: 2 },
    { action: 'pause', paused: true }, { action: 'next' }, { action: 'previous' },
    { action: 'stream', enabled: true, streamId: 'show', generation: 1 }, { action: 'stream', enabled: false, streamId: 'show', generation: 1 },
    { action: 'stop' },
  ] as const) expect(await f.service.presentation(id, control)).toMatchObject({ documentId: id })
  expect(vi.mocked(native.presentation).mock.calls.map(([control]) => control)).toEqual([
    { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 }, { action: 'resize', pixelWidth: 2, pixelHeight: 2 },
    { action: 'pause', paused: true }, { action: 'next' }, { action: 'previous' },
    { action: 'stream', enabled: true, requestId: 'show', generation: 1, frameRate: 30 },
    { action: 'stream', enabled: false, requestId: 'show', generation: 1 }, { action: 'stop' },
  ])
  await expect(f.service.presentation(id, { action: 'start', pixelWidth: 5000, pixelHeight: 1, part: 0 })).rejects.toThrow('coordinate')
  await expect(f.service.presentation(id, { action: 'goto', part: 1 } as never)).rejects.toThrow('Office presentation control')
})

async function hold(service: OfficePreview, id: OfficeDocumentId, client = 'renderer') {
  const controller = new AbortController()
  const stream = service.retain(id, brandString<OfficeClientId>(client), controller.signal)[Symbol.asyncIterator]()
  const first = await stream.next()
  return { first, stream, cancel: async () => { controller.abort(); await stream.return?.() } }
}

const startShow = { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 } as const

test('event observers receive callbacks independently of document leases and each other', async () => {
  await using f = await fixture()
  const a = subscribe(f.service), b = subscribe(f.service)
  const id = (await f.open()).document!.documentId, native = f.documents[0]!
  const lease = await hold(f.service, id)
  expect(lease.first).toEqual({ value: {}, done: false })
  await f.service.presentation(id, startShow)
  native.emit({ kind: 'revision', revision: 1 })
  const callback = { kind: 'callback', type: 0, payload: '0,0,10,10' } as const
  native.emit(callback)
  const presentation = { kind: 'presentation', part: 1, ended: false } as const
  native.emit(presentation)
  expect(await lease.stream.next()).toMatchObject({ value: { presentation } })
  a.cancel(); b.cancel()
  await Promise.all([a.done, b.done])
  expect(a.received.map(item => item.event)).toEqual([callback])
  expect(b.received).toEqual(a.received)
  expect(native.mock.presentation).toHaveBeenCalledOnce()
  await lease.cancel()
})

test.each([false, true])('reattaching the same renderer observes the last slide and ended=%s', async (ended) => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!
  const original = await hold(f.service, id)
  await f.service.presentation(id, startShow)
  await original.cancel()
  const presentation = { kind: 'presentation', part: 2, ended } as const
  native.emit(presentation)
  const resumed = await hold(f.service, id)
  expect(resumed.first.value).toEqual({ presentation })
  expect(native.mock.presentation).toHaveBeenCalledOnce()
  const next = await hold(f.service, id, 'replacement')
  expect(next.first.value).toEqual({})
  expect(await resumed.stream.next()).toMatchObject({ done: true })
  expect(native.mock.presentation).toHaveBeenCalledTimes(ended ? 1 : 2)
  if (!ended) expect(native.mock.presentation).toHaveBeenLastCalledWith({ action: 'stop' })
  await next.cancel()
})

test('a failed stop refuses takeover and a failed start preserves a concurrent native end', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!
  const original = await hold(f.service, id)
  await f.service.presentation(id, startShow)
  native.mock.presentation.mockRejectedValueOnce(new Error('stop failed'))
  await expect(hold(f.service, id, 'replacement')).rejects.toThrow('stop failed')
  await f.service.presentation(id, { action: 'stop' })
  native.emit({ kind: 'presentation', part: 4, ended: true })
  native.mock.presentation.mockRejectedValueOnce(new Error('start refused'))
  await expect(f.service.presentation(id, startShow)).rejects.toThrow('start refused')
  native.mock.presentation.mockImplementationOnce(async () => {
    native.emit({ kind: 'presentation', part: 1, ended: true })
    throw new Error('start interrupted')
  })
  await expect(f.service.presentation(id, startShow)).rejects.toThrow('start interrupted')
  const resumed = await hold(f.service, id)
  expect(resumed.first.value).toEqual({ presentation: { kind: 'presentation', part: 1, ended: true } })
  await original.cancel(); await resumed.cancel()
})

test('each disconnected or never-attached document expires after its own grace period', async () => {
  expect(OfficePreview.Config({}).orphanRetentionMs).toBe(60_000)
  await using f = await fixture({ config: { orphanRetentionMs: 100 } })
  vi.useFakeTimers()
  try {
    const id = (await f.open()).document!.documentId
    const live = await hold(f.service, id)
    const orphan = (await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('other') })).document!.documentId
    await vi.advanceTimersByTimeAsync(100)
    await expect(hold(f.service, orphan)).rejects.toMatchObject({ code: 'office/document-expired' })
    expect(await f.service.info(id)).toMatchObject({ documentId: id })
    await live.cancel()
    await vi.advanceTimersByTimeAsync(99)
    const resumed = await hold(f.service, id)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.closed).toHaveBeenCalledOnce()
    await resumed.cancel()
    await vi.advanceTimersByTimeAsync(99)
    expect(await f.service.info(id)).toMatchObject({ documentId: id })
    await vi.advanceTimersByTimeAsync(1)
    await expect(f.service.info(id)).rejects.toMatchObject({ code: 'office/document-expired' })
    expect(f.closed).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

test('reattaching ahead of a queued expiry invalidates the timer and a failed orphan close retries', async () => {
  await using f = await fixture({ config: { orphanRetentionMs: 50 } })
  vi.useFakeTimers()
  try {
    const id = (await f.open()).document!.documentId
    const gate = Promise.withResolvers<EditorInfo>()
    f.documents[0]!.mock.getInfo.mockReturnValueOnce(gate.promise)
    const read = f.service.info(id), reattach = f.open()
    vi.advanceTimersByTime(50)
    gate.resolve(info)
    await read; await reattach
    expect(await f.service.info(id)).toMatchObject({ documentId: id })
    expect(f.closed).not.toHaveBeenCalled()
    f.closed.mockRejectedValueOnce(new Error('close failed'))
    await vi.advanceTimersByTimeAsync(50)
    expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'close failed' }))
    await vi.advanceTimersByTimeAsync(50)
    expect(f.closed).toHaveBeenCalledTimes(2)
    await expect(hold(f.service, id)).rejects.toMatchObject({ code: 'office/document-expired' })
  } finally { vi.useRealTimers() }
})

test('an engine failure closes the channel and admits only status and release', async () => {
  await using f = await fixture()
  const events = subscribe(f.service)
  const id = (await f.open()).document!.documentId, native = f.documents[0]!
  await f.service.presentation(id, { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 })
  native.emit({ kind: 'failure', error: new Error('renderer exited') })
  native.emit({ kind: 'failure', error: new Error('renderer still unavailable') })
  await vi.waitFor(() => { expect(events.received).toHaveLength(2) })
  expect(events.received[0]).toMatchObject({ event: { kind: 'failure', error: 'renderer exited' }, failed: 'renderer exited' })
  expect(await f.service.info(id)).toEqual({ documentId: id, failed: 'renderer still unavailable' })
  await expect(f.service.reconnect(id, 'user')).rejects.toThrow('renderer still unavailable')
  await expect(f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 1, frame })).rejects.toThrow('renderer still unavailable')
  await expect(f.service.pagePreview(id, { ...area, pixelWidth: 1, pixelHeight: 1 })).rejects.toThrow('renderer still unavailable')
  expect(native.mock.render).not.toHaveBeenCalled()
  expect(native.mock.detachSurfaceTransport).not.toHaveBeenCalled()
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(rx(1))
  events.cancel(); await events.done
  await expect(hold(f.service, id)).rejects.toThrow('renderer still unavailable')
  await f.service.info(id)
  expect(native.mock.presentation).toHaveBeenCalledOnce()
  await f.service.release(id)
  expect(native.mock.detachSurfaceTransport).not.toHaveBeenCalled()
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(rx(1))
  expect(f.closed).toHaveBeenCalledOnce()
})

test('a failed reattachment closes its document and channel before the format fallback', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId
  f.frameForwarding.capabilities.mockResolvedValueOnce({ supported: false })
  await expect(f.open()).rejects.toThrow('Office FrameForwarding is unavailable.')
  await expect(f.service.info(id)).rejects.toThrow('Office document is closed.')
  await f.service.release(id)
  expect(f.closed).toHaveBeenCalledOnce()
  expect(f.channels.size).toBe(0)
})

test('an automatic reconnect connects the running engine to a new channel only after Desktop lost the open one', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  const probes = f.frameForwarding.capabilities.mock.calls.length
  expect(await f.service.reconnect(id, 'automatic')).toEqual({ outcome: 'reconnected', status: await f.service.info(id).then(({ info: _info, ...status }) => status) })
  expect(f.frameForwarding.capabilities).toHaveBeenCalledTimes(probes)
  expect(f.frameForwarding.close).not.toHaveBeenCalled()
  await f.service.presentation(id, { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 })
  f.channels.delete(rx(1))
  const reconnected = await f.service.reconnect(id, 'automatic')
  expect(reconnected).toEqual({ outcome: 'reconnected', status: { documentId: id,
    nativeView: { rx: rx(2), frameTimeoutMs: 10000 } } })
  expectNoCredential(reconnected)
  // The same engine keeps its document; the slideshow stops before the channel is replaced.
  expect(f.officeKit.openDocument).toHaveBeenCalledOnce()
  expect(native.presentation).toHaveBeenLastCalledWith({ action: 'stop' })
  expect(native.presentation.mock.invocationCallOrder.at(-1)).toBeLessThan(native.detachSurfaceTransport.mock.invocationCallOrder[0]!)
  expect(f.frameForwarding.close).toHaveBeenCalledExactlyOnceWith(rx(1))
  expect(native.attachSurfaceTransport.mock.calls).toEqual([connect(1), connect(2)])
  await expect(f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 2, frame })).resolves.toMatchObject({ width: 1, height: 2 })
  await f.service.presentation(id, { action: 'start', pixelWidth: 1, pixelHeight: 1, part: 0 })
  await f.service.presentation(id, { action: 'stop' })
  expect(native.presentation).toHaveBeenCalledTimes(4)
})

test.each([false, true])('channel loss restores the last shown slide to the native preview when ended=%s', async (ended) => {
  await using f = await fixture({ documentInfo: slideInfo })
  const id = (await f.open(slides)).document!.documentId, native = f.documents[0]!
  const lease = await hold(f.service, id)
  await f.service.presentation(id, startShow)
  const presentation = { kind: 'presentation', part: 1, ended } as const
  native.emit(presentation)
  expect((await lease.stream.next()).value).toEqual({ presentation })
  await expect(f.service.info(id)).resolves.toMatchObject({ info: { part: 0 } })
  native.mock.presentation.mockImplementationOnce(async () => { native.emit({ kind: 'presentation', part: 0, ended: true }) })
  f.channels.delete(rx(1))

  await expect(f.service.reconnect(id, 'automatic')).resolves.toMatchObject({ outcome: 'reconnected' })
  expect(native.mock.setPart).toHaveBeenCalledExactlyOnceWith(1)
  expect(native.mock.setPart.mock.invocationCallOrder[0]).toBeLessThan(native.mock.detachSurfaceTransport.mock.invocationCallOrder[0]!)
  expect(native.mock.presentation.mock.calls.flat()).toEqual(ended ? [startShow] : [startShow, { action: 'stop' }])
  await expect(f.service.info(id)).resolves.toMatchObject({ info: { part: 1 } })
  await f.service.release(id)
  expect(await lease.stream.next()).toMatchObject({ done: true })
})

test('a failed slideshow stop or slide selection can be retried before replacing the channel', async () => {
  await using f = await fixture({ documentInfo: slideInfo })
  const id = (await f.open(slides)).document!.documentId, native = f.documents[0]!
  await f.service.presentation(id, startShow)
  native.emit({ kind: 'presentation', part: 1, ended: false })
  f.channels.delete(rx(1))
  native.mock.presentation.mockRejectedValueOnce(new Error('stop refused'))
  native.mock.setPart.mockRejectedValueOnce(new Error('selection refused'))
  await expect(f.service.reconnect(id, 'automatic')).rejects.toThrow('stop refused')
  await expect(f.service.reconnect(id, 'user')).rejects.toThrow('selection refused')
  expect(native.mock.detachSurfaceTransport).not.toHaveBeenCalled()
  await expect(f.service.reconnect(id, 'user')).resolves.toMatchObject({ outcome: 'reconnected' })
  expect(native.mock.presentation.mock.calls.flat()).toEqual([startShow, { action: 'stop' }, { action: 'stop' }])
  expect(native.mock.setPart.mock.calls).toEqual([[1], [1]])
  await expect(f.service.info(id)).resolves.toMatchObject({ info: { part: 1 } })
})

test('automatic reconnects are limited per document within their window, while user reconnects always replace the channel', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const f = await fixture({ config: { automaticReconnects: 1, automaticReconnectWindowMs: 60_000 } })
  try {
    const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
    f.channels.delete(rx(1))
    expect(await f.service.reconnect(id, 'automatic')).toMatchObject({ outcome: 'reconnected', status: { nativeView: { rx: rx(2) } } })
    f.channels.delete(rx(2))
    now.mockReturnValue(60_999)
    expect(await f.service.reconnect(id, 'automatic')).toEqual({ outcome: 'limited' })
    expect(f.frameForwarding.channel).toHaveBeenCalledTimes(2)
    expect(await f.service.reconnect(id, 'user')).toMatchObject({ outcome: 'reconnected', status: { nativeView: { rx: rx(3) } } })
    expect(await f.service.reconnect(id, 'user')).toMatchObject({ outcome: 'reconnected', status: { nativeView: { rx: rx(4) } } })
    f.channels.delete(rx(4))
    now.mockReturnValue(61_000)
    expect(await f.service.reconnect(id, 'automatic')).toMatchObject({ outcome: 'reconnected', status: { nativeView: { rx: rx(5) } } })
    expect(native.attachSurfaceTransport.mock.calls).toEqual([connect(1), connect(2), connect(3), connect(4), connect(5)])
  } finally { await f.dispose() }
  await using disabled = await fixture({ config: { automaticReconnects: 0 } })
  const id = (await disabled.open()).document!.documentId
  disabled.channels.delete(rx(1))
  expect(await disabled.service.reconnect(id, 'automatic')).toEqual({ outcome: 'limited' })
})

test('a reconnect reports Desktop without native frames as unavailable without spending the automatic limit', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId
  f.channels.delete(rx(1))
  f.frameForwarding.capabilities.mockResolvedValueOnce({ supported: false, reason: 'gpu-compositing-disabled' })
  expect(await f.service.reconnect(id, 'automatic')).toEqual({ outcome: 'unavailable', reason: 'gpu-compositing-disabled' })
  f.frameForwarding.capabilities.mockResolvedValueOnce({ supported: false })
  expect(await f.service.reconnect(id, 'user')).toEqual({ outcome: 'unavailable', reason: 'frame forwarding is unsupported' })
  expect(f.frameForwarding.close).not.toHaveBeenCalled()
  expect(await f.service.reconnect(id, 'automatic')).toMatchObject({ outcome: 'reconnected', status: { nativeView: { rx: rx(2) } } })
})

test('releasing a document after the Host withdrew frame forwarding still closes its engine and logs the channel failure', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId
  f.ctx.set('frameForwarding', undefined)
  await f.service.release(id)
  expect(f.documents[0]!.mock.detachSurfaceTransport).toHaveBeenCalledOnce()
  expect(f.frameForwarding.close).not.toHaveBeenCalled()
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'Frame forwarding is unavailable.' }))
  expect(f.closed).toHaveBeenCalledOnce()
})

test('disposal ends the event stream, waits for admitted work and logs document close failures', async () => {
  const f = await fixture()
  const events = subscribe(f.service)
  await f.open()
  await f.open({ ...source, owner: brandString<OfficeOpenRequest['owner']>('second') })
  f.closed.mockRejectedValueOnce(new Error('document close failed'))
  await f.dispose()
  await events.done
  expect(f.closed).toHaveBeenCalledTimes(2)
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'document close failed' }))
})

test.each([
  new Error('Native frame viewport is stale: unrelated failure'),
  new Error('Native texture credit timed out: device lost'),
  'Native frame viewport is stale',
])('unclassified Kit failures retain their original rejection: %s', async (failure) => {
  await using f = await fixture()
  const opened = (await f.open()).document, engine = f.documents[0]
  if (opened === undefined || engine === undefined) throw new Error('Expected an opened document.')
  engine.mock.renderSurface.mockRejectedValueOnce(failure)
  await expect(f.service.paint(opened.documentId, { ...area, pixelWidth: 1, pixelHeight: 2, frame })).rejects.toBe(failure)
})


test('release waits for a failed reattachment to finish closing its engine', async () => {
  const f = await fixture(), closing = Promise.withResolvers<undefined>(), started = Promise.withResolvers<undefined>()
  try {
    const id = (await f.open()).document!.documentId
    f.documents[0]!.emit({ kind: 'failure', error: new Error('engine exited') })
    f.closed.mockImplementationOnce(async () => { started.resolve(undefined); await closing.promise })
    const reattaching = expect(f.open()).rejects.toThrow('engine exited')
    await started.promise
    let released = false
    const release = f.service.release(id).then(() => { released = true })
    await f.service.availability()
    expect(released).toBe(false)
    closing.resolve(undefined)
    await reattaching
    await release
    expect(f.closed).toHaveBeenCalledOnce()
  } finally { closing.resolve(undefined); await f.dispose() }
})


test('a failed producer reconnect keeps frame operations unavailable until reattachment succeeds', async () => {
  await using f = await fixture()
  const id = (await f.open()).document!.documentId, native = f.documents[0]!.mock
  native.attachSurfaceTransport.mockRejectedValueOnce(new Error('producer refused'))
  await expect(f.service.reconnect(id, 'user')).rejects.toThrow('producer refused')
  await expect(f.service.paint(id, { ...area, pixelWidth: 1, pixelHeight: 1, frame })).rejects.toThrow('Office shared rendering is unavailable.')
  await expect(f.service.presentation(id, { action: 'stream', enabled: true, streamId: 'stream', generation: 1 }))
    .rejects.toThrow('Office shared rendering is unavailable.')
  await f.service.reconnect(id, 'user')
  await expect(f.service.presentation(id, { action: 'stream', enabled: true, streamId: 'x'.repeat(257), generation: 1 }))
    .rejects.toThrow('Invalid Office stream identifier.')
  expect(native.presentation).not.toHaveBeenCalled()
})

test('engine failure during reattachment rejects the open and reports a failed engine close', async () => {
  await using f = await fixture()
  const cleanup = new Error('close failed')
  await f.open()
  const engine = f.documents[0]!
  engine.mock.getInfo.mockImplementationOnce(async () => {
    engine.emit({ kind: 'failure', error: new Error('engine exited while reattaching') })
    return info
  })
  f.closed.mockRejectedValueOnce(cleanup)
  await expect(f.open()).rejects.toThrow('engine exited while reattaching')
  expect(f.warn).toHaveBeenCalledWith(cleanup)
  expect(f.channels.size).toBe(0)
})

test('an engine failure reports channel cleanup rejection without losing document release', async () => {
  await using f = await fixture()
  const cleanup = new Error('channel close failed')
  const id = (await f.open()).document!.documentId
  f.frameForwarding.close.mockRejectedValueOnce(cleanup)
  f.documents[0]!.emit({ kind: 'failure', error: new Error('engine exited') })
  await f.service.release(id)
  expect(f.warn).toHaveBeenCalledWith(cleanup)
  expect(f.closed).toHaveBeenCalledOnce()
})

test('a small source limit leaves the RGBA output budget available to the editor', async () => {
  const maxDocumentBytes = 1024 * 1024, maxPagePreviewBytes = 4 * 1024 * 1024
  await using f = await fixture({ config: { maxDocumentBytes, maxPagePreviewBytes } })
  await f.open()
  expect(f.officeKit.openDocument.mock.lastCall?.[0].options).toMatchObject({
    maxInputBytes: maxDocumentBytes, maxOutputBytes: maxPagePreviewBytes,
  })
})
