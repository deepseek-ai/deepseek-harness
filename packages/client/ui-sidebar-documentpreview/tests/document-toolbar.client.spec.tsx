// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { TextPreview } from '../src/client/TextPreview.tsx'
import type { TextPreviewProps } from '../src/client/TextPreview.tsx'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { CodeBody } from '../src/client/code/CodeBody.tsx'
import { PLAIN_BODY_ID } from '../src/client/text/index.ts'
import { ABSOLUTE_PATH, FILE, harness, page, settle, TAB_ID } from './fixtures.client.ts'

afterEach(cleanup)

const binary: DocumentPreviewDefinition = {
  id: 'complete-document', extensions: ['md'], title: () => 'Complete document', loading: 'bytes-complete',
}

function codeProps(h: ReturnType<typeof harness>): TextPreviewProps {
  const props = h.props()
  const definition: DocumentPreviewDefinition = {
    id: 'code', extensions: ['md'], title: () => 'Code', loading: 'text-pages', wrap: true,
  }
  return {
    ...props,
    useDocumentPreviews: selector => selector([definition]),
    // This adapter only receives the concrete document slot, not an arbitrary generic key.
    renderSlot: (_key, owner) => <CodeBody {...props} {...owner as unknown as OwnerOf<'sidebar.right.tab.document'>} t={key => key} />,
  }
}

