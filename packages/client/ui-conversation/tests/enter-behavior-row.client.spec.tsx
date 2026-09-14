// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EnterBehaviorRow } from '../src/client/settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowProps } from '../src/client/settings/EnterBehaviorRow.tsx'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import { en } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  localStorage.clear()
})

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

function mount() {
  const policy = new ComposerSubmissionPolicy()
  const setBusyEnter = vi.fn((behavior: 'queue' | 'steer') => { policy.setBusyEnter(behavior) })
  const props: EnterBehaviorRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionPendingInteraction: noPendingInteraction(),
    useResource,
    useWorkspaces: emptyWorkspaces(),
    useBusyEnter: bindSnapshotSelector(policy.busyEnter),
    setBusyEnter,
    t: makeTranslate(en),
  }
  render(<EnterBehaviorRow {...props} />)
  return { policy, setBusyEnter }
}

describe('EnterBehaviorRow', () => {
  it('explains the busy-only scope over Enter and Send and shows Queue by default', () => {
    mount()
    expect(screen.getByText('Send behavior while busy')).toBeDefined()
    expect(screen.getByText('What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behavior')).toBeDefined()
    expect(screen.getByRole('button', { name: /Queue/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('selects Steer, follows later preference changes, and closes outside', () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: /Queue/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Steer' }))
    expect(b.setBusyEnter).toHaveBeenCalledWith('steer')
    expect(screen.getByRole('button', { name: /Steer/ })).toBeDefined()

    act(() => { b.policy.setBusyEnter('queue') })
    const queueTrigger = screen.getByRole('button', { name: /Queue/ })
    fireEvent.click(queueTrigger)
    expect(screen.getByRole('menuitem', { name: 'Steer' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Steer' })).toBeNull()
  })
})
