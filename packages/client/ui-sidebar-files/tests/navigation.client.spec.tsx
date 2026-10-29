// @vitest-environment jsdom
/** Target-tab navigation through the real files face, store, and snapshot sources. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabNavigation } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { filesFace } from '../src/client/face.ts'
import type { ListWorkspaceDirectory, WatchWorkspaceDirectory } from '../src/client/face.ts'
import { createFilesStore } from '../src/client/store.ts'

const SESSION = 'navigation-session' as SessionId
const LEFT = 'pane-left' as PaneId
const RIGHT = 'pane-right' as PaneId
const A = 'tab-a' as TabId
const B = 'tab-b' as TabId

interface TestTab {
  readonly id: TabId
  readonly address: string
  readonly controller: AbortController
  readonly navigation: SnapshotStore<SidebarRightTabNavigation>
  readonly listeners: Set<() => void>
}

/** Own DOM, browser measurement substitutes, and tab lifetimes within one test. */
function harness() {
  const instance = createFilesStore().create(SESSION)
  const tabs = new Map<TabId, TestTab>()
  const releases: (() => void)[] = []
  const drawings: (() => void)[] = []
  const observers = new Set<MeasuredRow>()
  class MeasuredRow implements ResizeObserver {
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void { this.targets.add(target); observers.add(this) }
    unobserve(target: Element): void { this.targets.delete(target) }
    disconnect(): void { this.targets.clear(); observers.delete(this) }
    measure(target: Element): void { if (this.targets.has(target)) this.callback([], this) }
  }
  const viewport = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('ResizeObserver', MeasuredRow)
  vi.stubGlobal('matchMedia', () => viewport)
  const root = document.createElement('div')
  document.body.append(root)
  onTestFinished(async () => {
    try {
      for (const release of releases) release()
      for (const remove of drawings) remove()
      for (const tab of tabs.values()) tab.controller.abort()
      root.remove()
      // The face settles forgotten panes and focus handoffs at the task boundary.
      await Promise.resolve()
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
  const list = vi.fn<ListWorkspaceDirectory>(() => { throw new Error('Navigation must not list directories') })
  const watch = vi.fn<WatchWorkspaceDirectory>(() => { throw new Error('Navigation must not open directory watches') })
  const canOpen = createSnapshotStore((_address: string) => true)
  const face = filesFace(list, watch, canOpen, (sessionId, tabId) => {
    expect(sessionId).toBe(SESSION)
    const tab = tabs.get(tabId)
    if (tab === undefined) throw new Error(`Unknown test tab: ${tabId}`)
    return {
      getSnapshot: () => tab.navigation.getSnapshot(),
      subscribe: (listener) => {
        tab.listeners.add(listener)
        const unsubscribe = tab.navigation.subscribe(listener)
        return () => { unsubscribe(); tab.listeners.delete(listener) }
      },
    }
  })(SESSION, instance, () => () => {})

  const tab = (id: TabId, revision = 0): TestTab => {
    const address = sessionFileAddress(SESSION, `${id}.ts`)
    const value: TestTab = {
      id, address, controller: new AbortController(), listeners: new Set(),
      navigation: createSnapshotStore<SidebarRightTabNavigation>({ address, params: undefined, revision }),
    }
    tabs.set(id, value)
    return value
  }
  const attach = (paneId: PaneId, tab: TestTab): (() => void) => {
    const release = face.attach(paneId, tab.id, tab.controller.signal)
    releases.push(release)
    return release
  }
  const draw = (paneId: PaneId, tab: TestTab, width: number, options: { closable?: boolean; focusContent?: boolean } = {}) => {
    const shell = document.createElement('section')
    const toggle = document.createElement('button')
    toggle.textContent = `Toggle ${paneId}`
    const row = document.createElement('div')
    const content = document.createElement('button')
    content.textContent = `Content ${tab.id}`
    const navigator = document.createElement('aside')
    const body = document.createElement('div')
    body.tabIndex = -1
    const file = document.createElement('button')
    file.textContent = tab.address
    body.append(file)
    navigator.append(body)
    row.append(content, navigator)
    shell.append(toggle, row)
    root.append(shell)
    let currentWidth = width
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, currentWidth, 300))
    if (options.focusContent) content.focus()
    const closable = options.closable ?? true
    // Child refs run before the navigator ref; the attachment effect follows both.
    face.toggleDrawn(paneId, toggle)
    face.bodyDrawn(paneId, tab.address, body)
    face.navigatorDrawn(paneId, navigator, closable)
    let removed = false
    const remove = (): void => {
      if (removed) return
      removed = true
      face.navigatorDrawn(paneId, null, closable)
      face.bodyDrawn(paneId, tab.address, null)
      face.toggleDrawn(paneId, null)
      shell.remove()
    }
    drawings.push(remove)
    return {
      row, navigator, body, file, content, toggle, remove,
      resize: (next: number): void => {
        currentWidth = next
        for (const observer of [...observers]) observer.measure(row)
      },
    }
  }
  return {
    instance, face, viewport, tab, attach, draw,
    shown: (paneId: PaneId, open: boolean): void => { instance.actions.shown(paneId, open) },
    state: (paneId: PaneId) => instance.getSnapshot().byPane[paneId],
    navigate: (tab: TestTab, revision: number, params?: SidebarRightTabNavigation['params']): void => {
      tab.navigation.set({ address: tab.address, params, revision })
    },
  }
}

describe('files navigator target navigation', () => {
  it.each([
    ['restored revision zero', 0, true],
    ['newly opened revision one', 1, false],
  ] as const)('applies the initial open choice for %s', (_name, revision, expectedOpen) => {
    const h = harness()
    const tab = h.tab(A, revision)
    h.shown(LEFT, true)
    h.draw(LEFT, tab, 399)
    h.attach(LEFT, tab)
    expect(h.state(LEFT)?.open).toBe(expectedOpen)
  })

  it('closes its own filled tree on every reveal, returning tree focus to its toggle', async () => {
    const h = harness()
    const tab = h.tab(A)
    h.shown(LEFT, true)
    const drawing = h.draw(LEFT, tab, 399)
    h.attach(LEFT, tab)
    for (const revision of [1, 2]) {
      h.shown(LEFT, true)
      drawing.file.focus()
      h.navigate(tab, revision, revision === 1 ? undefined : { line: 12 })
      expect(h.state(LEFT)?.open).toBe(false)
      await Promise.resolve()
      expect(document.activeElement).toBe(drawing.toggle)
    }
  })

  it.each([false, true])('changes only target B while source A is open=%s', async (sourceOpen) => {
    const h = harness()
    const a = h.tab(A)
    const b = h.tab(B)
    h.shown(LEFT, sourceOpen)
    h.shown(RIGHT, true)
    h.instance.actions.resized(LEFT, 287)
    const source = h.draw(LEFT, a, 399)
    h.draw(RIGHT, b, 399)
    h.attach(LEFT, a)
    h.attach(RIGHT, b)
    const focus = sourceOpen ? source.file : source.toggle
    focus.focus()
    const before = h.state(LEFT)
    h.navigate(b, 1)
    expect(h.state(RIGHT)?.open).toBe(false)
    expect(h.state(LEFT)).toEqual(before)
    expect(h.state(LEFT)?.width).toBe(287)
    await Promise.resolve()
    expect(document.activeElement).toBe(focus)
  })

  it.each([
    [800, 399, false],
    [399, 800, true],
  ] as const)('waits for inactive B to draw at its new width (%s -> %s)', async (oldWidth, newWidth, expectedOpen) => {
    const h = harness()
    const b = h.tab(B)
    h.shown(LEFT, true)
    const previous = h.draw(LEFT, b, oldWidth)
    const detach = h.attach(LEFT, b)
    detach()
    previous.remove()
    const a = h.tab(A)
    const source = h.draw(LEFT, a, oldWidth)
    h.attach(LEFT, a)
    source.file.focus()
    h.navigate(b, 1)
    expect(h.state(LEFT)?.open).toBe(true)
    expect(document.activeElement).toBe(source.file)
    h.shown(RIGHT, true)
    h.draw(RIGHT, b, newWidth)
    h.attach(RIGHT, b)
    expect(h.state(RIGHT)?.open).toBe(expectedOpen)
    expect(h.state(LEFT)?.open).toBe(true)
    await Promise.resolve()
    expect(document.activeElement).toBe(source.file)
  })

  it('consumes navigation while hidden, so manually showing the tree does not answer it again', () => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.shown(LEFT, false)
    h.attach(LEFT, tab)
    h.navigate(tab, 2)
    expect(h.state(LEFT)?.open).toBe(false)
    h.shown(LEFT, true)
    const drawing = h.draw(LEFT, tab, 399)
    expect(h.state(LEFT)?.open).toBe(true)
    drawing.resize(300)
    expect(h.state(LEFT)?.open).toBe(true)
    h.navigate(tab, 3)
    expect(h.state(LEFT)?.open).toBe(false)
  })

  it.each(['remount', 'tab switch', 'pane move'] as const)('does not repeat a consumed revision after %s', (transition) => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.shown(LEFT, true)
    const previous = h.draw(LEFT, tab, 800)
    const detach = h.attach(LEFT, tab)
    expect(h.state(LEFT)?.open).toBe(true)
    detach()
    previous.remove()
    if (transition === 'tab switch') {
      const other = h.tab(B)
      const drawing = h.draw(LEFT, other, 399)
      const release = h.attach(LEFT, other)
      expect(h.state(LEFT)?.open).toBe(true)
      release()
      drawing.remove()
    }
    const destination = transition === 'pane move' ? RIGHT : LEFT
    h.shown(destination, true)
    h.draw(destination, tab, 399)
    h.attach(destination, tab)
    expect(h.state(destination)?.open).toBe(true)
    h.navigate(tab, 2)
    expect(h.state(destination)?.open).toBe(false)
  })

  it.each([400, 560, 900])('does not close for navigation at row width %s or replay it on a later resize', (width) => {
    const h = harness()
    const tab = h.tab(A)
    h.shown(LEFT, true)
    const drawing = h.draw(LEFT, tab, width)
    h.attach(LEFT, tab)
    for (const revision of [1, 2, 3]) {
      h.navigate(tab, revision)
      expect(h.state(LEFT)?.open).toBe(true)
    }
    drawing.resize(399)
    expect(h.state(LEFT)?.open).toBe(true)
    h.navigate(tab, 4)
    expect(h.state(LEFT)?.open).toBe(false)
  })

  it('closes at a fullscreen viewport even when the row is wide', () => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.viewport.matches = true
    h.shown(LEFT, true)
    h.draw(LEFT, tab, 900)
    h.attach(LEFT, tab)
    expect(h.state(LEFT)?.open).toBe(false)
  })

  it('leaves a non-closable files page open despite navigation and a filled row', () => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.viewport.matches = true
    h.shown(LEFT, true)
    h.draw(LEFT, tab, 399, { closable: false })
    h.attach(LEFT, tab)
    expect(h.state(LEFT)?.open).toBe(true)
    h.navigate(tab, 2)
    expect(h.state(LEFT)?.open).toBe(true)
  })

  it('waits for the first current row rather than consuming revision one without a drawing', () => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.shown(LEFT, true)
    h.attach(LEFT, tab)
    expect(h.state(LEFT)?.open).toBe(true)
    h.draw(LEFT, tab, 399)
    expect(h.state(LEFT)?.open).toBe(false)
  })

  it('does not move content focus into a tree closed by its first pending navigation', async () => {
    const h = harness()
    const tab = h.tab(A, 1)
    h.shown(LEFT, true)
    h.attach(LEFT, tab)
    const drawing = h.draw(LEFT, tab, 399, { focusContent: true })
    expect(h.state(LEFT)?.open).toBe(false)
    await Promise.resolve()
    expect(document.activeElement).toBe(drawing.content)
  })

  it('unsubscribes on tab abort and leaves its surviving drawing and focus unchanged', async () => {
    const h = harness()
    const tab = h.tab(A)
    h.shown(LEFT, true)
    const drawing = h.draw(LEFT, tab, 399)
    h.attach(LEFT, tab)
    drawing.file.focus()
    expect(tab.listeners.size).toBe(1)
    tab.controller.abort()
    expect(tab.listeners.size).toBe(0)
    h.navigate(tab, 1)
    expect(h.state(LEFT)?.open).toBe(true)
    await Promise.resolve()
    expect(document.activeElement).toBe(drawing.file)
  })
  it('waits for a navigator without a containing row before answering navigation', () => {
    const h = harness()
    const tab = h.tab(B)
    h.attach(RIGHT, tab)
    h.shown(RIGHT, true)
    const navigator = document.createElement('aside')
    const body = navigator.appendChild(document.createElement('div'))
    h.face.bodyDrawn(RIGHT, tab.address, body)
    h.face.navigatorDrawn(RIGHT, navigator, true)
    h.navigate(tab, 1)
    expect(h.state(RIGHT)?.open).toBe(true)
    h.draw(RIGHT, tab, 399)
    expect(h.state(RIGHT)?.open).toBe(false)
  })

})
