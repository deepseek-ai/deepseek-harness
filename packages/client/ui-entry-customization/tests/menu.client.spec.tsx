// @vitest-environment jsdom
/** The plugin fills each region's More menu with entry rows and the discovery and Creator actions. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import { EntryMenuContent } from '../src/client/EntryMenuContent.tsx'
import { en } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

type Seats = 'sidebar.panellist.actions' | 'conversation.session.header.views.actions' | 'sidebar.right.tab.guide.actions'
const SEATS = ['sidebar.panellist.actions', 'conversation.session.header.views.actions', 'sidebar.right.tab.guide.actions'] as const
const runtimes = new Set<SlotTestRuntime>()
afterEach(async () => {
  try { for (const runtime of runtimes) await runtime.dispose() }
  finally { runtimes.clear(); cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() }
})

type ContentProps = ComponentProps<typeof EntryMenuContent>
const unused = (): never => { throw new Error('The menu rows read no framework hooks') }

function content(overrides: Partial<ContentProps> = {}) {
  const callbacks = {
    onOpen: vi.fn<ContentProps['onOpen']>(), onPinnedChange: vi.fn<ContentProps['onPinnedChange']>(),
    onDismiss: vi.fn<ContentProps['onDismiss']>(), browsePlugins: vi.fn<ContentProps['browsePlugins']>(),
    createPlugin: vi.fn<ContentProps['createPlugin']>(),
  }
  // Framework hooks stay unused stubs; this isolated row set reads only its owner, inject, and locale shares.
  const props = {
    entries: [{ id: 'notes', label: 'Notes', pinned: true }, { id: 'tasks', label: 'Tasks', pinned: false }],
    region: 'sidebar', t: makeTranslate(en), renderFactorySlot: unused,
    usePluginNavigation: <T,>(select: (present: boolean) => T): T => select(true),
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    useResource: unused, useWorkspaces: unused,
    ...callbacks,
    ...overrides,
  } as ContentProps
  const view = render(<div role="menu"><EntryMenuContent {...props} /></div>)
  return { view, ...callbacks }
}

describe('More menu rows', () => {
  it('separates opening from pinning and reports the inverted pin state', () => {
    const b = content()
    expect(b.view.getAllByRole('menuitem').map(row => row.getAttribute('aria-label') ?? row.textContent)).toEqual([
      'Notes', 'Unpin from left sidebar: Notes', 'Tasks', 'Pin to left sidebar: Tasks', 'Browse other plugins', 'Create your plugin',
    ])
    expect(b.view.getAllByRole('separator')).toHaveLength(1)
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Unpin from left sidebar: Notes' }))
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Pin to left sidebar: Tasks' }))
    expect(b.onPinnedChange).toHaveBeenNthCalledWith(1, 'notes', false)
    expect(b.onPinnedChange).toHaveBeenNthCalledWith(2, 'tasks', true)
    expect(b.onDismiss).not.toHaveBeenCalled()
    expect(b.onOpen).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Tasks' }))
    expect(b.onDismiss).toHaveBeenCalledOnce()
    expect(b.onOpen).toHaveBeenCalledExactlyOnceWith('tasks')
    expect(b.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(b.onOpen.mock.invocationCallOrder[0]!)
  })

  it.each([
    ['conversation', 'Pin to conversation tabs: Tasks'],
    ['rightbar', 'Pin to right sidebar: Tasks'],
  ] as const)('names the %s pin destination', (region, name) => {
    const { view } = content({ region })
    expect(view.getByRole('menuitem', { name })).toBeTruthy()
  })

  it('keeps only the discovery and Creator actions, without a separator, for an empty roster', () => {
    const b = content({ entries: [], region: 'rightbar' })
    expect(b.view.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Browse other plugins', 'Create your plugin'])
    expect(b.view.queryByRole('separator')).toBeNull()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Browse other plugins' }))
    expect(b.browsePlugins).toHaveBeenCalledExactlyOnceWith()
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Create your plugin' }))
    expect(b.createPlugin).toHaveBeenCalledExactlyOnceWith()
    expect(b.onDismiss).toHaveBeenCalledTimes(2)
  })

  it('shows the pin hint after the shared tooltip delay outside the menu card', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(any-hover: hover)' })))
    const { view } = content()
    const unpin = view.getByRole('menuitem', { name: 'Unpin from left sidebar: Notes' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.pointerEnter(unpin, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(499) })
    expect(view.queryByRole('tooltip', { hidden: true })).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(view.getByRole('tooltip', { hidden: true }).closest('[role="menu"]')).toBeNull()
    fireEvent.pointerLeave(unpin, { pointerType: 'mouse' })
  })
})

function Frame({ renderSlot }: PropsRenderSlots<Seats>) {
  const [pinned, setPinned] = useState(true)
  const [opened, setOpened] = useState('')
  const entries = [{ id: 'notes', label: 'Notes', pinned }]
  return <>
    {SEATS.map(seat => <div key={seat} role="menu" aria-label={seat}>
      {renderSlot(seat, {
        entries,
        onOpen: (id) => { setOpened(`${seat}:${id}`) },
        onPinnedChange: (_id, next) => { setPinned(next) },
        onDismiss: () => {},
      })}
    </div>)}
    <output data-testid="opened">{opened}</output>
  </>
}

async function bench(
  language: 'en' | 'zh' = 'en',
  { analytics = true, navigation = true }: { analytics?: boolean; navigation?: boolean } = {},
) {
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  const openList = vi.fn(), startSession = vi.fn(), track = vi.fn<TrackProductEvent>()
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      const locale = new LocaleRuntime(ctx)
      locale.setLocale(language)
      ctx.provide('locale', locale)
      ctx.slots.installLocale(locale)
      if (navigation) ctx.provide('pluginNavigation', { openList } as never)
      ctx.provide('uiWorkspace', { startSession } as never)
      if (analytics) ctx.provide('productAnalytics', { track } as never)
    },
  })
  await runtime.root.declare({
    'sidebar.panellist.actions': { kind: 'list', scope: 'root' },
    'conversation.session.header.views.actions': { kind: 'list', scope: 'root' },
    'sidebar.right.tab.guide.actions': { kind: 'list', scope: 'root' },
  }, Frame)
  const plugin = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  return { runtime, openList, startSession, track, plugin, view }
}

describe('More menu registrations', () => {
  it('shows plugin discovery only while the Plugins page navigation is present', async () => {
    const b = await bench('en', { navigation: false })
    const sidebar = () => within(b.view.getByRole('menu', { name: 'sidebar.panellist.actions' }))
    expect(sidebar().queryByRole('menuitem', { name: 'Browse other plugins' })).toBeNull()
    expect(sidebar().getByRole('menuitem', { name: 'Create your plugin' })).toBeTruthy()
    // The Creator row takes the separator the absent discovery row would carry.
    expect(sidebar().getAllByRole('separator')).toHaveLength(1)
    const injected = b.runtime.slots.entries('sidebar.panellist.actions')[0]!.inject!() as { browsePlugins: () => void }
    expect(() => { injected.browsePlugins() }).not.toThrow()

    const navigation = await b.runtime.mount({
      inject: [],
      apply(ctx: Context) { ctx.provide('pluginNavigation', { openList: b.openList } as never) },
    })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(sidebar().getByRole('menuitem', { name: 'Browse other plugins' }))
    expect(b.openList).toHaveBeenCalledExactlyOnceWith()

    await navigation.dispose()
    await act(async () => { await Promise.resolve() })
    expect(sidebar().queryByRole('menuitem', { name: 'Browse other plugins' })).toBeNull()
  })

  it('registers one row set per region and removes all of them when the plugin unloads', async () => {
    const b = await bench()
    for (const seat of SEATS) {
      expect(b.runtime.slots.entries(seat).map(entry => entry.options.id)).toEqual(['entry-customization'])
      expect(within(b.view.getByRole('menu', { name: seat })).getByRole('menuitem', { name: 'Notes' })).toBeTruthy()
    }
    const sidebar = within(b.view.getByRole('menu', { name: 'sidebar.panellist.actions' }))
    fireEvent.click(sidebar.getByRole('menuitem', { name: 'Unpin from left sidebar: Notes' }))
    expect(within(b.view.getByRole('menu', { name: 'sidebar.right.tab.guide.actions' }))
      .getByRole('menuitem', { name: 'Pin to right sidebar: Notes' })).toBeTruthy()
    fireEvent.click(within(b.view.getByRole('menu', { name: 'conversation.session.header.views.actions' }))
      .getByRole('menuitem', { name: 'Notes' }))
    expect(b.view.getByTestId('opened').textContent).toBe('conversation.session.header.views.actions:notes')
    fireEvent.click(sidebar.getByRole('menuitem', { name: 'Browse other plugins' }))
    expect(b.openList).toHaveBeenCalledExactlyOnceWith()
    await b.plugin.dispose()
    for (const seat of SEATS) {
      expect(b.runtime.slots.entries(seat)).toEqual([])
      expect(within(b.view.getByRole('menu', { name: seat })).queryByRole('menuitem')).toBeNull()
    }
  })

  it.each([
    ['en', 'sidebar.panellist.actions', 'Create a DSH plugin with a left sidebar entry.'],
    ['en', 'conversation.session.header.views.actions', 'Create a DSH conversation view plugin.'],
    ['en', 'sidebar.right.tab.guide.actions', 'Create a DSH plugin with a right sidebar entry.'],
    ['zh', 'sidebar.panellist.actions', '创建一个带左侧栏入口的 DSH 插件。'],
    ['zh', 'conversation.session.header.views.actions', '创建一个 DSH 会话视图插件。'],
    ['zh', 'sidebar.right.tab.guide.actions', '创建一个带右侧栏入口的 DSH 插件。'],
  ] as const)('starts an unsent %s Creator draft from %s', async (language, seat, prompt) => {
    const b = await bench(language)
    fireEvent.click(within(b.view.getByRole('menu', { name: seat }))
      .getByRole('menuitem', { name: language === 'zh' ? '创建你的插件' : 'Create your plugin' }))
    expect(b.startSession).toHaveBeenCalledExactlyOnceWith(undefined, {
      agentPreset: 'cordis', prompt, whenDraftExists: 'append',
    })
  })

  it.each([
    ['sidebar.panellist.actions', 'sidebar'],
    ['conversation.session.header.views.actions', 'conversation'],
    ['sidebar.right.tab.guide.actions', 'rightbar'],
  ] as const)('reports both footer actions of %s as the %s region before acting', async (seat, region) => {
    const b = await bench()
    const menu = within(b.view.getByRole('menu', { name: seat }))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Browse other plugins' }))
    expect(b.track).toHaveBeenCalledExactlyOnceWith('more_menu_item_click', { region, action: 'browse_plugins' })
    expect(b.track.mock.invocationCallOrder[0]).toBeLessThan(b.openList.mock.invocationCallOrder[0]!)
    fireEvent.click(menu.getByRole('menuitem', { name: 'Create your plugin' }))
    expect(b.track).toHaveBeenLastCalledWith('more_menu_item_click', { region, action: 'create_plugin' })
    expect(b.track.mock.invocationCallOrder[1]).toBeLessThan(b.startSession.mock.invocationCallOrder[0]!)
    expect(b.track).toHaveBeenCalledTimes(2)
  })

  it('reports neither entry opening nor pin changes', async () => {
    const b = await bench()
    const menu = within(b.view.getByRole('menu', { name: 'sidebar.panellist.actions' }))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Unpin from left sidebar: Notes' }))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Notes' }))
    expect(b.view.getByTestId('opened').textContent).toBe('sidebar.panellist.actions:notes')
    expect(b.track).not.toHaveBeenCalled()
  })

  it('keeps both footer actions working without the analytics service', async () => {
    const b = await bench('en', { analytics: false })
    const menu = within(b.view.getByRole('menu', { name: 'sidebar.right.tab.guide.actions' }))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Browse other plugins' }))
    fireEvent.click(menu.getByRole('menuitem', { name: 'Create your plugin' }))
    expect(b.openList).toHaveBeenCalledExactlyOnceWith()
    expect(b.startSession).toHaveBeenCalledOnce()
    expect(b.track).not.toHaveBeenCalled()
  })
})
