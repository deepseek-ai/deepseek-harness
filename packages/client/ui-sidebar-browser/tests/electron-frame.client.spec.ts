// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ElectronWebViewImpl } from '../src/client/electron/ElectronWebViewImpl.ts'
import { ElectronWebviewPresentation, type WebviewElement } from '../src/client/electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../src/types.ts'

it('clears a failed load when the main page retries without a toolbar command', async () => {
  let url = 'about:blank'
  let loading = true
  const element: WebviewElement = Object.assign(document.createElement('div'), {
    loadURL: vi.fn(async () => {}), getURL: () => url, getTitle: () => 'Recovered',
    canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => loading,
  })
  const bridge: DesktopBrowserBridge = {
    acquire: vi.fn(async () => ({ lease: 'lease' as DesktopBrowserLeaseId, partition: 'partition' })),
    release: vi.fn(async () => {}), onOpenRequested: () => () => {},
  }
  const presentation = new ElectronWebviewPresentation({ mounted: () =>{  frame.attach() }, unmounted: () =>{  frame.detach() } })
  const frame = new ElectronWebViewImpl({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() },
    bridge, async () => 'cwd:/workspace', presentation)
  const createElement = vi.spyOn(presentation, 'createElement').mockReturnValue(element)
  const host = document.createElement('div')
  host.id = 'electron-frame-retry'
  document.body.append(host)
  try {
    presentation.mount(host.id)
    frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
    await vi.waitFor(() => { expect(host.firstElementChild).toBe(element) })
    element.dispatchEvent(new Event('dom-ready'))
    element.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      isMainFrame: true, errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED',
    }))
    expect(frame.getSnapshot().error?.code).toBe(-105)
    element.dispatchEvent(new Event('page-title-updated'))
    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: false }))
    expect(frame.getSnapshot().error?.code).toBe(-105)

    element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true }))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: true })
    url = 'https://example.test/recovered'
    element.dispatchEvent(new Event('did-navigate'))
    loading = false
    element.dispatchEvent(new Event('did-stop-loading'))
    expect(frame.getSnapshot()).toMatchObject({ error: undefined, loading: false, target: { url, title: 'Recovered' } })
  } finally {
    await frame.dispose()
    createElement.mockRestore()
    host.remove()
  }
})
