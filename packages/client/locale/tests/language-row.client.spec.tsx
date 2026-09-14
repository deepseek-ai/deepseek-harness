// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { LanguageRow } from '../src/client/LanguageRow.tsx'
import type { LanguageRowComponentProps } from '../src/client/LanguageRow.tsx'
import { createLanguageRowStore } from '../src/client/settings-store.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const OPTIONS = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<LanguageRowComponentProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: LanguageRowComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount(active = 'en') {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createLanguageRowStore().create()
  store.actions.sync(active, OPTIONS, 0)
  const setLocale = vi.fn()
  const props: LanguageRowComponentProps = {
    useSessions: emptySessions(),
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => key === 'language.title' ? 'Language' : key,
    setLocale,
  }
  render(<LanguageRow {...props} />)
  return { store, setLocale }
}

describe('LanguageRow', () => {
  it('shows the title and the active locale label on the selector pill', () => {
    mount('en')
    expect(screen.getByText('Language')).toBeDefined()
    const trigger = screen.getByRole('button', { name: /English/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the menu, selects a locale, and closes', () => {
    const b = mount('en')
    const trigger = screen.getByRole('button', { name: /English/ })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: '中文' }))
    expect(b.setLocale).toHaveBeenCalledWith('zh')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: '中文' })).toBeNull()
  })

  it('closes on outside pointerdown without selecting', () => {
    const b = mount('en')
    fireEvent.click(screen.getByRole('button', { name: /English/ }))
    expect(screen.getByRole('menuitem', { name: '中文' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: '中文' })).toBeNull()
    expect(b.setLocale).not.toHaveBeenCalled()
  })

  it('follows store changes; an unknown active id falls back to the id itself', () => {
    const b = mount('en')
    act(() => { b.store.actions.sync('zh', OPTIONS, 1) })
    expect(screen.getByRole('button', { name: /中文/ })).toBeDefined()
    act(() => { b.store.actions.sync('fr', OPTIONS, 2) })
    expect(screen.getByRole('button', { name: /fr/ })).toBeDefined()
  })
})
