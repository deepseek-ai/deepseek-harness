// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  SessionListState, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  DetailsSlotProps, DetailsToolOwnerProps, RunningToolCall, SelectionTarget,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsLine } from '../src/client/chat/StatsLine.tsx'
import { DetailsPanel } from '../src/client/details/DetailsPanel.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

/** jsdom has no ResizeObserver; StatsLine watches its row for ellipsis truncation through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub) })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SID = 's1' as SessionId

/** Minimal framework seat for direct DetailsPanel host tests. */
const SessionProviderStub: SessionProviderComponent = ({ children }) => children

/** Observe the owner currency without importing the Tool details renderer. */
function renderToolDetailsProbe(owners?: DetailsToolOwnerProps[]): DetailsSlotProps['renderSlot'] {
  return (_key, owner) => {
    owners?.push(owner as unknown as DetailsToolOwnerProps)
    return <div data-testid="tool-details-seat" />
  }
}

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: SID,
    queue: [],
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
  }
}

function emptyWorkspaces() {
  return createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
}

describe('render branch tails', () => {
  it('AssistantMarkdown reasoning row is ok-state when not the streaming tail', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'done thinking' }, { kind: 'text', text: 'answer' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    // reasoning at index 0 with a later block: running is false → ok state.
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('StatsLine falls back to window-node counts and drops every token group without projections', () => {
    // No sessionStats key → the window fold supplies the counts (the
    // assembly-without-the-unit fallback). Node `usage` is deliberately
    // ignored: billing rides the durable tokenUsage projection, so an absent
    // projection leaves counts only.
    const nodes = [
      { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] },
      { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 2, blocks: [], usage: { inputTokens: 4, outputTokens: 6 } },
      { kind: 'assistant', seq: 3, time: 3, turn: 2, step: 1, blocks: [], usage: { inputTokens: 5 } },
    ] as const
    const snap = chatSnapshotFixture({ nodes })
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsLine
        t={t}
        useChat={bindSnapshotSelector(source)}
        useProjection={() => undefined}
      />,
    )
    expect(view.container.textContent).toBe('2 轮 · 3 步')
  })

  it('AssistantMarkdown reasoning as the streaming tail renders the running ring', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'still thinking' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('DetailsPanel title falls to 详情 when the selection has no toolName and no material', () => {
    localStorage.clear()
    const session = sessionSnapshot()
    const chatSnapshot = chatSnapshotFixture()
    const chat = createChatStore().create()
    chat.actions.select({ turnSeq: 1, callId: 'ghost' } satisfies SelectionTarget)
    const emptyList = createSnapshotStore<SessionListState>(
      { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
    const workspaces = emptyWorkspaces()
    const view = render(
      <DetailsPanel
        SessionProvider={SessionProviderStub}
        renderSlot={renderToolDetailsProbe()}
        sessionId={SID}
        useSession={bindSnapshotSelector(createSnapshotStore(session))}
        useChat={bindSnapshotSelector(createSnapshotStore(chatSnapshot))}
        useConversation={bindSnapshotSelector(createSnapshotStore(EMPTY_CONVERSATION_SNAPSHOT))}
        useTrajectory={(() => { throw new Error('unused') })}
        useSessions={bindSnapshotSelector(emptyList)}
        useSessionPendingInteraction={bindSnapshotSelector(
          createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
        )}
        useWorkspaces={bindSnapshotSelector(workspaces)}
        useProjection={(() => undefined)}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{
          setDraft: () => {},
          addAttachments: () => true,
          removeAttachment: () => {},
          pruneAttachments: () => {},
          submit: () => {},
        }}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
        t={t}
      />,
    )
    expect(view.getByText('详情')).toBeTruthy()
    expect(view.getByText('该调用不在当前窗口内')).toBeTruthy()
  })

  it('DetailsPanel passes the existing parentCallId through to the Tool details seat', () => {
    localStorage.clear()
    const session = sessionSnapshot()
    const longText = 'x'.repeat(1_000)
    const runningCalls: readonly RunningToolCall[] = [{
      callId: 'p1', name: 'run_code', argsRaw: '{}', turn: 1, step: 1,
      time: 7_000, subCalls: [{
        kind: 'tool-result', seq: 8, time: 8_000, callId: 'p1:code:1',
        parentCallId: 'p1',
        call: { name: 'run_code', argsRaw: '{"code":"return 1"}' },
        callTime: 8_000,
        content: [], isError: false,
        subCalls: [{
          kind: 'tool-result', seq: 9, time: 9_000, callId: 'p1:code:1:code:1',
          parentCallId: 'p1:code:1',
          call: { name: 'read', argsRaw: '{"path":"notes/demo.txt"}' },
          callTime: 8_500,
          content: [{ type: 'text', text: longText }], isError: false,
          subCalls: [],
        }],
      }],
    }]
    const chatSnapshot = chatSnapshotFixture({ runningCalls })
    const chat = createChatStore().create()
    chat.actions.select({ turnSeq: 9, callId: 'p1:code:1:code:1', toolName: 'read' } satisfies SelectionTarget)
    const emptyList = createSnapshotStore<SessionListState>(
      { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
    const workspaces = emptyWorkspaces()
    const owners: DetailsToolOwnerProps[] = []
    const view = render(
      <DetailsPanel
        SessionProvider={SessionProviderStub}
        renderSlot={renderToolDetailsProbe(owners)}
        sessionId={SID}
        useSession={bindSnapshotSelector(createSnapshotStore(session))}
        useChat={bindSnapshotSelector(createSnapshotStore(chatSnapshot))}
        useConversation={bindSnapshotSelector(createSnapshotStore(EMPTY_CONVERSATION_SNAPSHOT))}
        useTrajectory={(() => { throw new Error('unused') })}
        useSessions={bindSnapshotSelector(emptyList)}
        useSessionPendingInteraction={bindSnapshotSelector(
          createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
        )}
        useWorkspaces={bindSnapshotSelector(workspaces)}
        useProjection={(() => undefined)}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{
          setDraft: () => {},
          addAttachments: () => true,
          removeAttachment: () => {},
          pruneAttachments: () => {},
          submit: () => {},
        }}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
        t={t}
      />,
    )
    // Chat resolves the selected sub-call and keeps its Code Dispatch parent
    // identity on the block handed to the Tool-owned details seat.
    expect(view.getByText('read')).toBeTruthy()
    expect(view.getByTestId('tool-details-seat')).toBeTruthy()
    expect(owners).toHaveLength(1)
    expect(owners[0]?.block).toMatchObject({
      callId: 'p1:code:1:code:1',
      parentCallId: 'p1:code:1',
      call: { name: 'read', argsRaw: '{"path":"notes/demo.txt"}' },
      content: [{ type: 'text', text: longText }],
    })
  })
})
