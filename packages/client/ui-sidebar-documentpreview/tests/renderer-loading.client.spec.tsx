// @vitest-environment jsdom
/** Renderer-owned loads retain displayed versions and retire work on reload, replacement, and close. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficeToPdfGeneration } from '@deepseek-ai/dsh-office-to-pdf/types'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import type { DocumentContent } from '../src/client/document/contract.ts'
import { TextPreview, type TextPreviewProps } from '../src/client/TextPreview.tsx'
import { OfficeFontAction, type OfficeFontActionProps } from '../src/client/office/OfficeFontAction.tsx'
import { OfficeBody, type OfficeBodyProps } from '../src/client/office/OfficeBody.tsx'
import { officeFace } from '../src/client/office/face.ts'
import { createOfficeStore, type OfficeState } from '../src/client/office/store.ts'
import type { ReadOfficeDocument } from '../src/client/office/cache.ts'
import { en } from '../src/client/office/locales.ts'
import { harness, ABSOLUTE_PATH, ADDRESS, TAB_ID, SESSION, settle } from './fixtures.client.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('lets a non-Office renderer load content, report its version, and reload through the shared toolbar', async () => {
  const h = harness()
  const custom: DocumentPreviewDefinition = {
    id: 'custom-viewer', extensions: ['md'], binaryExtensions: ['md'], title: () => 'Custom', loading: 'renderer',
  }
  const read = vi.fn<(signal: AbortSignal) => Promise<{ text: string; version: string }>>()
    .mockResolvedValueOnce({ text: 'Custom content v1', version: 'v1' })
    .mockResolvedValueOnce({ text: 'Custom content v2', version: 'v2' })
  function CustomBody({ content }: { content: DocumentContent }) {
    const [file, setFile] = useState<{ text: string; version: string; revision: number }>()
    const request = content.kind === 'renderer' ? content : undefined
    const revision = request?.revision
    const displayed = file?.revision === revision ? file : undefined
    useEffect(() => {
      if (revision === undefined) return
      const controller = new AbortController()
      void read(controller.signal).then((file) => {
        if (controller.signal.aborted) return
        setFile({ ...file, revision })
      })
      return () => { controller.abort() }
    }, [revision])
    useEffect(() => { if (displayed !== undefined) request?.loaded(displayed.version) }, [displayed, request?.loaded])
    return <p>{displayed?.text ?? 'Loading custom content'}</p>
  }
  const renderSlot: TextPreviewProps['renderSlot'] = (name: string, input: unknown) => {
    if (name !== 'sidebar.right.tab.document') return null
    const owner = input as OwnerOf<'sidebar.right.tab.document'>
    return <CustomBody content={owner.content} />
  }
  const useDocumentPreviews: TextPreviewProps['useDocumentPreviews'] = selector => selector([custom])
  const view = render(<TextPreview {...h.props()} renderSlot={renderSlot} useDocumentPreviews={useDocumentPreviews} />)
  expect(read).toHaveBeenCalledTimes(1)
  expect(await screen.findByText('Custom content v1')).toBeTruthy()
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v1')
  act(() => { h.instance.actions.toggledAutoRefresh(TAB_ID) })
  h.setVersion('v2')
  view.rerender(<TextPreview {...h.props()} renderSlot={renderSlot} useDocumentPreviews={useDocumentPreviews} />)
  expect(screen.getByText('changed')).toBeTruthy()
  expect(read).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'reloadNow' }))
  expect(await screen.findByText('Custom content v2')).toBeTruthy()
  expect(read).toHaveBeenCalledTimes(2)
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v2')
  expect(screen.queryByText('changed')).toBeNull()
  expect(h.read).not.toHaveBeenCalled()
  expect(h.bytes).not.toHaveBeenCalled()
  expect(h.instance.getSnapshot().byTab[TAB_ID]?.complete).toBeUndefined()
})

const definition: DocumentPreviewDefinition = {
  id: 'office', extensions: ['md'], binaryExtensions: ['md'], title: () => 'Office', loading: 'renderer',
}
type Result = Awaited<ReturnType<ReadOfficeDocument>>
const result = (version = 'v1', missingFonts: readonly string[] = []): Result => ({ ok: true, value: {
  absolutePath: ABSOLUTE_PATH, version, data: new TextEncoder().encode(`PDF ${version}`),
  offset: 0, eof: true, missingFonts, generation: 'engine' as OfficeToPdfGeneration,
} })

function setup() {
  const h = harness()
  const office = createOfficeStore().create()
  const pending: { signal: AbortSignal; deferred: ReturnType<typeof Promise.withResolvers<Result>> }[] = []
  const read = vi.fn<ReadOfficeDocument>().mockImplementation((_file, signal) => {
    const deferred = Promise.withResolvers<Result>()
    pending.push({ signal, deferred })
    return deferred.promise
  })
  const retained = new Set<AbortSignal>()
  const retainTab: OfficeBodyProps['retainTab'] = (tab, signal) => {
    if (retained.has(signal)) return
    retained.add(signal)
    signal.addEventListener('abort', () => { office.actions.forget(tab) }, { once: true })
  }
  const subscribe = (listener: () => void) => office.subscribe(listener)
  const snapshot = () => office.getSnapshot()
  function useOffice<T>(selector: (state: OfficeState) => T): T {
    return selector(useSyncExternalStore(subscribe, snapshot))
  }
  const injected = officeFace(read, error => error.message)(SESSION, office.actions)
  let request: Extract<DocumentContent, { kind: 'renderer' }> | undefined
  const slots: TextPreviewProps['renderSlot'] = (key: string, input: unknown, options?: { hookContext?: unknown }) => {
    if (key === 'sidebar.right.tab.document.action') {
      return <OfficeFontAction {...{ ...input as OwnerOf<'sidebar.right.tab.document.action'>, useTabInfo: options?.hookContext, useStore: useOffice,
        actions: office.actions, t: makeTranslate(en) } as OfficeFontActionProps} />
    }
    if (key !== 'sidebar.right.tab.document') return null
    const owner = input as OwnerOf<'sidebar.right.tab.document'>
    if (owner.content.kind !== 'renderer') return <p>Raw bytes</p>
    request = owner.content
    // The component fixture supplies the standard seats used by Office; the real slot binding is exercised by the browser scenario.
    const props = { ...h.props(), ...owner, useTabInfo: options?.hookContext, useStore: useOffice,
      actions: office.actions, ...injected, retainTab,
      t: makeTranslate(en), renderSlot: (_name: string, child: { content: DocumentContent }) => (
        <p data-test-pdf>{child.content.kind === 'bytes' ? new TextDecoder().decode(child.content.data) : ''}</p>
      ),
    } as OfficeBodyProps
    return <OfficeBody {...props} />
  }
  function View({ renderer = true, implementation = definition.id }: { renderer?: boolean; implementation?: string }) {
    return <TextPreview {...h.props()} renderSlot={slots}
      useDocumentPreviews={selector => selector([renderer ? { ...definition, id: implementation } : { ...definition, id: 'raw', loading: 'bytes-complete' }])} />
  }
  onTestFinished(async () => {
    h.controller.abort()
    for (const { deferred } of pending) deferred.resolve(result())
    await Promise.allSettled(pending.map(item => item.deferred.promise))
  })
  return { h, office, pending, read, View, request: () => request! }
}

it('retains renderer content across remounts and waits for reload when automatic refresh is paused', async () => {
  const h = setup()
  let mounted = render(<h.View />)
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
  expect(h.h.bytes).not.toHaveBeenCalled()
  await act(async () => { h.pending[0]!.deferred.resolve(result()) })
  expect(screen.getByText('PDF v1')).toBeTruthy()
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v1')
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.complete).toBeUndefined()
  mounted.unmount()
  mounted = render(<h.View />)
  expect(screen.getByText('PDF v1')).toBeTruthy()
  expect(h.read).toHaveBeenCalledTimes(1)
  act(() => { h.h.instance.actions.toggledAutoRefresh(TAB_ID) })
  h.h.setVersion('v2')
  mounted.rerender(<h.View />)
  expect(screen.getByText('changed')).toBeTruthy()
  expect(h.read).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'reloadNow' }))
  expect(h.read).toHaveBeenCalledTimes(2)
  await act(async () => { h.pending[1]!.deferred.resolve(result('v2')) })
  expect(screen.queryByText('changed')).toBeNull()
  expect(screen.getByText('PDF v2')).toBeTruthy()
})

it('aborts a superseded load and rejects its late bytes and version report', async () => {
  const h = setup()
  render(<h.View />)
  const previous = h.request()
  fireEvent.click(screen.getByRole('button', { name: 'reload' }))
  expect(h.pending[0]!.signal.aborted).toBe(true)
  act(() => { previous.failed() })
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.loading).toBe(true)
  await act(async () => { h.pending[1]!.deferred.resolve(result('v2')) })
  await act(async () => { h.pending[0]!.deferred.resolve(result('v1')); previous.loaded('v1') })
  expect(screen.getByText('PDF v2')).toBeTruthy()
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v2')
})

it.each(['declared', 'exception'] as const)('automatically retries a %s conversion failure only after another file change', async (kind) => {
  const h = setup()
  render(<h.View />)
  await act(async () => {
    if (kind === 'declared') h.pending[0]!.deferred.resolve({
      ok: false, error: new RemoteError('document-render/failed', 'Conversion failed', { reason: 'failed' }),
    })
    else h.pending[0]!.deferred.reject(new Error('Conversion failed'))
  })
  expect(screen.getByText('Conversion failed')).toBeTruthy()
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.loading).toBe(false)
  expect(h.read).toHaveBeenCalledTimes(1)
  act(() => {
    h.h.setVersion('v2')
    h.h.instance.actions.resourceChanged(TAB_ID)
  })
  expect(h.read).toHaveBeenCalledTimes(2)
  await act(async () => { h.pending[1]!.deferred.resolve(result('v2')) })
  expect(screen.getByText('PDF v2')).toBeTruthy()
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.loading).toBe(false)
})

it.each(['replace', 'close', 'hide'] as const)('retires pending conversion on %s and ignores a late rejection', async (transition) => {
  const h = setup()
  h.h.bytes.mockResolvedValue({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, eof: true, data: new Uint8Array() } })
  const mounted = render(<h.View />)
  const previous = h.request()
  if (transition === 'replace') mounted.rerender(<h.View renderer={false} />)
  else if (transition === 'close') act(() => { h.h.controller.abort() })
  else mounted.unmount()
  if (transition !== 'hide') act(() => { previous.failed() })
  expect(h.pending[0]!.signal.aborted).toBe(true)
  await act(async () => { h.pending[0]!.deferred.reject(new Error('late error')) })
  if (transition === 'close') {
    expect(h.office.getSnapshot().byTab[TAB_ID]).toBeUndefined()
    expect(h.h.instance.getSnapshot().byTab[TAB_ID]).toBeUndefined()
  } else expect(h.office.getSnapshot().byTab[TAB_ID]?.failure).toBeUndefined()
  if (transition === 'replace') {
    await settle()
    expect(screen.getByText('Raw bytes')).toBeTruthy()
  }
})

it.each(['declared', 'exception', 'foreign'] as const)('shows %s conversion failures and retries only while the resource is available', async (kind) => {
  const h = setup()
  const mounted = render(<h.View />)
  await act(async () => {
    if (kind === 'declared') h.pending[0]!.deferred.resolve({ ok: false, error: new RemoteError('workspace-file/not-found', 'Missing file', { path: ABSOLUTE_PATH }) })
    else h.pending[0]!.deferred.reject(kind === 'exception' ? new Error('Conversion failed') : 'Conversion failed')
  })
  expect(screen.getByText(kind === 'declared' ? 'Missing file' : 'Conversion failed')).toBeTruthy()
  const resource = h.h.useResource()
  h.h.useResource.mockReturnValue({ status: 'none', value: undefined, failure: undefined })
  mounted.rerender(<h.View />)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(h.read).toHaveBeenCalledTimes(1)
  expect(screen.getByText(kind === 'declared' ? 'Missing file' : 'Conversion failed')).toBeTruthy()
  h.h.useResource.mockReturnValue(resource)
  mounted.rerender(<h.View />)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(h.read).toHaveBeenCalledTimes(2)
  await act(async () => { h.pending[1]!.deferred.resolve(result()) })
  expect(screen.getByText('PDF v1')).toBeTruthy()
  expect(h.h.bytes).not.toHaveBeenCalled()
})

it('starts no conversion when a body receives ordinary shared content', () => {
  const h = setup()
  const props = { ...h.h.props(), content: { kind: 'bytes', data: new Uint8Array() },
    resourceAddress: ADDRESS, wrap: false, scrollportRef: vi.fn(),
    addResource: vi.fn(), setResources: vi.fn(),
    useStore: () => undefined, actions: h.office.actions, load: vi.fn(), retainTab: vi.fn(), t: makeTranslate(en),
  } as OfficeBodyProps
  const view = render(<OfficeBody {...props} />)
  expect(view.container.childElementCount).toBe(0)
  expect(h.read).not.toHaveBeenCalled()
})

it('shows the current revision’s missing fonts in the toolbar and clears stale details during reload', async () => {
  const h = setup()
  const view = render(<h.View />)
  expect(screen.queryByRole('button', { name: /Missing fonts:/ })).toBeNull()
  await act(async () => { h.pending[0]!.deferred.resolve(result('v1', ['Missing Serif'])) })
  const warning = screen.getByRole('button', { name: 'Missing fonts: 1. Click to view.' })
  fireEvent.click(warning)
  expect(screen.getByRole('dialog').textContent).toContain('Missing Serif')
  fireEvent.click(screen.getByRole('button', { name: 'reload' }))
  expect(screen.queryByRole('button', { name: /Missing fonts:/ })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { h.pending[1]!.deferred.resolve(result('v2', ['Missing Sans'])) })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Missing fonts: 1. Click to view.' }))
  expect(screen.getByRole('dialog').textContent).toContain('Missing Sans')
  expect(screen.getByRole('dialog').textContent).not.toContain('Missing Serif')
  h.h.bytes.mockResolvedValue({ ok: true, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, eof: true, data: new Uint8Array() } })
  view.rerender(<h.View renderer={false} />)
  await settle()
  expect(screen.queryByRole('button', { name: /Missing fonts:/ })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('isolates a replacement implementation with the same renderer-owned loading mode', async () => {
  const h = setup()
  const view = render(<h.View />)
  const previous = h.request()
  view.rerender(<h.View implementation="alternative" />)
  expect(h.pending[0]!.signal.aborted).toBe(true)
  expect(h.pending).toHaveLength(2)
  await act(async () => { h.pending[1]!.deferred.resolve(result('v2')) })
  await act(async () => { h.pending[0]!.deferred.resolve(result('v1')); previous.loaded('v1') })
  expect(screen.getByText('PDF v2')).toBeTruthy()
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.contentRendererId).toBe('alternative')
  expect(h.h.instance.getSnapshot().byTab[TAB_ID]?.version).toBe('v2')
})

it('starts no conversion or store write for an already closed request', () => {
  const read = vi.fn<ReadOfficeDocument>()
  const store = createOfficeStore().create()
  const face = officeFace(read, error => error.message)(SESSION, store.actions)
  const controller = new AbortController()
  controller.abort()
  const loaded = vi.fn()
  const failed = vi.fn()
  face.load(TAB_ID, 1, { sessionId: SESSION, path: ABSOLUTE_PATH }, controller.signal, loaded, failed)
  expect(read).not.toHaveBeenCalled()
  expect(loaded).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
  expect(store.getSnapshot().byTab[TAB_ID]).toBeUndefined()
})

it('keeps a pending conversion when metadata changes while automatic refresh is paused', async () => {
  const h = setup()
  const view = render(<h.View />)
  act(() => { h.h.instance.actions.toggledAutoRefresh(TAB_ID) })
  h.h.setVersion('v2')
  view.rerender(<h.View />)
  expect(h.read).toHaveBeenCalledTimes(1)
  expect(h.pending[0]!.signal.aborted).toBe(false)
  await act(async () => { h.pending[0]!.deferred.resolve(result('v1')) })
  expect(screen.getByText('PDF v1')).toBeTruthy()
  expect(screen.getByText('changed')).toBeTruthy()
})
