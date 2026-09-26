// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { GeneralSectionComponentProps } from '../src/client/GeneralSection.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import type { TriggerContentProps } from '../src/client/chrome.tsx'
import { SettingsDocumentAction } from '../src/client/SettingsDocumentAction.tsx'
import { DeveloperToolsRow } from '../src/client/DeveloperToolsRow.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsDocumentStore } from '../src/client/settings-document-store.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** Store over a real mirror derived from the same scripted context. */
function derivedDocumentStore(remote: object) {
  const ctx = { remote } as never
  return new SettingsDocumentStore(ctx, new SettingsDescribeMirror(ctx))
}
import { en, zh } from '../src/client/locales.ts'
import { CurrentVersionRow } from '../src/client/CurrentVersionRow.tsx'
import { DesktopUpdateBadge } from '../src/client/DesktopUpdateIndicator.tsx'
import type { DesktopUpdateView } from '../src/types.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

// The seat's key domain is settings ∪ common; the stub answers from the
// package dictionary and falls back to the key like the real chain.
const t: TriggerContentProps['t'] = key => (en as Record<string, string>)[key] ?? key

// Global standard kit stubs: none of these components consume the hooks.
const unusedHook = (() => { throw new Error('unused by settings-general components') }) as never
type AttentionSnapshot = Parameters<Parameters<TriggerContentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: TriggerContentProps['useSessionStatus'] = selector => selector(noAttention)
const kit = {
  useSessions: unusedHook, useSessionStatus,
  usePanelInfo, useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
}

describe('Desktop collapsed update badge', () => {
  it('shows update and retry status and yields to connection feedback', () => {
    let state: DesktopUpdateView = { failed: false, opening: false }
    let connection: 'connected' | 'connecting' | 'disconnected' = 'connected'
    const props = { ...kit, t,
      useDesktopUpdate: (select => select(state)) as Parameters<typeof DesktopUpdateBadge>[0]['useDesktopUpdate'],
      useConnectionState: (select => select(connection)) as Parameters<typeof DesktopUpdateBadge>[0]['useConnectionState'],
    }
    const view = render(<DesktopUpdateBadge {...props} />)
    expect(screen.queryByRole('img')).toBeNull()
    state = { ...state, presentation: { phase: 'available', version: '1.0.1' } }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: 'Update' })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    state = { ...state, failed: true }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    state = { failed: true, opening: false }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    state = { failed: false, opening: false, presentation: { phase: 'error', failure: 'install' } }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    for (const value of ['connecting', 'disconnected'] as const) {
      connection = value
      view.rerender(<DesktopUpdateBadge {...props} />)
      expect(screen.queryByRole('img')).toBeNull()
    }
  })
})

