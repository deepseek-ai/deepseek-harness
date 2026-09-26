// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ReactNode } from 'react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { HeaderLeadingControls, type HeaderLeadingControlsProps } from '../src/client/HeaderLeadingControls.tsx'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const t: SidebarRootComponentProps['t'] = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.platform
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mountShell({ collapsed = false, width = 300, shortcuts = [] }: {
  collapsed?: boolean
  width?: number
  shortcuts?: readonly ShortcutCatalogEntry[]
} = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  const brandMark = <span data-testid="custom-brand-mark">M</span>
  const brandName = <span data-testid="custom-brand-name">Custom Brand</span>
  let current = { collapsed, width }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector(shortcuts)}
      useResource={useResource} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar} t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.brand.mark') return brandMark
        if (key === 'sidebar.brand.name') return brandName
        if (key === 'sidebar.toggle.badge') return null
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('advertises the effective new-session binding', () => {
    const shortcut: ShortcutCatalogEntry = { id: 'session.new' as ShortcutCommandId, label: 'New', aliases: [],
      binding: null, modified: true, conflicts: [], issue: null, keys: ['Ctrl', 'N'], aria: 'Control+N' }
    mountShell({ shortcuts: [shortcut] })
    for (const button of screen.getAllByRole('button', { name: 'New session' })) {
      expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+N')
    }
    const expanded = screen.getAllByRole('button', { name: 'New session' }).find(button => button.querySelector('kbd') !== null)!
    fireEvent.mouseEnter(expanded)
    fireEvent.focus(expanded)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(Array.from(expanded.querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'N'])
    cleanup()
    render(<HeaderLeadingControls toggleSidebar={vi.fn()} startSession={vi.fn()} selectPanel={vi.fn()} t={t}
      usePanelInfo={neverHook} useSessions={neverHook} useSessionStatus={neverHook}
      useSessionRetainInfo={neverHook} useResource={useResource} useWorkspaces={neverHook}
      usePanels={select => select([])} useShortcuts={select => select([shortcut])} />)
    const button = screen.getByRole('button', { name: 'New session' })
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+N')
    fireEvent.focus(button)
    expect(Array.from(screen.getByRole('tooltip').querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'N'])
  })
  it('routes New Session (capsule + wordmark) and the column toggle', () => {
    const b = mountShell()
    expect(screen.getByTestId('custom-brand-mark')).toBeTruthy()
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    // Expanded, both the wordmark and the capsule start a session.
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(2)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders generic brand fallbacks when no package fills the slots', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    vi.stubEnv('DSH_CLIENT_GIT_DIRTY', 'true')
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3-rc.4')
    const { container } = render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.getByText('DSH Local Build')).toBeTruthy()
    expect(screen.getByText('1.2.3-rc.4-0123456-dirty')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it.each([
    [{ DSH_CLIENT_VERSION: '1.2.3' }, '1.2.3'],
    [{ DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_VERSION: '1.2.3' }, '1.2.3-abcdef0'],
  ])('omits unavailable build-version suffixes from %j', (environment, expected) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value)
    render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.getByText('DSH Local Build')).toBeTruthy()
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('retains the local-build fallback without complete build metadata', () => {
    render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.getByText('DSH Local Build')).toBeTruthy()
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // The settings seat rides the same wide flag (ui-settings renders the row).
    expect(b.settingsOwner().wide).toBe(true)
    expect(b.footerActionOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window, then settles into the rail.
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    expect(b.footerActionOwner().wide).toBe(false)
    expect(screen.getByTestId('region')).toBeTruthy()
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('shows only the badge bubble while the rail badge is hovered inside the toggle', () => {
    vi.useFakeTimers()
    render(<SidebarRoot
      collapsed width={56}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((key: string) => key === 'sidebar.toggle.badge'
        ? <Tooltip label="Update — V1.2.3"><span data-testid="badge" /></Tooltip>
        : null) as SidebarRootComponentProps['renderSlot']}
    />)
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    fireEvent.mouseEnter(toggle)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
    // The badge's own bubble replaces the toggle's rather than stacking on it,
    // even after the toggle's longer hover delay has elapsed.
    fireEvent.mouseEnter(screen.getByTestId('badge'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getAllByRole('tooltip').map(bubble => bubble.textContent)).toEqual(['Update — V1.2.3'])
    fireEvent.mouseLeave(screen.getByTestId('badge'), { relatedTarget: toggle })
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
    fireEvent.mouseLeave(toggle)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

it('keeps the macOS sidebar toggle in its top strip', () => {
  document.documentElement.dataset.platform = 'darwin'
  const shell = mountShell()
  fireEvent.click(screen.getByRole('button', { name: en['toggle.collapse'] }))
  expect(shell.toggleSidebar).toHaveBeenCalledOnce()
  // The brand stays part of the logo row's window-drag surface: no button
  // role (the global no-drag rule would subtract it); only the dedicated
  // New Session capsule starts a session.
  expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
  expect(screen.getByTestId('custom-brand-mark')).toBeTruthy()
})

it('wires the shell.leading controls to the shared sidebar actions', () => {
  const toggleSidebar = vi.fn()
  const startSession = vi.fn()
  // This occupant only consumes its two actions and locale, not Session hooks.
  const props = { toggleSidebar, startSession, t, useShortcuts: select => select([{ id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle sidebar', aliases: [], binding: null, modified: false, conflicts: [], issue: null, keys: ['⌘', 'B'], aria: 'Meta+B' }]) } as HeaderLeadingControlsProps
  render(<HeaderLeadingControls {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en['toggle.open'] }))
  fireEvent.click(screen.getByRole('button', { name: en['session.new.label'] }))
  expect(toggleSidebar).toHaveBeenCalledOnce()
  expect(startSession).toHaveBeenCalledOnce()
})

describe('Windows caption tooltips', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-windows-titlebar') })

  const hover = (button: HTMLElement): void => {
    fireEvent.mouseEnter(button)
    act(() => { vi.advanceTimersByTime(500) })
  }

  it.each([false, true])(
    'drops the sidebar toggle bubble below the caption (collapsed=%s)',
    (collapsed) => {
      vi.useFakeTimers()
      document.documentElement.setAttribute('data-windows-titlebar', '')
      mountShell({ collapsed, width: collapsed ? 0 : 300 })
      hover(screen.getByRole('button', { name: collapsed ? 'Open sidebar' : 'Collapse sidebar' }))
      expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('bottom')
    },
  )

  it('drops the collapsed New Session bubble below the caption as well', () => {
    vi.useFakeTimers()
    document.documentElement.setAttribute('data-windows-titlebar', '')
    mountShell({ collapsed: true, width: 0 })
    hover(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('bottom')
  })

  it('keeps the ordinary Web bubble beside its anchor', () => {
    vi.useFakeTimers()
    mountShell({ collapsed: true, width: 0 })
    hover(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('right')
  })
})

it('uses the same effective sidebar binding for hover/focus hints and ARIA', () => {
  const shortcut = { id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle sidebar', aliases: [], binding: null, modified: false, conflicts: [], issue: null, keys: ['⌘', 'B'], aria: 'Meta+B' }
  mountShell({ shortcuts: [shortcut] })
  const toggle = screen.getByRole('button', { name: en['toggle.collapse'] })
  expect(toggle.getAttribute('aria-keyshortcuts')).toBe('Meta+B')
  fireEvent.focus(toggle)
  expect(Array.from(screen.getByRole('tooltip').querySelectorAll('kbd'), key => key.textContent)).toEqual(['⌘', 'B'])
})
