// @vitest-environment jsdom
/** The files page and its tree, over controlled directory watches and deferred listings. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { failureLine } from '../src/client/workspace-tree.ts'
import type { DirLevel } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import { mountBody, PANE, ROOT, SESSION } from './mount.client.tsx'

const ROOT_LEVEL: DirLevel = {
  entries: [
    { name: 'README.md', type: 'file', size: 12 },
    { name: 'src', type: 'directory' },
    { name: '.env', type: 'file', size: 2 },
    { name: 'pipe', type: 'other' },
  ],
  truncated: false,
}

afterEach(() => { cleanup() })

/** Row labels in document order. */
function names(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-files-entry]')].map(li => li.getAttribute('data-files-path')!)
}

describe('FilesBody', () => {
  it('displays the effective file-tree refresh accelerator', async () => {
    const { view, script } = mountBody(ROOT, { refreshShortcut: { id: 'page.refresh' as never, label: 'Refresh', aliases: [],
      binding: null, keys: ['Ctrl', 'R'], aria: 'Control+R', modified: true, conflicts: [], issue: null } })
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(view.getByRole('button', { name: zh.reload }).getAttribute('aria-keyshortcuts')).toBe('Control+R')
  })
  it('says so when the session has no workspace directory, and asks for nothing', () => {
    const { view, script } = mountBody(null)
    expect(view.container.querySelector('[data-files-state="no-workspace"]')?.textContent).toBe(zh.noWorkspace)
    expect(script.list).not.toHaveBeenCalled()
  })

  it('heads the page with the root and reload, and fills the rest with a headerless tree that stays shown', async () => {
    const viewport = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', () => viewport)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const { view, script, instance, tabActions } = mountBody()
    expect(viewport.addEventListener).not.toHaveBeenCalled()
    await act(() => script.watches.ready(ROOT))
    const page = view.container.querySelector('[data-files-page]')!
    const header = page.firstElementChild!
    expect(header.querySelector('[data-files-path]')?.getAttribute('title')).toBe(ROOT)
    expect([...header.querySelectorAll('button:not([data-files-auto-refresh])')].map(button => button.getAttribute('aria-label')))
      .toEqual([zh.reload])
    const content = page.querySelector('[data-files-content]')!
    expect(content.children).toHaveLength(1)
    const navigator = content.firstElementChild!
    expect(navigator.getAttribute('data-files-navigator')).toBe(PANE)
    expect(navigator.querySelector('[data-files-reload], [data-files-path]:not(li)')).toBeNull()
    // The tree fills the page: it neither floats nor resizes.
    expect(navigator.hasAttribute('data-files-navigator-mode')).toBe(false)
    expect(view.queryByRole('separator')).toBeNull()
    expect(view.container.querySelector('[data-files-navigator-toggle]')).toBeNull()
    // Escape and a hidden choice for the pane leave the page's tree shown.
    fireEvent.keyDown(navigator, { key: 'Escape' })
    act(() => { instance.actions.shown(PANE, false) })
    expect(view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    expect(view.getByRole('button', { name: zh.reload }).hasAttribute('disabled')).toBe(false)
    const bound = tabActions.bindCommands.mock.lastCall?.[0]
    expect(typeof bound?.refresh).toBe('function')
  })

  it('lists the root on mount, heads it with its path split at the last segment, and draws directories first with dotfiles kept', async () => {
    const { view, script } = mountBody()
    expect(script.list).not.toHaveBeenCalled()
    await act(() => script.watches.ready(ROOT))
    expect(script.list).toHaveBeenCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    expect(view.container.querySelector('[data-files-row="loading"]')).not.toBeNull()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(view.container.querySelector('[data-files-state="tree"]')?.getAttribute('data-files-root')).toBe(ROOT)
    const path = view.container.querySelector('[data-files-path]')
    expect(path?.getAttribute('title')).toBe(ROOT)
    expect([...path?.firstElementChild?.children ?? []].map(span => span.textContent)).toEqual(['/work/', 'app'])
    expect(names(view.container)).toEqual([`${ROOT}/src`, `${ROOT}/.env`, `${ROOT}/pipe`, `${ROOT}/README.md`])
    const envIcon = view.container.querySelector(`[data-files-path="${ROOT}/.env"] svg`)?.innerHTML
    const readmeIcon = view.container.querySelector(`[data-files-path="${ROOT}/README.md"] svg`)?.innerHTML
    expect(envIcon).not.toBe(readmeIcon)
  })

  it('heads a separator-only root by the root itself, since it has no final segment', async () => {
    const { view, script } = mountBody('/')
    await act(() => script.watches.ready('/'))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const path = view.container.querySelector('[data-files-path]')
    expect([...path?.firstElementChild?.children ?? []].map(span => span.textContent)).toEqual(['/'])
    expect(names(view.container)).toEqual(['/src', '/.env', '/pipe', '/README.md'])
  })

  it('marks the root path clipped while its text is wider than its box, re-reading on resize', async () => {
    class FakeResizeObserver implements ResizeObserver {
      static readonly instances: FakeResizeObserver[] = []
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
      constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this)
      }

      fire(): void {
        this.callback([], this)
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    let boxWidth = 300
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => boxWidth })
    try {
      const { view, script } = mountBody()
      await act(() => script.watches.ready(ROOT))
      await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
      const path = view.container.querySelector<HTMLElement>('[data-files-path]')
      const text = path?.firstElementChild
      expect(path?.hasAttribute('data-path-clipped')).toBe(false)
      // The navigator observes its row too; the path label observes itself.
      const observer = FakeResizeObserver.instances.find(candidate => candidate.observe.mock.calls.some(([target]) => target === path))
      if (observer === undefined) throw new Error('expected the path to observe its size')
      expect(observer.observe).toHaveBeenCalledWith(path)
      expect(observer.observe).toHaveBeenCalledWith(text)

      boxWidth = 120
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-path-clipped')).toBe(true)

      boxWidth = 300
      act(() => { observer.fire() })
      expect(path?.hasAttribute('data-path-clipped')).toBe(false)
      view.unmount()
      expect(observer.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
      for (const [name, descriptor] of [['offsetWidth', offsetWidth], ['clientWidth', clientWidth]] as const) {
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
        else Object.defineProperty(HTMLElement.prototype, name, descriptor)
      }
    }
  })

  it('reopening a directory shows its cache and replaces it after the new subscription is ready', async () => {
    const { view, script } = mountBody()
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const dir = within(view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/src"]`)!).getByRole('button', { name: 'src' })
    act(() => { fireEvent.click(dir) })
    expect(script.list).toHaveBeenCalledTimes(1)
    const childStream = await act(() => script.watches.ready(`${ROOT}/src`))
    expect(script.list).toHaveBeenLastCalledWith(SESSION, `${ROOT}/src`, expect.any(AbortSignal))
    expect(dir.getAttribute('aria-expanded')).toBe('true')
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'a.ts', type: 'file' }], truncated: false } }))
    expect(names(view.container)).toContain(`${ROOT}/src/a.ts`)
    act(() => { fireEvent.click(dir) })
    expect(childStream.signal.aborted).toBe(true)
    await childStream.released.promise
    expect(dir.getAttribute('aria-expanded')).toBe('false')
    expect(names(view.container)).not.toContain(`${ROOT}/src/a.ts`)
    act(() => { fireEvent.click(dir) })
    expect(names(view.container)).toContain(`${ROOT}/src/a.ts`)
    expect(script.list).toHaveBeenCalledTimes(2)
    await act(() => script.watches.ready(`${ROOT}/src`, 1))
    expect(script.list).toHaveBeenCalledTimes(3)
    expect(names(view.container)).toContain(`${ROOT}/src/a.ts`)
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'b.ts', type: 'file' }], truncated: false } }))
    expect(names(view.container)).toContain(`${ROOT}/src/b.ts`)
    expect(names(view.container)).not.toContain(`${ROOT}/src/a.ts`)
  })

  it.each([false, true])('opens a file without replacing the page (floating: %s)', async (isFloating) => {
    const { view, script, tabActions, instance } = mountBody(ROOT, { isFloating })
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    fireEvent.click(within(view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/README.md"]`)!).getByRole('button', { name: 'README.md' }))
    // Every row sits under the tree's root, so the address is the path relative to it.
    const address = fileAddressFor(SESSION, ROOT, `${ROOT}/README.md`)
    if (isFloating) expect(tabActions.openResource).toHaveBeenCalledExactlyOnceWith(address)
    else expect(tabActions.openResource).toHaveBeenCalledExactlyOnceWith(address, { paneId: PANE })
    // The page writes no tree choice for its pane, where the file it appends draws.
    expect(instance.getSnapshot().byPane[PANE]?.open).toBeUndefined()
    expect(view.container.querySelector('[data-files-navigator]')).not.toBeNull()
    const other = view.container.querySelector(`[data-files-path="${ROOT}/pipe"]`)!
    expect(other.querySelector('button')).toBeNull()
    expect(other.querySelector('[aria-disabled="true"]')?.getAttribute('title')).toBe(zh['entry.other'])
  })

  it('marks a cut listing and an empty one', async () => {
    const { view, script } = mountBody()
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'd', type: 'directory' }], truncated: true } }))
    expect(view.container.querySelector('[data-files-row="truncated"]')?.textContent).toBe(zh.truncated)
    act(() => { fireEvent.click(within(view.container.querySelector<HTMLElement>(`[data-files-path="${ROOT}/d"]`)!).getByRole('button', { name: 'd' })) })
    await act(() => script.watches.ready(`${ROOT}/d`))
    await act(() => script.settle({ ok: true, value: { entries: [], truncated: false } }))
    expect(view.container.querySelector('[data-files-row="empty"]')?.textContent).toBe(zh.empty)
  })

  it('shows a failed level under its directory in terms of the directory', async () => {
    const { view, script } = mountBody()
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({
      ok: false,
      error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }),
    }))
    expect(view.container.querySelector('[data-files-row="failed"]')?.textContent).toBe(zh['error.notFound'])
    expect(view.container.querySelector('[data-files-row="empty"]')).toBeNull()
  })

  it('shows a refresh failure beside the existing directory rows and clears it on retry', async () => {
    const { view, script } = mountBody()
    await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const rows = names(view.container)
    const reload = view.getByRole('button', { name: zh.reload })
    act(() => { fireEvent.click(reload) })
    await act(() => script.settle({
      ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }),
    }))
    expect(view.container.querySelector('[data-files-row="failed"]')?.textContent).toBe(zh['error.notFound'])
    expect(names(view.container)).toEqual(rows)
    act(() => { fireEvent.click(reload) })
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(view.container.querySelector('[data-files-row="failed"]')).toBeNull()
    expect(names(view.container)).toEqual(rows)
  })

  it.each(['button', 'shortcut'])('%s refreshes expanded nodes without clearing cached rows or the scroll position', async (source) => {
    const { view, script, instance, tabActions } = mountBody()
    const child = `${ROOT}/src`
    const collapsed = `${ROOT}/docs`
    const rootStream = await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { fireEvent.click(within(view.container.querySelector<HTMLElement>(`[data-files-path="${child}"]`)!).getByRole('button', { name: 'src' })) })
    await act(() => script.watches.ready(child))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    act(() => { instance.actions.loaded(PANE, collapsed, ROOT_LEVEL) })
    const cached = instance.getSnapshot().byPane[PANE]!.tree!
    const childRow = view.container.querySelector(`[data-files-path="${child}"]`)
    const body = view.container.querySelector('[data-files-body]')!
    fireEvent.scroll(body, { target: { scrollTop: 120 } })

    act(() => {
      if (source === 'button') fireEvent.click(view.container.querySelector('[data-files-reload]')!)
      else tabActions.bindCommands.mock.calls.at(-1)![0].refresh!()
    })
    expect(script.list.mock.calls.slice(2).map(call => call[1])).toEqual([ROOT])
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, rootStream.signal)
    // A level listed again keeps its entries, marked as refreshing.
    expect(instance.getSnapshot().byPane[PANE]!.tree!.levels)
      .toEqual({ ...cached.levels, [ROOT]: { ...cached.levels[ROOT], refreshing: true } })
    expect(view.container.querySelector('[data-files-row="loading"]')).toBeNull()
    await act(async () => {
      await script.settle({ ok: true, value: ROOT_LEVEL })
      await script.waitForList(3)
    })
    expect(script.list.mock.calls.slice(2).map(call => call[1])).toEqual([ROOT, child])
    expect(instance.getSnapshot().byPane[PANE]!.tree!.levels)
      .toEqual({ ...cached.levels, [child]: { ...cached.levels[child], refreshing: true } })
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(view.container.querySelector(`[data-files-path="${child}"]`)).toBe(childRow)
    expect(body.scrollTop).toBe(120)
    expect(instance.getSnapshot().byPane[PANE]!.tree!.expanded).toEqual([ROOT, child])
    expect(script.watches.opened.map(stream => stream.path)).toEqual([ROOT, child])
    expect(view.container.querySelector('[data-files-reload]')?.getAttribute('aria-label')).toBe(zh.reload)
  })

  it('keeps the automatic control hidden and enabled by default, with manual reload independent of its setting', async () => {
    const { view, script, instance } = mountBody()
    const stream = await act(() => script.watches.ready(ROOT))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const automatic = view.container.querySelector('[data-files-auto-refresh]')!
    expect(automatic.closest('span[hidden]')).not.toBeNull()
    expect(automatic.getAttribute('aria-pressed')).toBe('true')
    expect(view.queryByRole('button', { name: zh.autoRefresh })).toBeNull()
    expect(view.getByRole('button', { name: zh.reload })).toBeDefined()
    act(() => { fireEvent.click(automatic) })
    expect(automatic.getAttribute('aria-pressed')).toBe('false')
    await act(() => stream.deliver('change'))
    expect(script.list).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.click(view.getByRole('button', { name: zh.reload })) })
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(script.list).toHaveBeenCalledTimes(2)
    expect(instance.getSnapshot().byPane[PANE]!.tree!.autoRefresh).toBe(false)
    expect(automatic.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('failureLine', () => {
  const t = makeTranslate(zh)

  it('names each directory failure', () => {
    expect(failureLine(t, new RemoteError('workspace-file/not-found', 'x', { path: 'p' }))).toBe(zh['error.notFound'])
    expect(failureLine(t, new RemoteError('workspace-file/outside-workspace', 'x', { path: 'p' })))
      .toBe(zh['error.outsideWorkspace'])
    expect(failureLine(t, new RemoteError('workspace-file/not-directory', 'x', { path: 'p', kind: 'file' })))
      .toBe(zh['error.notDirectory'])
  })

  it('carries an unclassified failure\'s own message', () => {
    const failure = { code: 'remote/transport', message: 'socket closed' } as unknown as RemoteFailure
    expect(failureLine(t, failure)).toBe('读取失败：socket closed')
  })
})


it('opens the clicked file menu in its pane without activating the file', async () => {
  const h = mountBody()
  await act(() => h.script.watches.ready(ROOT))
  await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
  const row = h.view.container.querySelector(`[data-files-path="${ROOT}/README.md"] button`)!
  fireEvent.contextMenu(row, { clientX: 45, clientY: 56 })
  expect(h.shared.openMenu).toHaveBeenCalledWith({ kind: 'file', value: { sessionId: SESSION, path: `${ROOT}/README.md`, paneId: 'pane-1' } }, { x: 45, y: 56 })
  expect(h.tabActions.openResource).not.toHaveBeenCalled()
})

it('opens menus for a collapsed folder and the root without expanding or activating a file', async () => {
  const h = mountBody()
  await act(() => h.script.watches.ready(ROOT))
  await act(() => h.script.settle({ ok: true, value: ROOT_LEVEL }))
  const folder = h.view.getByRole('button', { name: 'src' })
  fireEvent.contextMenu(folder, { clientX: 20, clientY: 30 })
  expect(h.shared.openMenu).toHaveBeenLastCalledWith({ kind: 'directory', value: { sessionId: SESSION, path: `${ROOT}/src` } }, { x: 20, y: 30 })
  expect(folder.getAttribute('aria-expanded')).toBe('false')
  fireEvent.contextMenu(h.view.container.querySelector('[data-path-label]')!, { clientX: 10, clientY: 15 })
  expect(h.shared.openMenu).toHaveBeenLastCalledWith({ kind: 'directory', value: { sessionId: SESSION, path: ROOT } }, { x: 10, y: 15 })
  expect(h.tabActions.openResource).not.toHaveBeenCalled()
})
