// @vitest-environment jsdom
/** FontSizeRow behavior: value display, arrow clicks drive setFontSize,
 * bound-value arrows disable, display follows the store mirror. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import type { FontSizeRowComponentProps } from '../src/client/FontSizeRow.tsx'
import { createFontRowStore } from '../src/client/settings-store.ts'
import type { FontRole } from '../src/theme-settings.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontSize.text.title': 'Font size',
  'fontSize.text.description': 'Only affects conversation content',
  'fontSize.text.increase': 'Increase font size',
  'fontSize.text.decrease': 'Decrease font size',
  'fontSize.terminal.increase': 'Increase terminal font size',
  'fontSize.terminal.decrease': 'Decrease terminal font size',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<FontSizeRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: FontSizeRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(fontSize = 14, role: FontRole = 'text') {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createFontRowStore().create()
  store.actions.sync({ text: 14, code: 11, terminal: 13, [role]: fontSize }, { text: '', code: '', terminal: '' }, 0)
  const setFontSize = vi.fn()
  const props: FontSizeRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    role,
    setFontSize,
  }
  render(<FontSizeRow {...props} />)
  return { store, setFontSize }
}

const arrow = (name: string): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

describe('FontSizeRow', () => {
  it('renders the title and the current size with both arrows enabled mid-range', () => {
    mount(14)
    expect(screen.getByText('Font size')).toBeDefined()
    expect(screen.getByText('Only affects conversation content')).toBeDefined()
    expect(screen.getByText('14')).toBeDefined()
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(false)
  })

  it('arrow clicks step by 1; display follows the store mirror, not the click echo', () => {
    const b = mount(14)
    fireEvent.click(arrow('Increase font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(15)
    // No store write yet: the display is unchanged.
    expect(screen.getByText('14')).toBeDefined()
    act(() => { b.store.actions.sync({ text: 15, code: 11, terminal: 13 }, { text: '', code: '', terminal: '' }, 1) })
    expect(screen.getByText('15')).toBeDefined()
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(14)
  })

  it('disables the outward arrow at each bound', () => {
    const b = mount(21)
    fireEvent.click(arrow('Increase font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(22)
    act(() => { b.store.actions.sync({ text: 22, code: 11, terminal: 13 }, { text: '', code: '', terminal: '' }, 1) })
    expect(screen.getByText('22')).toBeDefined()
    expect(arrow('Increase font size').disabled).toBe(true)
    expect(arrow('Decrease font size').disabled).toBe(false)
    cleanup()
    const c = mount(11)
    fireEvent.click(arrow('Decrease font size'))
    expect(c.setFontSize).toHaveBeenCalledWith(10)
    act(() => { c.store.actions.sync({ text: 10, code: 11, terminal: 13 }, { text: '', code: '', terminal: '' }, 1) })
    expect(screen.getByText('10')).toBeDefined()
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(true)
  })

  it('reads its own role and bounds from the shared store', () => {
    const b = mount(20, 'terminal')
    expect(screen.getByText('20')).toBeDefined()
    expect(arrow('Increase terminal font size').disabled).toBe(true)
    fireEvent.click(arrow('Decrease terminal font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(19)
  })
})