it('toggles developer tools using the accepted setting and disables duplicate writes', async () => {
  const state = createSnapshotStore(false)
  let finish!: () => void
  const setEnabled = vi.fn((enabled: boolean) => new Promise<void>((resolve) => {
    finish = () => { state.set(enabled); resolve() }
  }))
  render(<DeveloperToolsRow {...kit} t={t} useDeveloperTools={bindSnapshotSelector(state)} setEnabled={setEnabled} />)
  const toggle = screen.getByRole('switch', { name: 'Coding Tools' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(setEnabled).toHaveBeenCalledWith(true)
  expect(toggle.hasAttribute('disabled')).toBe(true)
  finish()
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
  expect(toggle.hasAttribute('disabled')).toBe(false)
})

describe('chrome content', () => {
  it('TriggerContent renders the icon with the label in the wide column', () => {
    const { container } = render(<TriggerContent {...kit} wide t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('TriggerContent drops the label in the rail state', () => {
    const { container } = render(<TriggerContent {...kit} wide={false} t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('HeaderContent and CloseLabel render their translated text', () => {
    render(<HeaderContent {...kit} t={t} />)
    render(<CloseLabel {...kit} t={t} />)
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })
})

describe('GeneralSection', () => {
  function mount() {
    const renderSlot = vi.fn(
      ((key: string) => <div data-testid={`slot-${key}`} />) as GeneralSectionComponentProps['renderSlot'],
    )
    const props: GeneralSectionComponentProps = { ...kit, renderSlot, close: vi.fn() }
    const view = render(<GeneralSection {...props} />)
    return { view, renderSlot }
  }

  it('renders the item slot as the section body', () => {
    const { renderSlot } = mount()
    expect(renderSlot).toHaveBeenCalledWith('settings.general.item', {})
    expect(screen.getByTestId('slot-settings.general.item')).toBeTruthy()
  })
})

describe('SettingsDocumentAction', () => {
  it('appears only for a file-backed provider and requests its Host-owned document', async () => {
    const openDocument = vi.fn(() => Promise.resolve({
      ok: true as const, value: { opened: true as const },
    }))
    const controller = derivedDocumentStore({
      settings: {
        describe: vi.fn(() => Promise.resolve({
          ok: true as const,
          value: { writable: true, hasDocument: true, namespaces: [] },
        })),
        openSettingsDocument: openDocument,
      },
    })
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    const action = await screen.findByRole('button', { name: 'Open configuration file' })
    fireEvent.click(action)
    await waitFor(() => { expect(openDocument).toHaveBeenCalledWith() })
  })

  it('stays absent without a document and follows a mirror refresh to available', async () => {
    const describe = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [] } })
      .mockResolvedValueOnce({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } })
    const ctx = { remote: { settings: { describe, openSettingsDocument: vi.fn() } } } as never
    const mirror = new SettingsDescribeMirror(ctx)
    const controller = new SettingsDocumentStore(ctx, mirror)
    const first = render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('unavailable') })
    expect(screen.queryByRole('button', { name: 'Open configuration file' })).toBeNull()
    first.unmount()
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    // A remount alone re-reads nothing; availability moves with the mirror's
    // own refresh (a document commit or reconnect in production).
    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('unavailable') })
    expect(describe).toHaveBeenCalledTimes(1)
    await mirror.load()
    expect(await screen.findByRole('button', { name: 'Open configuration file' })).toBeTruthy()
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('keeps the action available and reports a native-open failure', async () => {
    const controller = derivedDocumentStore({
      settings: {
        describe: vi.fn(() => Promise.resolve({
          ok: true as const,
          value: { writable: true, hasDocument: true, namespaces: [] },
        })),
        openSettingsDocument: vi.fn(() => Promise.resolve({
          ok: false as const,
          error: new RemoteError('gateway/internal', 'xdg-open missing', {}),
        })),
      },
    })
    render(<SettingsDocumentAction
      {...kit}
      t={t}
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
    />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open configuration file' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Could not open configuration file')
    expect(screen.getByRole('button', { name: 'Open configuration file' })).toBeTruthy()
  })
})

it('reports a failed developer-tool write and allows retry', async () => {
  const state = createSnapshotStore(false)
  const setEnabled = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async (enabled: boolean) => { state.set(enabled) })
  render(<DeveloperToolsRow {...kit} t={t} useDeveloperTools={bindSnapshotSelector(state)} setEnabled={setEnabled} />)
  const toggle = screen.getByRole('switch', { name: 'Coding Tools' })
  fireEvent.click(toggle)
  expect((await screen.findByRole('alert')).textContent).toBe('Could not save. Please try again.')
  expect(toggle.hasAttribute('disabled')).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
  expect(screen.queryByRole('alert')).toBeNull()
})

describe('current version', () => {
  it.each([
    ['Current version: 1.2.3-rc.4', en],
    ['当前版本：1.2.3-rc.4', zh],
  ])('renders the localized release label %s', (expected, dictionary) => {
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3-rc.4')
    const translate: TriggerContentProps['t'] = (key, params) => {
      let text = (dictionary as Record<string, string>)[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
      return text
    }
    render(<CurrentVersionRow {...kit} t={translate} />)
    expect(screen.getByText(expected)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('omits the row when a partial build has no version metadata', () => {
    vi.stubEnv('DSH_CLIENT_VERSION', undefined)
    const view = render(<CurrentVersionRow {...kit} t={t} />)
    expect(view.container.textContent).toBe('')
  })
})
