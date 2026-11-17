// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SessionMarkdownCopyController,
  type SessionMarkdownClipboard,
} from '../src/client/copy-controller.ts'

const SID = 'session-copy-controller' as SessionId
const OTHER = 'session-copy-other' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fallbackClipboard(writeText: (text: string) => Promise<boolean>): SessionMarkdownClipboard {
  return {
    supportsDeferredWrite: () => false,
    writeDeferred: () => Promise.reject(new Error('deferred write must not start')),
    writeText,
  }
}

describe('SessionMarkdownCopyController', () => {
  it('starts the deferred write synchronously and resolves its Blob promise later', async () => {
    const responses = Promise.withResolvers<Response>()
    let deferred: Promise<Blob> | undefined
    const writeDeferred = vi.fn((data: Promise<Blob>) => {
      deferred = data
      return Promise.resolve()
    })
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      {
        supportsDeferredWrite: () => true,
        writeDeferred,
        writeText: vi.fn(async () => false),
      },
    )

    const pending = controller.copy(SID)
    expect(writeDeferred).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().copying).toBe(true)
    responses.resolve(new Response('# Title\n\nText\n'))
    await pending

    if (deferred === undefined) throw new Error('clipboard data promise was not provided')
    const blob = await deferred
    expect(blob).toBeInstanceOf(Blob)
    expect(await blob.text()).toBe('# Title\n\nText\n')
    expect(controller.store.getSnapshot()).toMatchObject({
      copying: false,
      notice: { kind: 'success' },
    })
  })

  it('joins a second-Session request to the pending copy and keeps its captured target', async () => {
    const responses = Promise.withResolvers<Response>()
    const fetcher = vi.fn((_input: string | URL, _init?: RequestInit) => responses.promise)
    const controller = new SessionMarkdownCopyController(fetcher, {
      supportsDeferredWrite: () => true,
      writeDeferred: async () => {},
      writeText: vi.fn(async () => false),
    })

    const first = controller.copy(SID)
    const second = controller.copy(OTHER)
    expect(first).toBe(second)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe(`api/session.markdown?sessionId=${SID}`)

    responses.resolve(new Response('markdown for first'))
    await first
    expect(controller.store.getSnapshot().copying).toBe(false)

    await controller.copy(OTHER)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toBe(`api/session.markdown?sessionId=${OTHER}`)
  })

  it('falls back to writing prepared text only when deferred APIs are missing', async () => {
    const responses = Promise.withResolvers<Response>()
    const writeText = vi.fn(async () => true)
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      fallbackClipboard(writeText),
    )

    const pending = controller.copy(SID)
    expect(writeText).not.toHaveBeenCalled()
    responses.resolve(new Response('# Fallback'))
    await pending

    expect(writeText).toHaveBeenCalledWith('# Fallback')
    expect(controller.store.getSnapshot().notice?.kind).toBe('success')
  })

  it('classifies HTTP, transport, and deferred preparation failures', async () => {
    const http = new SessionMarkdownCopyController(
      async () => new Response('hidden detail', { status: 500 }),
      {
        supportsDeferredWrite: () => true,
        writeDeferred: async () => {},
        writeText: vi.fn(async () => false),
      },
    )
    await http.copy(SID)
    expect(http.store.getSnapshot().notice?.kind).toBe('preparationFailed')

    const transport = new SessionMarkdownCopyController(
      async () => { throw new Error('offline') },
      fallbackClipboard(vi.fn(async () => true)),
    )
    await transport.copy(SID)
    expect(transport.store.getSnapshot().notice?.kind).toBe('preparationFailed')
  })

  it('classifies native denial and fallback rejection as clipboard failures', async () => {
    const denied = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      {
        supportsDeferredWrite: () => true,
        writeDeferred: async () => { throw new Error('denied') },
        writeText: vi.fn(async () => false),
      },
    )
    await denied.copy(SID)
    expect(denied.store.getSnapshot().notice?.kind).toBe('clipboardFailed')

    const rejected = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      fallbackClipboard(async () => false),
    )
    await rejected.copy(SID)
    expect(rejected.store.getSnapshot().notice?.kind).toBe('clipboardFailed')
  })

  it('contains an immediate native denial followed by a later preparation rejection', async () => {
    const responses = Promise.withResolvers<Response>()
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      {
        supportsDeferredWrite: () => true,
        writeDeferred: async () => { throw new Error('denied immediately') },
        writeText: vi.fn(async () => false),
      },
    )

    const pending = controller.copy(SID)
    responses.reject(new Error('read failed later'))
    await pending

    expect(controller.store.getSnapshot().notice?.kind).toBe('preparationFailed')
    expect(controller.store.getSnapshot().copying).toBe(false)
  })

  it('aborts the read and prevents text after disposal before readiness', async () => {
    const responses = Promise.withResolvers<Response>()
    let deferred: Promise<Blob> | undefined
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      {
        supportsDeferredWrite: () => true,
        writeDeferred: (data) => {
          deferred = data
          return Promise.resolve()
        },
        writeText: vi.fn(async () => false),
      },
    )

    const pending = controller.copy(SID)
    const disposing = controller.dispose()
    responses.resolve(new Response('late markdown'))
    await disposing
    await pending

    if (deferred === undefined) throw new Error('clipboard data promise was not provided')
    await expect(deferred).rejects.toThrow('cancelled')
    expect(controller.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })

  it('awaits admitted clipboard work and suppresses its notice on disposal', async () => {
    const writeGate = Promise.withResolvers<boolean>()
    const controller = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      {
        supportsDeferredWrite: () => true,
        writeDeferred: () => writeGate.promise.then(() => {}),
        writeText: vi.fn(async () => false),
      },
    )

    const pending = controller.copy(SID)
    const disposing = controller.dispose()
    writeGate.resolve(true)
    await disposing
    await pending

    expect(controller.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })

  it('falls back to writing on a host without deferred clipboard APIs', async () => {
    const responses = Promise.withResolvers<Response>()
    const writeText = vi.fn(async () => true)
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      fallbackClipboard(writeText),
    )

    const pending = controller.copy(SID)
    expect(writeText).not.toHaveBeenCalled()
    responses.resolve(new Response('fallback markdown'))
    await pending

    expect(writeText).toHaveBeenCalledWith('fallback markdown')
    expect(controller.store.getSnapshot().notice?.kind).toBe('success')
  })


  it('contains a synchronous deferred-write failure', async () => {
    const controller = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      {
        supportsDeferredWrite: () => true,
        writeDeferred: () => { throw new Error('constructor failed') },
        writeText: vi.fn(async () => false),
      },
    )

    await controller.copy(SID)
    expect(controller.store.getSnapshot().notice?.kind).toBe('clipboardFailed')
  })

  it('does not write fallback text after cancellation before readiness', async () => {
    const responses = Promise.withResolvers<Response>()
    const writeText = vi.fn(async () => true)
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      fallbackClipboard(writeText),
    )

    const pending = controller.copy(SID)
    const disposing = controller.dispose()
    responses.resolve(new Response('late fallback'))
    await disposing
    await pending

    expect(writeText).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })

  it('classifies a throwing fallback writer and awaits it during disposal', async () => {
    const throwing = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      fallbackClipboard(async () => { throw new Error('write failed') }),
    )
    await throwing.copy(SID)
    expect(throwing.store.getSnapshot().notice?.kind).toBe('clipboardFailed')

    const writeGate = Promise.withResolvers<boolean>()
    const writeText = vi.fn(() => writeGate.promise)
    const pendingWrite = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      fallbackClipboard(writeText),
    )
    const pending = pendingWrite.copy(SID)
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledOnce() })
    const disposing = pendingWrite.dispose()
    writeGate.resolve(true)
    await disposing
    await pending
    expect(pendingWrite.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })


  it('suppresses a fallback preparation failure after disposal', async () => {
    const responses = Promise.withResolvers<Response>()
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
      fallbackClipboard(vi.fn(async () => true)),
    )

    const pending = controller.copy(SID)
    const disposing = controller.dispose()
    responses.reject(new Error('late read failure'))
    await disposing
    await pending

    expect(controller.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })

  it('ignores copy after disposal', async () => {
    const controller = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      fallbackClipboard(vi.fn(async () => true)),
    )
    await controller.dispose()
    await expect(controller.copy(SID)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot()).toEqual({ copying: false, notice: null })
  })

  it('dismisses a notice and ignores a dismissal with no notice', async () => {
    const controller = new SessionMarkdownCopyController(
      async () => new Response('markdown'),
      {
        supportsDeferredWrite: () => true,
        writeDeferred: async () => {},
        writeText: vi.fn(async () => false),
      },
    )
    controller.dismiss()
    expect(controller.store.getSnapshot().notice).toBeNull()

    await controller.copy(SID)
    expect(controller.store.getSnapshot().notice?.kind).toBe('success')
    controller.dismiss()
    expect(controller.store.getSnapshot().notice).toBeNull()
  })

  it('starts the browser ClipboardItem write synchronously through the default adapter', async () => {
    const responses = Promise.withResolvers<Response>()
    let deferred: Promise<Blob> | undefined
    class TestClipboardItem {
      readonly text: Promise<Blob>
      constructor(items: Record<string, Promise<Blob>>) {
        const text = items['text/plain']
        if (text === undefined) throw new Error('text/plain data is required')
        this.text = text
        deferred = text
      }
    }
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', TestClipboardItem)
    vi.stubGlobal('navigator', { clipboard: { write } })
    const controller = new SessionMarkdownCopyController(
      (_input: string | URL, _init?: RequestInit) => responses.promise,
    )

    const pending = controller.copy(SID)
    expect(write).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().copying).toBe(true)
    responses.resolve(new Response('# ClipboardItem'))
    await pending

    if (deferred === undefined) throw new Error('ClipboardItem did not receive text data')
    const blob = await deferred
    expect(await blob.text()).toBe('# ClipboardItem')
    expect(controller.store.getSnapshot().notice?.kind).toBe('success')
  })

  it('uses the document-relative default carrier and the fallback clipboard helper', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('default markdown'))
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const controller = new SessionMarkdownCopyController()

    await controller.copy(SID)

    expect(fetcher).toHaveBeenCalledOnce()
    const [route, init] = fetcher.mock.calls[0]!
    expect(route).toBe(`api/session.markdown?sessionId=${SID}`)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(writeText).toHaveBeenCalledWith('default markdown')
    expect(controller.store.getSnapshot().notice?.kind).toBe('success')
  })
})
