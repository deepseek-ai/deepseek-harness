// @vitest-environment jsdom
/** Open progress, refresh and release remain owned by their tab lifetime. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeRetentionFrame } from '../src/types.ts'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { OfficeOpenProgress } from '../src/types.ts'
import { officeViewFixture } from './helpers/office-view.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('loading displays each Host stage before the opened document replaces it', async () => {
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
  const f = officeViewFixture('text', false, ({ remote, opened }) => {
    remote.open = vi.fn(async function* () {
      for (const [index, stage] of (['fonts', 'engine', 'document'] as const).entries()) {
        yield { kind: 'stage', stage } as const
        await gates[index]!.promise
      }
      yield { kind: 'opened', document: opened } as const
    })
  })
  try {
    for (const [index, label] of [en.loadingFonts, en.loadingEngine, en.loadingDocument].entries()) {
      await f.flush(); expect(screen.getByText(label)).toBeDefined()
      await act(async () => { gates[index]!.resolve(undefined) })
    }
    await f.flush()
    expect(f.paint).toHaveBeenCalled()
    expect(screen.queryByText(en.loadingDocument)).toBeNull()
  } finally { for (const gate of gates) gate.resolve(undefined); await f.close() }
})

test.each(['abort', 'unmount'] as const)('late open progress after %s never paints and releases its document', async (ending) => {
  const gate = Promise.withResolvers<undefined>()
  const f = officeViewFixture('text', false, ({ remote, opened }) => {
    remote.open = vi.fn(async function* () {
      await gate.promise
      yield { kind: 'stage', stage: 'document' } as const
      yield { kind: 'opened', document: opened } as const
    })
  })
  try {
    if (ending === 'abort') act(() => { f.controller.abort() })
    else f.view.unmount()
    gate.resolve(undefined); await f.flush()
    expect(f.paint).not.toHaveBeenCalled()
    expect(f.remote.release).toHaveBeenCalledOnce()
  } finally { gate.resolve(undefined); await f.close() }
})

test.each([null, 'geometry', {}, { width: 1 }, { width: 1, height: 1 }, { width: 1, height: 1, parts: [] },
  { width: 1, height: 1, parts: [], rectangles: 1 }, { width: '1', height: 1, parts: [], rectangles: '' },
  { width: 1, height: '1', parts: [], rectangles: '' }, { width: 1, height: 1, parts: {}, rectangles: '' }])(
  'invalid wire geometry %j exposes retry instead of an empty document', async (geometry) => {
    await using f = officeViewFixture('text', false, ({ remote, opened }) => {
      remote.open = vi.fn(async function* () { yield { kind: 'opened', document: { ...opened, info: geometry } } as never })
    })
    await f.flush()
    expect(screen.getByRole('alert').textContent).toContain('Invalid Office geometry.')
    expect(f.remote.release).toHaveBeenCalledWith(f.opened.documentId)
    expect(f.paint).not.toHaveBeenCalled()
    f.remote.open = vi.fn(async function* () { yield { kind: 'opened', document: f.opened } as const })
    fireEvent.click(screen.getByRole('button', { name: en.retry })); await f.flush()
    expect(f.paint).toHaveBeenCalled()
  },
)

test.each(['closed tab', 'unloaded plugin'] as const)('a late mount after a %s cannot open a document', async (ending) => {
  await using f = officeViewFixture('text', false, ({ props }) => {
    if (ending === 'unloaded plugin') void props.connection.dispose()
    else {
      const info = props.useTabInfo()
      const tab = { ...info.tab, signal: AbortSignal.abort() }
      props.useTabInfo = () => ({ ...info, tab })
    }
  })
  await f.flush()
  expect(f.remote.open).not.toHaveBeenCalled()
  expect(f.remote.release).not.toHaveBeenCalled()
})

test('a non-session address fails without starting a Host open', async () => {
  await using f = officeViewFixture('text', false, ({ props }) => {
    const info = props.useTabInfo()
    props.useTabInfo = () => ({ ...info, tab: { ...info.tab, contentId: 'https://example.test/file.docx' } })
  })
  await f.flush()
  expect(screen.getByRole('alert').textContent).toContain('Office requires a session file address.')
  expect(f.remote.open).not.toHaveBeenCalled()
})

test('refresh while a failed open is pending waits for it and suppresses duplicate refresh', async () => {
  const gate = Promise.withResolvers<OfficeOpenProgress>()
  const f = officeViewFixture('text', false, ({ remote, opened }) => {
    remote.open = vi.fn(async function* () { yield await gate.promise })
      .mockImplementationOnce(async function* () { yield await gate.promise })
      .mockImplementation(async function* () { yield { kind: 'opened', document: opened } as const })
  })
  try {
    await f.refresh(); await f.refresh()
    gate.reject(new Error('initial open failed')); await f.flush()
    expect(f.remote.open).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText(en.editor)).toBeDefined()
  } finally { gate.resolve({ kind: 'opened', document: f.opened }); await f.close() }
})

test('release failures are reported after the tab stops rather than becoming unhandled rejections', async () => {
  const error = new Error('release failed'), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await using f = officeViewFixture()
  await f.flush()
  vi.mocked(f.remote.release!).mockRejectedValueOnce(error)
  act(() => { f.controller.abort() }); await f.flush()
  expect(log).toHaveBeenCalledWith('Office checkpoint release failed', error)
})

test('input queued before refresh cannot query the retired document', async () => {
  await using f = officeViewFixture()
  await f.flush()
  const pending = Promise.withResolvers<undefined>()
  vi.mocked(f.remote.info!).mockImplementationOnce(async () => {
    await pending.promise
    return { ok: true, value: { documentId: f.opened.documentId } }
  })
  await f.emit({ kind: 'callback', type: 13, payload: '' })
  await f.emit({ kind: 'callback', type: 13, payload: '' })
  await f.refresh()
  pending.resolve(undefined); await f.flush()
  expect(f.remote.info).toHaveBeenCalledOnce()
  expect(f.remote.open).toHaveBeenCalledTimes(2)
})

test('callbacks for a document retired by refresh never reach the Host', async () => {
  const f = officeViewFixture(), released = Promise.withResolvers<undefined>(), opened = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    vi.mocked(f.remote.release!).mockImplementationOnce(async () => { await released.promise; return { ok: true, value: undefined } })
    vi.mocked(f.remote.open!).mockImplementationOnce(async function* () {
      await opened.promise
      yield { kind: 'opened', document: f.opened } as const
    })
    await f.refresh()
    await f.emit({ kind: 'callback', type: 13, payload: '' })
    expect(f.remote.info).not.toHaveBeenCalled()
    released.resolve(undefined); await f.flush()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.remote.info).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(en.editor)).toBeNull()
    opened.resolve(undefined); await f.flush()
    expect(screen.getByLabelText(en.editor)).toBeDefined()
  } finally { released.resolve(undefined); opened.resolve(undefined); await f.close() }
})

test('a late parallel selection reply during reload cannot restore the released document', async () => {
  const f = officeViewFixture(), selection = Promise.withResolvers<undefined>(), opened = Promise.withResolvers<undefined>()
  try {
    await f.flush()
    vi.mocked(f.remote.selection!).mockRejectedValueOnce(new Error('selection refused')).mockImplementationOnce(async () => {
      await selection.promise
      return { ok: true, value: { documentId: f.opened.documentId, info: f.opened.info, text: 'old selection' } }
    })
    fireEvent.keyDown(screen.getByLabelText(en.editor), { key: 'c', ctrlKey: true }); await f.flush()
    expect(f.remote.selection).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).toContain('selection refused')
    vi.mocked(f.remote.open!).mockImplementationOnce(async function* () {
      await opened.promise
      yield { kind: 'opened', document: f.opened } as const
    })
    await f.refresh()
    expect(screen.getByText(en.loading)).toBeDefined()
    selection.resolve(undefined); await f.flush()
    expect(screen.getByText(en.loading)).toBeDefined()
    expect(screen.queryByLabelText(en.editor)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    opened.resolve(undefined); await f.flush()
    expect(screen.getByLabelText(en.editor)).toBeDefined()
  } finally { selection.resolve(undefined); opened.resolve(undefined); await f.close() }
})

test.each(['resize', 'visibility'] as const)('%s during tab unmount before passive cleanup is inert', async (event) => {
  let resize: ResizeObserverCallback | undefined
  const disconnect = vi.fn()
  await using f = officeViewFixture('text', false, () => {
    const Observer = ResizeObserver
    vi.stubGlobal('ResizeObserver', class extends Observer {
      constructor(private readonly notify: ResizeObserverCallback) { super(notify) }
      override observe(target: Element) {
        if (target.hasAttribute('data-office-viewport')) resize ??= this.notify
        super.observe(target)
      }
      override disconnect() {
        if (this.notify === resize) disconnect()
        super.disconnect()
      }
    })
  })
  await f.flush()
  const scroll = f.area(), editor = scroll.closest('[data-office-document-area]')!.parentElement!, parent = editor.parentElement!
  const remove = parent.removeChild.bind(parent), delivered = vi.fn()
  const requests = vi.mocked(f.remote.info!), paints = vi.spyOn(f.connection, 'requestFrame')
  let requestsAtRemoval = 0
  vi.spyOn(parent, 'removeChild').mockImplementation(<T extends Node>(child: T): T => {
    const removed = remove(child)
    if (child instanceof HTMLDivElement && child === editor) {
      expect(scroll.isConnected).toBe(false)
      expect(disconnect).not.toHaveBeenCalled()
      requestsAtRemoval = requests.mock.calls.length
      if (event === 'resize') expect(() => { resize!([], {} as ResizeObserver) }).not.toThrow()
      else document.dispatchEvent(new Event('visibilitychange'))
      expect(requests).toHaveBeenCalledTimes(requestsAtRemoval)
      delivered()
    }
    return removed
  })
  f.view.unmount()
  expect(delivered).toHaveBeenCalledOnce()
  expect(requests).toHaveBeenCalledTimes(requestsAtRemoval)
  expect(paints).not.toHaveBeenCalled()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a document opening under another fullscreen element starts occluded', async () => {
  await using f = officeViewFixture('text', false, ({ fullscreen }) => { fullscreen.change(document.body) })
  await f.flush()
  expect(f.paint).not.toHaveBeenCalled()
  act(() => { f.fullscreen.change(null) }); await f.flush()
  expect(f.paint).toHaveBeenCalled()
})

function controlledLease() {
  let sink!: ReadableStreamDefaultController<OfficeRetentionFrame>
  let closed = false
  const reader = new ReadableStream<OfficeRetentionFrame>({ start(controller) { sink = controller } }).getReader()
  const channel = {
    push: (frame: OfficeRetentionFrame) => { sink.enqueue(frame) },
    fail: (error: Error) => { closed = true; sink.error(error) },
  }
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (let item = await reader.read(); !item.done; item = await reader.read()) yield { value: item.value, accept() {} }
    },
    async dispose() { if (!closed) { closed = true; sink.close() } },
  }
  return { channel, stream }
}

const expired = () => new RemoteError('office/document-expired', 'Office document is closed.', {})

test.each(['visible', 'hidden', 'playing'])('a %s tab reopens an expired document once', async (state) => {
  const first = controlledLease(), next = controlledLease()
  first.channel.push({}); next.channel.push({})
  await using f = officeViewFixture('presentation', false, ({ lease }) => {
    lease.mockReturnValueOnce(first.stream).mockReturnValueOnce(next.stream)
  })
  await f.flush()
  if (state === 'hidden') await f.visibility(false)
  if (state === 'playing') await f.play()
  await act(async () => { first.channel.fail(expired()) }); await f.flush()
  expect(f.remote.open).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(screen.queryByRole('toolbar', { name: en.playbackControls })).toBeNull()
  vi.mocked(f.remote.open!).mockImplementationOnce(async function* () { throw expired() })
  await act(async () => { next.channel.fail(expired()) }); await f.flush()
  expect(f.onFailure).toHaveBeenCalledOnce()
  expect(f.remote.open).toHaveBeenCalledTimes(3)
})

test('a disconnected lease suspends the display, resumes its slide, and surfaces a terminal lease failure', async () => {
  const lease = controlledLease()
  lease.channel.push({})
  await using f = officeViewFixture('presentation', false, (setup) => { setup.lease.mockReturnValueOnce(lease.stream) })
  await f.flush(); await f.play()
  await act(async () => { f.lease.mock.calls[0]![1]() }); await f.flush()
  expect(screen.getByText(en.reconnecting)).toBeDefined()
  lease.channel.push({ presentation: { kind: 'presentation', part: 1, ended: true } }); await f.flush()
  expect(screen.queryByText(en.reconnecting)).toBeNull()
  expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true')
  expect(f.onFailure).not.toHaveBeenCalled()
  lease.channel.fail(new Error('lease denied')); await f.flush()
  expect(f.onFailure).toHaveBeenCalledOnce()
  expect(f.remote.open).toHaveBeenCalledOnce()
})

test.each(['opened', 'expired', 'failed'])('a lease expiring before its first acknowledgement retries once, then %s', async (outcome) => {
  const first = controlledLease(), second = controlledLease()
  first.channel.fail(expired())
  if (outcome === 'opened') second.channel.push({})
  else second.channel.fail(outcome === 'expired' ? expired() : new Error('reopen failed'))
  await using f = officeViewFixture('text', false, (setup) => {
    setup.lease.mockReturnValueOnce(first.stream).mockReturnValueOnce(second.stream)
  })
  await f.flush()
  expect(f.remote.open).toHaveBeenCalledTimes(2)
  expect(f.onFailure).toHaveBeenCalledTimes(outcome === 'opened' ? 0 : 1)
})

test('closing a tab before its first lease reply suppresses the reopen', async () => {
  const lease = controlledLease()
  await using f = officeViewFixture('text', false, (setup) => { setup.lease.mockReturnValueOnce(lease.stream) })
  await f.flush()
  f.controller.abort(); lease.channel.fail(expired()); await f.flush()
  expect(f.remote.open).toHaveBeenCalledOnce()
  expect(f.onFailure).not.toHaveBeenCalled()
})

test('an expired paint before the lease reply triggers the same single reopen', async () => {
  await using f = officeViewFixture('presentation', false, ({ remote }) => {
    vi.mocked(remote.paint!).mockResolvedValueOnce({ ok: false, error: expired() })
  })
  await f.flush()
  expect(f.remote.open).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
})

test('expiry notifications after tab closure cannot reopen its document', async () => {
  const first = controlledLease()
  first.channel.push({})
  await using f = officeViewFixture('text', false, (setup) => { setup.lease.mockReturnValueOnce(first.stream) })
  await f.flush()
  act(() => {
    f.controller.abort()
    f.connection.dispatch({ documentId: f.opened.documentId, event: { kind: 'expired' } })
  })
  await f.flush()
  expect(f.remote.open).toHaveBeenCalledOnce()
  expect(f.onFailure).not.toHaveBeenCalled()
})

test('a late lease error during release is ignored and a failed receiver cleanup still reopens', async () => {
  const first = controlledLease()
  first.channel.push({})
  first.stream.dispose = async () => { first.channel.fail(new Error('retired lease')) }
  await using f = officeViewFixture('text', false, (setup) => { setup.lease.mockReturnValueOnce(first.stream) })
  await f.flush()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const release = f.connection.release.bind(f.connection)
  vi.spyOn(f.connection, 'release').mockImplementationOnce(async (...args) => {
    await release(...args)
    throw new Error('receiver close failed')
  })
  await f.emit({ kind: 'expired' })
  expect(f.remote.open).toHaveBeenCalledTimes(2)
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith('Office expired receiver cleanup failed.', expect.any(Error))
})

test.each(['expired', 'refused'])('refresh during playback handles a %s stop', async (outcome) => {
  await using f = officeViewFixture('presentation')
  await f.flush(); await f.play()
  const present = f.remote.presentation!, original = vi.mocked(present).getMockImplementation()!
  vi.mocked(present).mockImplementation(async (...args: Parameters<typeof present>) => {
    if (args[1].action === 'stop') throw outcome === 'expired' ? expired() : new Error('stop refused')
    return original(...args)
  })
  await f.refresh()
  expect(f.remote.open).toHaveBeenCalledTimes(outcome === 'expired' ? 2 : 1)
  expect(f.onFailure).toHaveBeenCalledTimes(outcome === 'expired' ? 0 : 1)
})
