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
import { createFontSizeRowStore } from '../src/client/settings-store.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
}

/** Empty global standard-kit hooks (the row reads neither). */
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

type AttentionSnapshot = Parameters<Parameters<FontSizeRowComponentProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: FontSizeRowComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount(fontSize = 14) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createFontSizeRowStore().create()
  store.actions.sync(fontSize, 0)
  const setFontSize = vi.fn()
  const props: FontSizeRowComponentProps = {
    useSessions: emptySessions(),
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
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
    act(() => { b.store.actions.sync(15, 1) })
    expect(screen.getByText('15')).toBeDefined()
    fireEvent.click(arrow('Decrease font size'))
    expect(b.setFontSize).toHaveBeenCalledWith(14)
  })

  it('disables the outward arrow at each bound', () => {
    mount(17)
    expect(arrow('Increase font size').disabled).toBe(true)
    expect(arrow('Decrease font size').disabled).toBe(false)
    cleanup()
    mount(12)
    expect(arrow('Increase font size').disabled).toBe(false)
    expect(arrow('Decrease font size').disabled).toBe(true)
  })
})
