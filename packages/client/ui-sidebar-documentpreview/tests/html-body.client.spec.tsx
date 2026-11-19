// @vitest-environment jsdom
/** HTML iframe ownership follows file identity and bytes, not locale or wrapping changes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { DeveloperToolsPreference } from '@deepseek-ai/dsh-client-ui-settings/src/client/developer-tools.ts'
import type { DeveloperToolsSettings } from '@deepseek-ai/dsh-client-ui-settings/src/developer-tools-settings.ts'
import type { Resources, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TextPreview } from '../src/client/TextPreview.tsx'
import type { DocumentBodyOwner } from '../src/client/document/contract.ts'
import { textFace } from '../src/client/face.ts'
import { HtmlBody } from '../src/client/html/HtmlBody.tsx'
import type { HtmlBodyProps } from '../src/client/html/HtmlBody.tsx'
import { htmlBodyDefinition } from '../src/client/html/index.ts'
import { en } from '../src/client/html/locales.ts'
import { ADDRESS, ABSOLUTE_PATH, SESSION, TAB_ID, documentSlots, harness } from './fixtures.client.ts'

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
    useInteractivePreview: select => select(true),
    resourceAddress: 'dsh-resource://file/session/html/index.html',
    content: { kind: 'bytes', data: utf8(text) },
    wrap: false,
    sessionId: 'html' as SessionId,
    useTabInfo: () => ({ tab: { id: TAB_ID, signal } }),
    readRelated: vi.fn(),
    addResource: vi.fn(),
    setResources: vi.fn(),
    useResource: () => ({ value: undefined }),
    t: key => translations.get(key) ?? key,
  } as HtmlBodyProps
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('HtmlBody', () => {
  it.each(['css', 'js'] as const)('reloads the HTML when only its %s resource changes', async (extension) => {
    const h = harness()
    const previewProps = h.props()
    const htmlProps = props()
    const metadata = (version: string): ResourceSnapshot<WorkspaceFileStat> => ({
      status: 'live', value: { absolutePath: ABSOLUTE_PATH, version }, failure: undefined,
    })
    const root = createSnapshotStore(metadata('root-v1'))
    const dependency = createSnapshotStore(metadata('asset-v1'))
    const release = vi.fn()
    const dependencySource = {
      getSnapshot: () => dependency.getSnapshot(),
      subscribe: (listener: () => void) => {
        const off = dependency.subscribe(listener)
        return () => { off(); release() }
      },
    }
    const resources: Resources = {
      source: address => address === ADDRESS ? root : dependencySource,
      register: () => () => {}, pin: () => {},
    }
    const face = textFace(h.read, h.bytes, resources)(SESSION, h.instance.actions)
    const data = utf8(extension === 'css'
      ? '<link rel="stylesheet" href="./asset.css"><p>HTML content</p>'
      : '<p>HTML content</p><script src="./asset.js"></script>')
    h.bytes.mockResolvedValue({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'root-v1', data, offset: 0, eof: true } })
    const readRelated = vi.fn<HtmlBodyProps['readRelated']>().mockResolvedValue({ ok: true, value: {
      absolutePath: `/workspace/asset.${extension}`, version: 'asset-v1', offset: 0, eof: true,
      data: utf8(extension === 'css' ? 'body { color: red }' : 'window.loaded = true'),
    } })
    const definition = { ...htmlBodyDefinition(() => 'HTML'), extensions: ['md'] }
    let interactive = true
    const preview = () => <TextPreview {...previewProps} {...face}
      useDocumentPreviews={select => select([definition])}
      renderSlot={documentSlots((_key, owner) => <HtmlBody {...htmlProps} {...owner as unknown as DocumentBodyOwner}
        useTabInfo={previewProps.useTabInfo} useInteractivePreview={select => select(interactive)} readRelated={readRelated} />)} />
    const view = render(preview())
    await waitFor(() => {
      expect(screen.getByTitle(en.frame)).toBeDefined()
      expect(h.instance.getSnapshot().byTab[TAB_ID]).toMatchObject({ loading: false, resourcesDirty: false })
    })
    const previous = screen.getByTitle(en.frame)
    const reads = h.bytes.mock.calls.length
    const relatedReads = readRelated.mock.calls.length
    expect(reads).toBe(1)
    expect(relatedReads).toBe(1)
    expect(create).toHaveBeenCalledOnce()
    readRelated.mockResolvedValueOnce({ ok: true, value: {
      absolutePath: `/workspace/asset.${extension}`, version: 'asset-v2', offset: 0, eof: true,
      data: utf8(extension === 'css' ? 'body { color: blue }' : 'window.loaded = false'),
    } })
    act(() => { dependency.set(metadata('asset-v2')) })
    await waitFor(() => { expect(screen.getByTitle(en.frame)).not.toBe(previous) })
    expect(h.bytes).toHaveBeenCalledTimes(reads + 1)
    expect(readRelated).toHaveBeenCalledTimes(relatedReads + 1)
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('root-v1')
    expect(h.read).not.toHaveBeenCalled()
    interactive = false
    view.rerender(preview())
    const staticFrame = screen.getByTitle(en.frame)
    expect(staticFrame.getAttribute('sandbox')).toBe('')
    expect(release).toHaveBeenCalledOnce()
    act(() => { dependency.set(metadata('asset-v3')) })
    expect(screen.getByTitle(en.frame)).toBe(staticFrame)
    expect(h.bytes).toHaveBeenCalledTimes(reads + 1)
    expect(readRelated).toHaveBeenCalledTimes(relatedReads + 1)
    act(() => { root.set(metadata('root-v2')) })
    await waitFor(() => { expect(h.bytes).toHaveBeenCalledTimes(reads + 2) })
    expect(readRelated).toHaveBeenCalledTimes(relatedReads + 1)
    view.unmount()
  })

  it('renders static HTML without reading related files, running scripts or retaining an advanced frame', async () => {
    const initial = props('<h1>Preview</h1><script src="./script.js"></script><p>Static content</p>')
    const basic = { ...initial, useInteractivePreview: ((select: (enabled: boolean) => unknown) => select(false)) as HtmlBodyProps['useInteractivePreview'] }
    const view = render(<HtmlBody {...basic} />)
    const frame = screen.getByTitle(en.frame)
    expect(frame.getAttribute('name')).toBe(`dsh-sidebar-html-${TAB_ID}`)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(frame.getAttribute('srcdoc')).not.toContain('<script')
    expect(initial.readRelated).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    const scripted = props('<p>Advanced</p><script>window.ready=true</script>')
    view.rerender(<HtmlBody {...scripted} />)
    const advanced = await screen.findByTitle(en.frame)
    expect(advanced).not.toBe(frame)
    expect(advanced.getAttribute('name')).toBe(`dsh-sidebar-html-${TAB_ID}`)
    expect(advanced.getAttribute('sandbox')).toBe('allow-scripts')
    view.rerender(<HtmlBody {...basic} />)
    expect(advanced.isConnected).toBe(false)
    expect(revoke).toHaveBeenCalledOnce()
    view.rerender(<HtmlBody {...basic} content={{ kind: 'bytes', data: new Uint8Array([255]) }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
  })

  it('follows the shared developer-tools preference from loading through a stored false to enabled', async () => {
    const host = stubConfigForm<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    const readRelated = vi.fn<HtmlBodyProps['readRelated']>().mockResolvedValue({ ok: true, value: {
      absolutePath: '/workspace/asset.js', version: 'asset-v1', offset: 0, eof: true,
      data: utf8('window.loaded = true'),
    } })
    const scripted: HtmlBodyProps = {
      ...props('<p>Preview</p><script src="./asset.js"></script>'),
      useInteractivePreview: bindSnapshotSelector(preference.enabled),
      readRelated,
    }
    const view = render(<HtmlBody {...scripted} />)
    expect(screen.getByTitle(en.frame).getAttribute('sandbox')).toBe('')
    expect(readRelated).not.toHaveBeenCalled()
    act(() => { host.publish({ status: 'ready', value: { enabled: false } }) })
    expect(screen.getByTitle(en.frame).getAttribute('sandbox')).toBe('')
    expect(readRelated).not.toHaveBeenCalled()
    act(() => { host.publish({ value: { enabled: true } }) })
    const advanced = await screen.findByTitle(en.frame)
    expect(advanced.getAttribute('sandbox')).toBe('allow-scripts')
    expect(readRelated).toHaveBeenCalledOnce()
    view.unmount()
  })

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
      value: { absolutePath: '/workspace/app.js', data: utf8('window.ready=true'), version: 'v1', offset: 0, eof: true },
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
      value: { absolutePath: '/workspace/app.js', version: 'v1', bytes: 16, offset: 0, data: utf8('window.ready=1'), eof: true },
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
