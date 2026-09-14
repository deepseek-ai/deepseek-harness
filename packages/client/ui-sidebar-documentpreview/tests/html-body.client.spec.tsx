// @vitest-environment jsdom
/** HTML iframe ownership follows file identity and bytes, not locale or wrapping changes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HtmlBody } from '../src/client/html/HtmlBody.tsx'
import type { HtmlBodyProps } from '../src/client/html/HtmlBody.tsx'
import { en } from '../src/client/html/locales.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
  }
})

function props(text = '<p>hello</p>'): HtmlBodyProps {
  const signal = new AbortController().signal
  return {
    resourceAddress: 'dsh-resource://file/session/html/index.html',
    content: { kind: 'bytes', data: utf8(text) },
    wrap: false,
    sessionId: 'html' as SessionId,
    useTabInfo: () => ({ tab: { signal } }),
    readRelated: vi.fn(),
    useResource: () => ({ value: undefined }),
    t: key => translations.get(key) ?? key,
  } as HtmlBodyProps
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('HtmlBody', () => {
  it('renders a Blob iframe with only scripts allowed, keeping it mounted for unrelated props', async () => {
    const initial = props()
    const view = render(<HtmlBody {...initial} />)
    const iframe = await screen.findByTitle(en.frame)
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    expect(create.mock.calls[0]?.[0].type).toBe('text/html')
    view.rerender(<HtmlBody {...initial} wrap />)
    expect(screen.getByTitle(en.frame)).toBe(iframe)
    expect(create).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('destroys the old frame and revokes its Blob when bytes or source file change', async () => {
    const view = render(<HtmlBody {...props()} />)
    const first = await screen.findByTitle(en.frame)
    const changed = props('<p>changed</p>')
    view.rerender(<HtmlBody {...changed} />)
    expect(await screen.findByTitle(en.frame)).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    view.rerender(<HtmlBody {...changed} resourceAddress="dsh-resource://file/session/html/other.html" />)
    await screen.findByTitle(en.frame)
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/2')
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/3')
  })

  it('reports invalid bytes and Blob creation failures without leaving a previous frame running', async () => {
    const view = render(<HtmlBody {...props()} />)
    await screen.findByTitle(en.frame)
    view.rerender(<HtmlBody {...props()} content={{ kind: 'bytes', data: new Uint8Array([255]) }} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    expect(screen.queryByTitle(en.frame)).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    create.mockImplementationOnce(() => { throw new Error('Blob unavailable') })
    view.rerender(<HtmlBody {...props('different')} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
  })

  it('does not create a document for a text-pages delivery', () => {
    render(<HtmlBody {...props()} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(create).not.toHaveBeenCalled()
    expect(screen.queryByTitle(en.frame)).toBeNull()
  })

  it('reads related bytes through the injected callback and cancels pending reads on unmount', async () => {
    const pending = Promise.withResolvers<never>()
    const bytes = vi.fn().mockReturnValue(pending.promise)
    const signal = new AbortController().signal
    const initial = {
      ...props('<script src="./app.js"></script>'),
      useTabInfo: () => ({ tab: { signal } }),
      readRelated: bytes,
    } as unknown as HtmlBodyProps
    const view = render(<HtmlBody {...initial} />)
    expect(bytes).toHaveBeenCalledOnce()
    expect(bytes).toHaveBeenCalledWith(initial.resourceAddress, './app.js', expect.any(AbortSignal))
    const readSignal = bytes.mock.calls[0]?.[2] as AbortSignal
    view.unmount()
    expect(readSignal.aborted).toBe(true)
    await act(async () => { pending.reject(new Error('cancelled')) })
    expect(create).not.toHaveBeenCalled()
  })

  it('packages the declared local script without waiting for metadata', async () => {
    const signal = new AbortController().signal
    const bytes = vi.fn().mockResolvedValue({
      ok: true,
      value: { absolutePath: '/workspace/app.js', data: btoa('window.ready=true'), version: 'v1', offset: 0, eof: true },
    })
    const useResource = vi.fn().mockReturnValue({ value: undefined })
    const initial = {
      ...props('<script src="./app.js"></script>'),
      useTabInfo: () => ({ tab: { signal } }),
      useResource,
      readRelated: bytes,
    } as unknown as HtmlBodyProps
    render(<HtmlBody {...initial} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
    expect(screen.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    expect(create).not.toHaveBeenCalled()
    expect(await screen.findByTitle(en.frame)).toBeTruthy()
    expect(useResource).not.toHaveBeenCalled()
    expect(bytes).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
  })

  it('retains the iframe when only observed metadata changes around the stable injected callback', async () => {
    const signal = new AbortController().signal
    const bytes = vi.fn().mockResolvedValue({
      ok: true,
      value: { absolutePath: '/workspace/app.js', version: 'v1', bytes: 16, offset: 0, data: btoa('window.ready=1'), eof: true },
    })
    const useResource = vi.fn(() => ({ value: { version: 'v1' } }))
    const initial = {
      ...props('<script src="./app.js"></script>'), useTabInfo: () => ({ tab: { signal } }),
      useResource, readRelated: bytes,
    } as unknown as HtmlBodyProps
    const view = render(<HtmlBody {...initial} />)
    const iframe = await screen.findByTitle(en.frame)
    useResource.mockReturnValue({ value: { version: 'v2' } })
    view.rerender(<HtmlBody {...initial} />)
    expect(screen.getByTitle(en.frame)).toBe(iframe)
    expect(bytes).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
  })
})
