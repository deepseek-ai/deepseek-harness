// @vitest-environment jsdom
/** Browser-action feedback and route-owned asynchronous clipboard work. */
import assert from 'node:assert/strict'
import { createApp, createSSRApp, h, nextTick, reactive, ref, type App, type Slots } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { fireEvent, getByRole, queryAllByRole, queryByRole, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Theme from '../.vitepress/theme/index.ts'

vi.mock('vitepress', () => ({ useData: () => data, useRoute: () => route }))
vi.mock('vitepress/theme', () => ({ default: { Layout: {
  setup: (_props: unknown, { slots }: { slots: Slots }) => () => h('main', null, slots['doc-before']?.()),
} } }))
vi.mock('../.vitepress/theme/mermaid-viewer.ts', () => ({ installMermaidViewer: () => ({ refresh() {}, dispose() {} }) }))
vi.mock('../.vitepress/theme/image-viewer.ts', () => ({ ImageViewer: class { refresh() {} dispose() {} } }))
vi.mock('../.vitepress/theme/media-viewer.ts', () => ({ MediaViewer: class { close() {} } }))

const data = {
  lang: ref('en-US'), isDark: ref(false),
  frontmatter: ref<Record<string, unknown>>({}),
  site: ref({ base: '/' }), page: ref({ isNotFound: false }),
}
const route = reactive({ path: '/en/guide/quickstart' })
const fetchMock = vi.fn<typeof fetch>()
const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>()
let app: App | undefined
let host: HTMLDivElement
let copied: Blob | undefined
let activeWrite: Promise<void> | undefined
const deferredWork: { promise: Promise<unknown>; reject: (reason: unknown) => void }[] = []

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  deferredWork.push({ promise, reject })
  void promise.catch((_error: unknown) => {
    // Teardown can reject a barrier before an assertion reaches its consumer.
  })
  return { promise, resolve, reject }
}

function response(text = '# Quickstart\n\n[Reference](../reference/index.md)\n', status = 200, type = 'text/markdown') {
  return new Response(text, { status, headers: { 'content-type': `${type}; charset=utf-8` } })
}

async function mount() {
  app = createApp(Theme.Layout)
  app.mount(host)
  await nextTick()
}

