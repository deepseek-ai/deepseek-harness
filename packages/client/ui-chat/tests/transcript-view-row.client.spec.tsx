// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()))
}

// The resource hook the resources plugin merges into GlobalStandardProps; this row reads no address.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function mount(mode: 'normal' | 'compact' = 'compact', dictionary: typeof en | typeof zh = en) {
  const source = createSnapshotStore(mode)
  const setTranscriptView = vi.fn((next: 'normal' | 'compact') => { source.set(next) })
  const props: TranscriptViewRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionPendingInteraction: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useResource,
    useTranscriptView: bindSnapshotSelector(source),
    setTranscriptView,
    t: makeTranslate(dictionary),
  }
  render(<TranscriptViewRow {...props} />)
  return { setTranscriptView }
}

describe('TranscriptViewRow', () => {
  it('explains the preference and shows Compact by default', () => {
    mount()
    expect(screen.getByText('Conversation display')).toBeDefined()
    expect(screen.getByText('Controls process content in completed turns')).toBeDefined()
    expect(screen.getByRole('button', { name: /Compact/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('selects Normal and follows the mirrored value', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Compact/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Normal' }))
    expect(b.setTranscriptView).toHaveBeenCalledWith('normal')
    const trigger = screen.getByRole('button', { name: /Normal/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Compact' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Compact' })).toBeNull()
  })

  it('shows the conversation-display values in Chinese', () => {
    mount('compact', zh)
    fireEvent.click(screen.getByRole('button', { name: '紧凑' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '标准' }))
    expect(screen.getByRole('button', { name: '标准' })).toBeDefined()
  })
})