describe('document toolbar', () => {
  it('keeps Reading above the first code page and reload, retaining code during pagination', async () => {
    const h = harness()
    const first = Promise.withResolvers<Awaited<ReturnType<typeof h.read>>>()
    const next = Promise.withResolvers<Awaited<ReturnType<typeof h.read>>>()
    const reload = Promise.withResolvers<Awaited<ReturnType<typeof h.read>>>()
    onTestFinished(async () => {
      h.controller.abort()
      for (const pending of [first, next, reload]) pending.resolve(page(1, [], true))
      await Promise.all([first.promise, next.promise, reload.promise])
    })
    h.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise).mockReturnValueOnce(reload.promise)
    const view = render(<TextPreview {...codeProps(h)} />)
    const body = view.container.querySelector('[data-textpreview-body]')
    expect(view.container.querySelector('[data-code-preview]')).toBeNull()
    expect(body?.firstElementChild).toBe(view.getByRole('status'))
    expect(view.getByRole('status').getAttribute('aria-label')).toBe('loading')
    expect(view.getByRole('status').textContent).toBe('')
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()

    await act(async () => { first.resolve(page(1, ['const prefix = 1;'], false)); await first.promise })
    const renderer = view.container.querySelector('[data-code-preview]')
    expect(renderer).not.toBeNull()
    expect(renderer?.querySelector('pre')?.textContent).toBe('const prefix = 1;')
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'loadMore' }))
    expect(view.container.querySelector('[data-code-preview]')).toBe(renderer)
    expect(renderer?.querySelector('pre')?.textContent).toBe('const prefix = 1;')
    expect(view.getByRole('status').closest('[data-textpreview-more]')).not.toBeNull()
    await act(async () => { next.resolve(page(2, ['const tail = 2;'], true)); await next.promise })
    expect(view.container.querySelector('[data-code-preview]')).toBe(renderer)
    expect(renderer?.querySelector('pre')?.textContent).toBe('const prefix = 1;\nconst tail = 2;')
    expect(view.queryByRole('status')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'reload' }))
    expect(view.container.querySelector('[data-code-preview]')).toBeNull()
    expect(renderer?.isConnected).toBe(false)
    expect(body?.firstElementChild).toBe(view.getByRole('status'))
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
    await act(async () => { reload.resolve(page(1, ['const refreshed = 3;'], true, 'v2')); await reload.promise })
    expect(view.container.querySelector('[data-code-preview] pre')?.textContent).toBe('const refreshed = 3;')
    expect(view.queryByRole('status')).toBeNull()
  })

  it('mounts the code renderer after an empty file page completes', async () => {
    const h = harness()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.read>>>()
    onTestFinished(async () => {
      h.controller.abort()
      pending.resolve(page(1, [], true))
      await pending.promise
    })
    h.read.mockReturnValueOnce(pending.promise)
    const view = render(<TextPreview {...codeProps(h)} />)
    expect(view.container.querySelector('[data-code-preview]')).toBeNull()
    expect(view.getByRole('status').getAttribute('aria-label')).toBe('loading')
    await act(async () => { pending.resolve(page(1, [], true)); await pending.promise })
    expect(view.container.querySelector('[data-code-preview]')).not.toBeNull()
    expect(view.container.querySelector('[data-code-preview] pre')?.textContent).toBe('')
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.pages).toEqual({ 1: { text: '', lines: 0 } })
    expect(view.queryByRole('status')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-more]')).toBeNull()
  })

  it('shows the shared loading indicator until a complete read settles', async () => {
    const h = harness()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof h.bytes>>>()
    const result = { ok: true as const, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, data: btoa('all'), bytes: 3, eof: true } }
    onTestFinished(async () => {
      h.controller.abort()
      pending.resolve(result)
      await pending.promise
    })
    h.bytes.mockReturnValueOnce(pending.promise)
    const renderSlot = vi.fn(() => null)
    const props: TextPreviewProps = { ...h.props(), useDocumentPreviews: selector => selector([binary]), renderSlot }
    const view = render(<TextPreview {...props} />)
    expect(view.getByRole('status').hasAttribute('data-document-loading')).toBe(true)
    expect(view.getByRole('status').getAttribute('aria-label')).toBe('loading')
    expect(view.container.querySelector('[data-textpreview-body]')?.firstElementChild).toBe(view.getByRole('status'))
    expect(renderSlot).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve(result)
      await pending.promise
    })
    expect(renderSlot).toHaveBeenCalled()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('retries and refreshes complete content and uses the read result path before metadata arrives', async () => {
    const h = harness()
    const result = { ok: true as const, value: { absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, data: btoa('all'), bytes: 3, eof: true } }
    const read = h.bytes.mockResolvedValueOnce({
      ok: false, error: new RemoteError('workspace-file/not-found', 'Missing file', { path: ABSOLUTE_PATH }),
    }).mockResolvedValue(result)
    h.useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
    const props: TextPreviewProps = {
      ...h.props(), useDocumentPreviews: selector => selector([binary]),
    }
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-textpreview-retry]')!)
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-textpreview-path]')?.textContent).toBe(ABSOLUTE_PATH)
    expect(view.container.querySelector('[data-textpreview-tool="wrap"]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-failed]')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="reload"]')!)
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenLastCalledWith(FILE, h.controller.signal)
    h.controller.abort()
  })

  it('keeps displayed content but does not request reads while the provider is absent', async () => {
    const h = harness({ 1: page(1, ['held'], false) })
    const view = render(<TextPreview {...h.props()} />)
    await settle()
    h.useResource.mockReturnValue({ status: 'none', value: undefined, failure: undefined })
    view.rerender(<TextPreview {...h.props()} />)
    fireEvent.click(view.container.querySelector('[data-textpreview-more]')!)
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="reload"]')!)
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toContain('held')
    h.controller.abort()
  })

  it('drops the plain-text fallback for a declared binary suffix and hides the viewer control entirely', async () => {
    const h = harness()
    h.bytes.mockResolvedValue({ ok: true, value: { absolutePath: '/host/project/work/photo.png', version: 'v1', offset: 0, data: btoa('x'), bytes: 1, eof: true } })
    const image: DocumentPreviewDefinition = {
      id: 'image', extensions: ['png', 'svg'], binaryExtensions: ['png'], title: () => 'Image', loading: 'bytes-complete',
    }
    const plain: DocumentPreviewDefinition = {
      id: PLAIN_BODY_ID, extensions: [], title: () => 'viewer.text', loading: 'text-pages', wrap: true,
    }
    const base = h.props()
    const info = base.useTabInfo()
    const address = 'dsh-resource://file/session/s-1/work/photo.png'
    const props: TextPreviewProps = {
      ...base,
      useTabInfo: () => ({ ...info, tab: { ...info.tab, contentId: address, navigation: { ...info.tab.navigation, address } } }),
      useDocumentPreviews: selector => selector([image, plain]),
      renderSlot: vi.fn(() => null),
    } as TextPreviewProps
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(view.container.querySelector('[data-document-viewer-menu]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="reload"]')).not.toBeNull()
    h.controller.abort()
  })

  it('keeps the plain-text fallback in the picker for a non-binary suffix of the same viewer', async () => {
    const h = harness()
    h.bytes.mockResolvedValue({ ok: true, value: { absolutePath: '/host/project/work/logo.svg', version: 'v1', offset: 0, data: btoa('<svg/>'), bytes: 6, eof: true } })
    const image: DocumentPreviewDefinition = {
      id: 'image', extensions: ['png', 'svg'], binaryExtensions: ['png'], title: () => 'Image', loading: 'bytes-complete',
    }
    const plain: DocumentPreviewDefinition = {
      id: PLAIN_BODY_ID, extensions: [], title: () => 'viewer.text', loading: 'text-pages', wrap: true,
    }
    const base = h.props()
    const info = base.useTabInfo()
    const address = 'dsh-resource://file/session/s-1/work/logo.svg'
    const props: TextPreviewProps = {
      ...base,
      useTabInfo: () => ({ ...info, tab: { ...info.tab, contentId: address, navigation: { ...info.tab.navigation, address } } }),
      useDocumentPreviews: selector => selector([image, plain]),
      renderSlot: vi.fn(() => null),
    } as TextPreviewProps
    const view = render(<TextPreview {...props} />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-document-viewer-menu]')!)
    expect(screen.getByRole('menuitem', { name: 'Image' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'viewer.text' })).toBeDefined()
    h.controller.abort()
  })

  it('dismisses the implementation picker with Escape without changing the selected implementation', async () => {
    const h = harness({ 1: page(1, ['held'], true) })
    const base = h.props()
    const code: DocumentPreviewDefinition = {
      id: 'code', extensions: ['md'], title: () => 'Code', loading: 'text-pages', wrap: true,
    }
    const plain: DocumentPreviewDefinition = {
      id: PLAIN_BODY_ID, extensions: [], title: () => 'viewer.text', loading: 'text-pages', wrap: true,
    }
    const props: TextPreviewProps = { ...base, useDocumentPreviews: selector => selector([code, plain]) }
    const view = render(<TextPreview {...props} />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-document-viewer-menu]')!)
    expect(screen.getByRole('menuitem', { name: 'viewer.text' })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(h.instance.getSnapshot().byTab[TAB_ID]?.rendererId).toBeUndefined()
    h.controller.abort()
  })

  it('shows the unsupported empty state for a known binary suffix with no renderer, reading nothing', async () => {
    const h = harness()
    const base = h.props()
    const info = base.useTabInfo()
    const address = 'dsh-resource://file/session/s-1/work/clip.mp4'
    const props: TextPreviewProps = {
      ...base,
      useTabInfo: () => ({ ...info, tab: { ...info.tab, contentId: address, navigation: { ...info.tab.navigation, address } } }),
    }
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-state="unsupported"]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-unsupported]')?.textContent).toContain('unsupportedFile')
    expect(view.container.querySelector('[data-textpreview-path]')).not.toBeNull()
    expect(view.container.querySelector('[data-document-viewer-menu]')).toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="reload"]')).toBeNull()
    expect(h.read).not.toHaveBeenCalled()
    expect(h.bytes).not.toHaveBeenCalled()
    h.controller.abort()
  })

  it('keeps the plain-text fallback for an unlisted unknown suffix', async () => {
    const h = harness({ 1: page(1, ['plain line'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const address = 'dsh-resource://file/session/s-1/work/server.log'
    const props: TextPreviewProps = {
      ...base,
      useTabInfo: () => ({ ...info, tab: { ...info.tab, contentId: address, navigation: { ...info.tab.navigation, address } } }),
    }
    const view = render(<TextPreview {...props} />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-state="unsupported"]')).toBeNull()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(view.container.textContent).toContain('plain line')
    h.controller.abort()
  })
})