async function openMenu() {
  const toggle = getByRole(host, 'button', { name: 'More page actions' })
  fireEvent.click(toggle)
  await nextTick()
  return toggle
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  data.lang.value = 'en-US'
  data.site.value = { base: '/' }
  data.frontmatter.value = { rawMarkdownPath: 'en/guide/quickstart.md' }
  data.page.value = { isNotFound: false }
  route.path = '/en/guide/quickstart'
  copied = undefined
  activeWrite = undefined
  fetchMock.mockReset().mockResolvedValue(response())
  write.mockReset().mockImplementation((items) => {
    const item = items[0] as unknown as TestClipboardItem
    const content = item.data['text/plain']
    assert(content !== undefined)
    activeWrite = content.then((blob) => { copied = blob })
    return activeWrite
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ClipboardItem', TestClipboardItem)
  vi.stubGlobal('navigator', { clipboard: { write } })
})

afterEach(async () => {
  app?.unmount()
  app = undefined
  const work = deferredWork.splice(0)
  for (const pending of work) pending.reject(new Error('Test disposed'))
  await Promise.allSettled([...work.map(pending => pending.promise), activeWrite])
  host.remove()
  vi.unstubAllGlobals()
})

describe('page Markdown actions', () => {
  it.each(['en-US', 'zh-CN'])('preserves the accessible controls and status in %s', async (lang) => {
    data.lang.value = lang
    data.frontmatter.value = { rawMarkdownPath: `${lang === 'en-US' ? 'en/' : ''}guide/quickstart.md` }
    await mount()
    await expect(`${host.innerHTML}\n`).toMatchFileSnapshot(`./expected/page-markdown-actions.${lang}.html`)
    fireEvent.click(getByRole(host, 'button', { name: lang === 'en-US' ? 'More page actions' : '更多页面操作' }))
    await nextTick()
    await expect(`${host.innerHTML}\n`).toMatchFileSnapshot(`./expected/page-markdown-menu.${lang}.html`)
  })

  it.each(['en-US', 'zh-CN'])('offers a working raw link before hydration in %s', async (lang) => {
    data.lang.value = lang
    data.site.value = { base: '/deepseek-harness/' }
    const path = `${lang === 'en-US' ? 'en/' : ''}guide/quickstart.md`
    data.frontmatter.value = { rawMarkdownPath: path }
    host.innerHTML = await renderToString(createSSRApp(Theme.Layout))
    expect(queryAllByRole(host, 'button')).toHaveLength(0)
    const link = getByRole(host, 'link')
    expect(link.getAttribute('href')).toBe(`/deepseek-harness/${path}`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('aria-label')).toBe(lang === 'en-US'
      ? 'View as Markdown (opens in a new tab)' : '以 Markdown 格式查看（在新标签页打开）')
    await expect(`${host.innerHTML}\n`).toMatchFileSnapshot(`./expected/page-markdown-static.${lang}.html`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens from the keyboard, moves between actions, and restores focus on Escape', async () => {
    await mount()
    const toggle = getByRole(host, 'button', { name: 'More page actions' })
    toggle.focus()
    fireEvent.keyDown(toggle, { key: 'ArrowDown' })
    await nextTick()
    const copy = getByRole(host, 'menuitem', { name: 'Copy page' })
    const view = getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' })
    expect(document.activeElement).toBe(copy)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(copy, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(view)
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(copy)
    fireEvent.keyDown(copy, { key: 'End' })
    expect(document.activeElement).toBe(view)
    fireEvent.keyDown(view, { key: 'Home' })
    expect(document.activeElement).toBe(copy)
    fireEvent.keyDown(copy, { key: 'Escape' })
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(toggle, { key: 'ArrowUp' })
    await nextTick()
    expect(document.activeElement).toBe(getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dismisses on an outside pointer, focus leaving, and a second toggle click', async () => {
    await mount()
    const toggle = await openMenu()
    fireEvent.pointerDown(document.body)
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
    await openMenu()
    fireEvent.focusOut(getByRole(host, 'menuitem', { name: 'Copy page' }), { relatedTarget: document.body })
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
    await openMenu()
    fireEvent.click(toggle)
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
  })

  it.each(['copy', 'view', 'toggle'])('keeps %s activation available when pointer clicks do not focus controls', async (action) => {
    await mount()
    const toggle = await openMenu()
    const target = action === 'toggle' ? toggle : getByRole(host, 'menuitem', {
      name: action === 'copy' ? 'Copy page' : 'View as Markdown (opens in a new tab)',
    })
    let activated = false
    target.addEventListener('click', (event) => {
      activated = true
      if (action === 'view') event.preventDefault()
    }, { once: true })
    fireEvent.pointerDown(target)
    // Safari can blur the focused menu item without focusing the pressed control.
    if (fireEvent.mouseDown(target)) (document.activeElement as HTMLElement).blur()
    await nextTick()
    expect(target.isConnected).toBe(true)
    expect(queryByRole(host, 'menu')).not.toBeNull()
    fireEvent.mouseUp(target)
    fireEvent.click(target)
    await nextTick()
    expect(activated).toBe(true)
    expect(queryByRole(host, 'menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    if (action === 'copy') {
      await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
      expect(write).toHaveBeenCalledOnce()
    } else {
      expect(write).not.toHaveBeenCalled()
    }
  })

  it('copies from the menu in the same click and prevents another copy while it is pending', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    const toggle = await openMenu()
    fireEvent.click(getByRole(host, 'menuitem', { name: 'Copy page' }))
    expect(write).toHaveBeenCalledOnce()
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    await openMenu()
    const copy = getByRole(host, 'menuitem', { name: 'Copy page' })
    expect(copy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(copy)
    expect(write).toHaveBeenCalledOnce()
    expect(getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' }).getAttribute('href')).toBe('/en/guide/quickstart.md')
    pending.resolve(response())
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
  })

  it('opens the raw link from the menu and returns focus to the toggle', async () => {
    await mount()
    const toggle = await openMenu()
    const view = getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' })
    view.addEventListener('click', (event) => { event.preventDefault() }, { once: true })
    fireEvent.keyDown(view, { key: ' ' })
    await nextTick()
    expect(queryByRole(host, 'menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes outside-pointer listeners and closes its menu when the route changes', async () => {
    await mount()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    try {
      await openMenu()
      const listener = add.mock.calls.find(([name]) => name === 'pointerdown')?.[1]
      expect(listener).toBeTypeOf('function')
      route.path = '/en/reference/'
      data.frontmatter.value = { rawMarkdownPath: 'en/reference/index.md' }
      await nextTick()
      expect(queryByRole(host, 'menu')).toBeNull()
      expect(remove).toHaveBeenCalledWith('pointerdown', listener, true)
      await openMenu()
      app?.unmount()
      app = undefined
      expect(remove.mock.calls.filter(([name]) => name === 'pointerdown')).toHaveLength(2)
      fireEvent.pointerDown(document.body)
      expect(host.textContent).toBe('')
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })

  it.each(['/', '/deepseek-harness/'])('uses the manifest index route under base %s, independent of the visible URL', async (base) => {
    data.site.value = { base }
    data.frontmatter.value = { rawMarkdownPath: 'en/reference/index.md' }
    route.path = `${base}en/reference/index.html?from=nav#api`
    await mount()
    await openMenu()
    const link = getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' })
    expect(link.getAttribute('href')).toBe(`${base}en/reference/index.md`)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['home', '404'])('omits actions on %s', async (kind) => {
    if (kind === 'home') data.frontmatter.value = { layout: false }
    else data.page.value = { isNotFound: true }
    await mount()
    expect(queryByRole(host, 'button')).toBeNull()
    expect(queryByRole(host, 'link')).toBeNull()
  })

  it('starts clipboard.write during the click and copies the fetched plain text before reporting success', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    await mount()
    const button = getByRole(host, 'button', { name: 'Copy page' })
    button.focus()
    fireEvent.click(button)
    expect(write).toHaveBeenCalledOnce()
    expect(copied).toBeUndefined()
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/en/guide/quickstart.md?dsh-raw=1')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    await nextTick()
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(button)
    expect(getByRole(host, 'status').textContent).toBe('Copying…')
    pending.resolve(response())
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
    expect(copied?.type).toBe('text/plain')
    const reader = new FileReader()
    const text = new Promise((resolve) => { reader.addEventListener('load', () => { resolve(reader.result) }, { once: true }) })
    assert(copied !== undefined)
    reader.readAsText(copied)
    expect(await text).toBe('# Quickstart\n\n[Reference](../reference/index.md)\n')
    expect(button.getAttribute('aria-disabled')).toBe('false')
    expect(button.getAttribute('aria-busy')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  it.each(['network', '404', 'html'])('reports a %s response failure without success and allows retry', async (failure) => {
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'))
    else fetchMock.mockResolvedValueOnce(response('not Markdown', failure === '404' ? 404 : 200, failure === 'html' ? 'text/html' : 'text/markdown'))
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not load Markdown.') })
    expect(copied).toBeUndefined()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
  })

  it('accepts static hosting that serves Markdown as plain text', async () => {
    fetchMock.mockResolvedValueOnce(response('# Plain text hosting\n', 200, 'text/plain'))
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe('Markdown copied.') })
  })

  it.each(['application/javascript', 'application/octet-stream', undefined])('rejects a %s content type without copying it', async (type) => {
    fetchMock.mockResolvedValueOnce(new Response(new TextEncoder().encode('# Body\n'), {
      headers: type === undefined ? {} : { 'content-type': type },
    }))
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not load Markdown.') })
    expect(copied).toBeUndefined()
  })

  it('reports failure when reading the response body rejects', async () => {
    const raw = response()
    vi.spyOn(raw, 'text').mockRejectedValueOnce(new Error('Connection closed'))
    fetchMock.mockResolvedValueOnce(raw)
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not load Markdown.') })
    expect(copied).toBeUndefined()
  })

  it('keeps new-page feedback independent of a previous page clipboard write', async () => {
    const writeDone = deferred<void>()
    write.mockImplementationOnce(() => writeDone.promise)
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    route.path = '/en/reference/'
    data.frontmatter.value = { rawMarkdownPath: 'en/reference/index.md' }
    await nextTick()
    writeDone.resolve()
    await writeDone.promise
    await nextTick()
    expect(getByRole(host, 'status').textContent).toBe('')
  })

  it.each(['write', 'item'])('provides manual-copy feedback when the %s API is missing', async (missing) => {
    if (missing === 'item') vi.stubGlobal('ClipboardItem', undefined)
    else vi.stubGlobal('navigator', {})
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await nextTick()
    expect(getByRole(host, 'status').textContent).toContain('Could not copy.')
    await openMenu()
    expect(getByRole(host, 'menuitem', { name: 'View as Markdown (opens in a new tab)' })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts an unconsumed fetch when the clipboard rejects before consuming its data', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValue(pending.promise)
    write.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    await waitFor(() => { expect(getByRole(host, 'status').textContent).toContain('Could not copy.') })
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    pending.reject(new DOMException('Aborted', 'AbortError'))
    await pending.promise.catch((error: unknown) => { void error })
    await nextTick()
    expect(getByRole(host, 'status').textContent).toContain('Could not copy.')
  })

  it.each(['route', 'locale', 'unmount'])('cancels old data and ignores its completion after %s changes', async (change) => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await mount()
    fireEvent.click(getByRole(host, 'button', { name: 'Copy page' }))
    const oldWrite = activeWrite
    assert(oldWrite !== undefined)
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    if (change === 'unmount') { app?.unmount(); app = undefined }
    else {
      route.path = change === 'route' ? '/en/reference/' : '/guide/quickstart'
      data.lang.value = change === 'route' ? 'en-US' : 'zh-CN'
      data.frontmatter.value = { rawMarkdownPath: change === 'route' ? 'en/reference/index.md' : 'guide/quickstart.md' }
    }
    await nextTick()
    expect(signal?.aborted).toBe(true)
    pending.resolve(response('# Old page\n'))
    await expect(oldWrite).rejects.toThrow()
    await nextTick()
    expect(copied).toBeUndefined()
    if (change === 'unmount') expect(host.textContent).toBe('')
    else {
      expect(getByRole(host, 'status').textContent).toBe('')
      fireEvent.click(getByRole(host, 'button', { name: change === 'route' ? 'Copy page' : '复制页面' }))
      await waitFor(() => { expect(getByRole(host, 'status').textContent).toBe(change === 'route' ? 'Markdown copied.' : '已复制 Markdown。') })
      expect(fetchMock.mock.calls[1]?.[0]).toBe(change === 'route' ? '/en/reference/index.md?dsh-raw=1' : '/guide/quickstart.md?dsh-raw=1')
    }
  })
})
