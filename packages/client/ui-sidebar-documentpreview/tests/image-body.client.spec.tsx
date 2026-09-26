// @vitest-environment jsdom
/** Image Blob ownership, media types, pane-contained rendering, and failure states. */
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { ImageBody, imageMediaType, type ImageBodyProps } from '../src/client/image/ImageBody.tsx'
import { en } from '../src/client/image/locales.ts'
import { createZoomStore, type ZoomState } from '../src/client/zoom/store.ts'

const translations: ReadonlyMap<string, string> = new Map(Object.entries(en))
let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
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
    vi.restoreAllMocks()
  }
})

function props(path = 'asset.png', data: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]),
  instance = createZoomStore().create(), controller = new AbortController()): ImageBodyProps {
  const subscribe = (listener: () => void) => instance.subscribe(listener)
  const snapshot = () => instance.getSnapshot()
  function useStore<T>(selector: (state: ZoomState) => T): T {
    return selector(useSyncExternalStore(subscribe, snapshot))
  }
  return {
    resourceAddress: `dsh-resource://file/session/image/${path}`,
    content: { kind: 'bytes', data },
    wrap: false,
    sessionId: 'image' as SessionId,
    useTabInfo: () => ({ tab: { id: 'image-tab' as TabId, signal: controller.signal } }),
    useResource: () => ({ value: undefined }),
    useStore,
    actions: instance.actions,
    retainTab: vi.fn(),
    scrollportRef: vi.fn(),
    t: (key, params) => {
      const value = translations.get(key) ?? key
      return params === undefined ? value : Object.entries(params)
        .reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), value)
    },
  } as ImageBodyProps
}

describe('ImageBody', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
    ['ico', 'image/x-icon'],
    ['svg', 'image/svg+xml'],
  ] as const)('assigns .%s bytes the %s Blob media type', async (extension, mediaType) => {
    const view = render(<ImageBody {...props(`asset.${extension}`)} />)
    const image = await screen.findByRole('img', { hidden: true })
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    expect(image.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 10 })
    fireEvent.load(image)
    expect(screen.getByRole('toolbar', { name: 'Zoom controls' })).toBeTruthy()
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('keeps the image non-draggable, then shows it after decoding succeeds', async () => {
    render(<ImageBody {...props('photo.svg')} />)
    const image = await screen.findByRole('img', { hidden: true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 50 })
    expect(image.getAttribute('alt')).toBe('Image preview: photo.svg')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.getAttribute('draggable')).toBe('false')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.parentElement?.hasAttribute('hidden')).toBe(true)
    fireEvent.load(image)
    expect(image.parentElement?.hasAttribute('hidden')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('100%')
  })

  it('revokes replaced bytes and reports image decode and Blob creation failures', async () => {
    const initial = props()
    const view = render(<ImageBody {...initial} />)
    const first = await screen.findByRole('img', { hidden: true })
    fireEvent.error(first)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    const changed = props('asset.png', new Uint8Array([4, 5, 6]))
    view.rerender(<ImageBody {...changed} />)
    await screen.findByRole('img', { hidden: true })
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
    create.mockImplementationOnce(() => { throw new Error('Blob unavailable') })
    view.rerender(<ImageBody {...props('changed.png', new Uint8Array([7]))} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/2')
  })

  it('rejects text delivery and an unregistered suffix without creating a Blob', () => {
    const initial = props()
    const view = render(<ImageBody {...initial} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<ImageBody {...props('asset.unknown')} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(imageMediaType('folder/PHOTO.JPEG')).toBe('image/jpeg')
    expect(imageMediaType('folder/no-extension')).toBeUndefined()
    expect(imageMediaType('folder/photo.avif')).toBeUndefined()
  })

  it('retains image zoom without recreating the image or Blob URL', async () => {
    const instance = createZoomStore().create()
    const initial = props('diagram.svg', new Uint8Array([4, 5, 6]), instance)
    const view = render(<ImageBody {...initial} />)
    const image = await screen.findByRole('img', { hidden: true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 200 })
    fireEvent.load(image)
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('38%')
    fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '150%' }))
    expect(instance.getSnapshot().byTab['image-tab' as TabId]).toEqual({ kind: 'fixed', scale: 1.5 })
    expect(screen.getByRole('img')).toBe(image)
    expect(create).toHaveBeenCalledOnce()
    view.rerender(<ImageBody {...props('diagram.svg', initial.content.kind === 'bytes' ? initial.content.data : new Uint8Array(), instance)} />)
    expect(screen.getByRole('img')).toBe(image)
    expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('150%')
    fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
    expect(instance.getSnapshot().byTab['image-tab' as TabId]).toEqual({ kind: 'fit-width' })
  })
})
