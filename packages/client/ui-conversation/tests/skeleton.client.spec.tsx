// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  bindSnapshotSelector, makeTranslate, RemoteError, sessionSnapshot as sessionFixture,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { EMPTY_CONVERSATION_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import type { ConversationSnapshot } from '../src/client/contract/snapshot.ts'
import { createConversationStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { en, zh } from '../src/client/locales.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from '../src/client/skeleton/ConversationSession.tsx'
import { conversationPhase } from '../src/client/contract/snapshot.ts'
import { HeroShell } from '../src/client/skeleton/EmptyHero.tsx'
import type { HeroShellProps } from '../src/client/skeleton/EmptyHero.tsx'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import type {
  ComposerBarOwnerProps, ConversationHeaderLineageOwnerProps,
} from '../src/client/contract/slots.ts'
import type { ViewTab } from '../src/client/contract/views.ts'

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})

function fakeWiring() {
  const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const shell = new SessionInputShell({ actx: {} as Context, defaultSink: sink, commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` } })
  return { wiring: shell, sink, shell }
}

/** jsdom has no ResizeObserver; the root publishes its width and the composer
 * seat its height through one. Observed targets are recorded so a case can
 * fire the callback against a chosen element. */
const resizeObservers: { callback: ResizeObserverCallback; targets: Element[] }[] = []
class ResizeObserverStub {
  targets: Element[] = []
  constructor(callback: ResizeObserverCallback) {
    resizeObservers.push({ callback, targets: this.targets })
  }

  observe(target: Element): void { this.targets.push(target) }
  unobserve(): void {}
  disconnect(): void { this.targets.length = 0 }
}

/** Fires every recorded observer whose target list includes the element. */
function fireResize(el: Element): void {
  for (const entry of resizeObservers) {
    if (entry.targets.includes(el)) entry.callback([], undefined as never)
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resizeObservers.length = 0
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

const t: ConversationRootProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const SID = sid('s1')

type SessionSlotProps = ComponentProps<typeof ConversationSession>

const useChat: SessionSlotProps['useChat'] = () => { throw new Error('unused') }
const useTrajectory: SessionSlotProps['useTrajectory'] = () => { throw new Error('unused') }

function workspace(id = 'w1'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title: id, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})

function sessionSnapshotOf(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...sessionFixture(SID), ...overrides }
}

function mount(
  snapshot: SessionSnapshot,
  workspaceRows: WorkspaceView[] = [{ ...workspace('one'), sessionIds: [SID] }],
  retargetWorkspace = vi.fn(async (_workspaceId: WorkspaceId) => {}),
  options: {
    /** When true, mimic overlay:true chain siblings (hidden fallback + takeover). */
    overlayTakeover?: boolean
    /** The session list summary's `blank` flag — independent of the snapshot's. */
    summaryBlank?: boolean
    /** Drop the session's summary row entirely (a session the list has not caught up with). */
    omitSummaryRow?: boolean
    /** Classify the selected child as a subagent instead of an ordinary fork. */
    summaryOrigin?: 'subagent'
    /** Insert a first-level subagent between the root and selected child. */
    nestedSubagent?: boolean
    /** A composer block another plugin raised for this session. */
    composerBlock?: { reason: string }
    /** Mutable view ledger used by registration-order regressions. */
    viewTabs?: ViewTab[]
  } = {},
) {
  const root = sid('root')
  const parent = sid('parent')
  const rootRow = { id: root, displayTitle: 'Root', running: false, blank: false, updatedAt: 1 }
  const parentRow = {
    id: parent, displayTitle: 'Parent', parentId: root, origin: 'subagent' as const,
    running: false, blank: false, updatedAt: 2,
  }
  const childRow = {
    id: SID, displayTitle: 'Child', parentId: options.nestedSubagent === true ? parent : root,
    cwd: '/projects/one', running: false, blank: options.summaryBlank ?? false, updatedAt: 3,
    ...(options.summaryOrigin === undefined ? {} : { origin: options.summaryOrigin }),
  }
  const listed = options.omitSummaryRow !== true
  const sessions = createSnapshotStore<SessionListState>({
    ids: listed
      ? [root, ...options.nestedSubagent === true ? [parent] : [], SID]
      : [root],
    byId: {
      [root]: rootRow,
      ...listed && options.nestedSubagent === true && { [parent]: parentRow },
      ...listed && { [SID]: childRow },
    },
    current: SID,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>(workspaceState(workspaceRows))
  const session = createSnapshotStore<SessionSnapshot>(snapshot)
  const useSession = bindSnapshotSelector(session)
  const conversation = createSnapshotStore<ConversationSnapshot>(EMPTY_CONVERSATION_SNAPSHOT)
  const useConversation = bindSnapshotSelector(conversation)
  const useSessionPendingInteraction = bindSnapshotSelector(
    createSnapshotStore<SessionPendingInteractionSnapshot>(new Map()),
  )
  const store = createConversationStore().create()
  store.actions.setDraft('ordinary draft')
  const { wiring, sink } = fakeWiring()
  const useInput = bindSnapshotSelector(wiring.state)
  const inputActions = wiring.actions
  const stop = vi.fn()
  const open = vi.fn()
  const slotCalls: string[] = []
  const lineageOwners: ConversationHeaderLineageOwnerProps[] = []
  const viewTabs = options.viewTabs ?? [
    { id: 'chat', label: 'Chat' },
    { id: 'trajectory', label: 'Trajectory' },
  ]
  const useConversationViews: SessionSlotProps['useConversationViews'] = selector => selector(viewTabs)
  /** Owner share handed to the two composer tool-row seats, per render. */
  const seatOwners: { key: string; owner: unknown }[] = []
  let pickerOwner: unknown
  const renderSlot = ((key: string, owner: object, opts?: { only?: string; fallback?: ReactNode }) => {
    slotCalls.push(key)
    if (key === 'conversation.input.model' || key === 'conversation.input.plan') {
      seatOwners.push({ key, owner })
    }
    if (key === 'conversation.hero.workspace') { pickerOwner = owner; return null }
    if (key === 'conversation.session.header.lineage') {
      lineageOwners.push(owner as ConversationHeaderLineageOwnerProps)
      return opts?.fallback ?? null
    }
    if (key === 'conversation.session.header') {
      return (
        <ConversationSessionHeader
          sessionId={SID}
          SessionProvider={({ children }) => children}
          useSession={useSession}
          useConversation={useConversation}
          useConversationViews={useConversationViews}
          useChat={useChat}
          useTrajectory={useTrajectory}
          useSessions={props.useSessions}
          useSessionPendingInteraction={useSessionPendingInteraction}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(store)}
          actions={store.actions}
          renderSlot={renderSlot as never}
          open={open}
          selectView={(view) => { store.actions.setView(view) }}
          t={t}
        />
      )
    }
    if (key === 'conversation.session') {
      return (
        <ConversationSession
          sessionId={SID}
          SessionProvider={({ children }) => children}
          useSession={useSession}
          useConversation={useConversation}
          useConversationViews={useConversationViews}
          useChat={useChat}
          useTrajectory={useTrajectory}
          useSessions={props.useSessions}
          useSessionPendingInteraction={useSessionPendingInteraction}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(store)}
          actions={store.actions}
          renderSlot={renderSlot as never}
          bindDraftMirror={write => wiring.bindMirror(write)}
          openView={(view, focus) => { store.actions.openView(view, focus) }}
        />
      )
    }
    if (key === 'conversation.composer.bar') {
      // The real entry, mounted the way the outlet composes it: standard kit
      // (shared with the root's props below) + this entry's inject + owner.
      const bar = owner as ComposerBarOwnerProps
      return (
        <InputBar
          sessionId={SID}
          SessionProvider={({ children }) => children}
          useSession={useSession}
          useConversation={useConversation}
          useSessions={props.useSessions}
          useSessionPendingInteraction={useSessionPendingInteraction}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          keyboard={wiring}
          addFiles={() => null}
          useFileUploads={bindSnapshotSelector(createSnapshotStore({}))}
          retryFileUpload={undefined}
          removeAttachment={() => {}}
          resolveDraftAttachments={() => []}
          resolveSubmitMode={() => 'queue'}
          toggleCommandMenu={vi.fn()}
          useNotices={bindSnapshotSelector(wiring.notices)}
          useLexicon={bindSnapshotSelector(wiring.lexicon)}
          useMenuLauncher={bindSnapshotSelector(createSnapshotStore<string | null>(null))}
          stop={stop}
          command={() => Promise.resolve(true)}
          t={t}
          renderSlot={((key: string, seatOwner: object) => {
            // The bar's own seats: recorded so a case can assert what share
            // each tool-row control received.
            seatOwners.push({ key, owner: seatOwner })
            return null
          }) as InputBarProps['renderSlot']}
          {...bar}
        />
      )
    }
    return <div data-testid={`view-${opts?.only ?? key}`} />
  }) as ConversationRootProps['renderSlot']
  const renderSlotChain = ((_key, _owner, opts) => (
    options.overlayTakeover === true
      ? (
        <>
          <div data-chain-overlay-fallback="conversation.composer" style={{ display: 'none' }}>
            {opts?.fallback ?? null}
          </div>
          <div data-testid="composer-takeover">TAKEOVER</div>
        </>
      )
      : (opts?.fallback ?? null)
  )) as ConversationRootProps['renderSlotChain']
  const props: ConversationRootProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children,
    useSession,
    useConversation,
    useSessions: bindSnapshotSelector(sessions),
    useSessionPendingInteraction,
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: (() => undefined),
    useComposerBlock: select => select(options.composerBlock),
    useInput,
    inputActions,
    renderSlot,
    renderSlotChain,
    selectWorkspace: retargetWorkspace,
    t,
  }
  const view = render(<ConversationRoot {...props} />)
  return {
    view, store, wiring, sink, retargetWorkspace, session, conversation, slotCalls, lineageOwners, seatOwners, open,
    pickerOwner: () => pickerOwner,
    rerender: () => { view.rerender(<ConversationRoot {...props} />) },
  }
}

describe('Hero chrome', () => {
  it('renders the English preview badge through the hero locale seat', () => {
    const renderSlot = vi.fn<HeroShellProps['renderSlot']>(() => null)
    const view = render(<HeroShell t={makeTranslate(en, commonEn)} renderSlot={renderSlot} />)
    expect(view.getByText('Into the Unknown')).toBeTruthy()
    expect(view.getByText('Preview')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledOnce()
    expect(renderSlot.mock.calls[0]?.[0]).toBe('conversation.hero.brand.mark')
    const brandMarkOwner = renderSlot.mock.calls[0]?.[1]
    if (brandMarkOwner === undefined || !('size' in brandMarkOwner) || !('className' in brandMarkOwner)) {
      throw new Error('hero brand-mark owner must provide size and className')
    }
    expect(brandMarkOwner.size).toBe(34)
    expect(brandMarkOwner.className).toBeTypeOf('string')
    expect(renderSlot.mock.calls[0]?.[2]?.fallback).toBeTruthy()
  })
})

describe('ConversationRoot resident composer', () => {
  it('does not redispatch composer child slots for an unrelated Session publication', () => {
    const b = mount(sessionSnapshotOf())
    const childKeys = new Set([
      'conversation.input.overlay',
      'conversation.input.left',
      'conversation.input.right',
      'conversation.composer.dock',
    ])
    const dispatchCount = () => b.slotCalls.filter(key => childKeys.has(key)).length
    const before = dispatchCount()

    act(() => {
      const current = b.session.getSnapshot()
      b.session.set({ ...current, hasMore: !current.hasMore })
    })

    expect(dispatchCount()).toBe(before)
  })

  it('renders the composer inert with the blocker\u2019s own reason', () => {
    const b = mount(sessionSnapshotOf(), undefined, undefined, {
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox')
    // One disabled composer with the blocker's placeholder, never a second
    // tree: the DOM survives the block being raised and cleared.
    expect(box.getAttribute('aria-disabled')).toBe('true')
    expect(box.getAttribute('data-placeholder')).toBe('select a model first')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).not.toHaveBeenCalled()

    // The model seat stays live. Locking it too would leave the composer
    // asking for the one thing it prevents — every block this contract has is
    // cleared by choosing a model.
    const seat = (key: string) => b.seatOwners.filter(call => call.key === key).at(-1)?.owner
    expect(seat('conversation.input.model')).toEqual({ locked: false })
    expect(seat('conversation.input.plan')).toEqual({ locked: true })
  })

  it('lets the no-workspace posture win over a block', () => {
    // Picking a workspace is the earlier prerequisite; naming a model first
    // would send the user somewhere they cannot act yet.
    const b = mount(sessionSnapshotOf({ blank: true }), [], undefined, {
      summaryBlank: true,
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox')
    expect(box.getAttribute('aria-disabled')).not.toBe('true')
    expect(box.getAttribute('contenteditable')).not.toBe('true')
    expect(box.getAttribute('aria-haspopup')).toBe('menu')
    expect(box.getAttribute('data-placeholder')).not.toBe('select a model first')
    const modelSeat = b.seatOwners.filter(call => call.key === 'conversation.input.model').at(-1)?.owner
    expect(modelSeat).toEqual({ locked: true })
  })

  it('keeps composer text in the machine, mirrors to the Conversation store, and submits through the sink', () => {
    const b = mount(sessionSnapshotOf())
    const box = b.view.getByRole('textbox')
    expect(b.wiring.snapshot.draft).toBe('ordinary draft')
    act(() => { b.wiring.setDraft('ordinary revised') })
    expect(b.store.store.getSnapshot().draft).toBe('ordinary revised')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).toHaveBeenCalledWith('ordinary revised', [], 'queue', expect.any(AbortSignal))
    expect((b.view.getByRole('button', { name: 'Child' }) as HTMLButtonElement).disabled).toBe(true)
    expect(b.view.queryByText('Root')).toBeNull()
  })

  it('shows hierarchy only for subagents and opens their ordinary owner', () => {
    const b = mount(sessionSnapshotOf(), undefined, undefined, { summaryOrigin: 'subagent' })
    const root = b.view.getByRole('button', { name: 'Root' })
    expect((b.view.getByRole('button', { name: 'Child' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(root)
    expect(b.open).toHaveBeenCalledWith(sid('root'))
  })

  it('keeps intermediate subagent breadcrumbs at the compact title size', () => {
    const b = mount(sessionSnapshotOf(), undefined, undefined, {
      summaryOrigin: 'subagent',
      nestedSubagent: true,
    })
    expect(b.view.getByRole('button', { name: 'Root' }).className).not.toContain('crumbSubagent')
    expect(b.view.getByRole('button', { name: 'Parent' }).className).toContain('crumbSubagent')
    expect(b.view.getByRole('button', { name: 'Child' }).className).toContain('crumbSubagent')
    expect(b.lineageOwners.slice(-2).map(owner => owner.lineageSessionId)).toEqual([
      sid('parent'),
      SID,
    ])
    expect(b.lineageOwners.at(-2)?.openTitle).toEqual(expect.any(Function))
    expect(b.lineageOwners.at(-1)?.openTitle).toBeUndefined()
  })

  it('active phase: fixed header outside the scrollport; sticky composer seat inside it', () => {
    const b = mount(sessionSnapshotOf())
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const header = b.view.container.querySelector('header')
    const textarea = b.view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(host).not.toBeNull()
    expect(seat).not.toBeNull()
    expect(header).not.toBeNull()
    // Header is column chrome above the scrollport; the seat sticks inside it.
    expect(host?.contains(header)).toBe(false)
    expect(host?.contains(seat)).toBe(true)
    expect(seat?.contains(textarea)).toBe(true)
    expect(b.slotCalls).toContain('conversation.session.header.lineage')
    expect(b.slotCalls).toContain('conversation.session.header.actions')
    expect(b.slotCalls).toContain('conversation.session.header.utilities')
  })

  it('sticky composer seat wraps the whole overlay chain, not only the fallback stack', () => {
    const b = mount(sessionSnapshotOf(), undefined, undefined, { overlayTakeover: true })
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const takeover = b.view.getByTestId('composer-takeover')
    const fallback = b.view.container.querySelector('[data-chain-overlay-fallback="conversation.composer"]')
    expect(seat?.contains(takeover)).toBe(true)
    expect(seat?.contains(fallback)).toBe(true)
  })

  it('hero phase: same textarea, hero chrome, no header, picker switches the workspace', () => {
    const b = mount(
      sessionSnapshotOf({ blank: true }),
      [
        { ...workspace('one'), sessionIds: [SID] },
        { ...workspace('second'), title: 'Selected Folder' },
      ],
    )
    // Hero chrome is present and the selected View slot remains absent.
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const header = b.view.container.querySelector('header')
    expect(host).not.toBeNull()
    expect(header?.getAttribute('aria-hidden')).toBe('true')
    expect(b.view.getByText('探索未至之境')).toBeTruthy()
    expect(b.view.getByText('预览版')).toBeTruthy()
    expect(b.view.queryByTestId('view-chat')).toBeNull()
    // The same machine-backed textarea is live in the hero, and the
    // persistence mirror stays bound (ConversationSession mounts chrome-hidden
    // for blank sessions): hero typing reaches the Conversation store.
    const box = b.view.getByRole('textbox')
    expect(host?.contains(box)).toBe(true)
    act(() => { b.wiring.setDraft('draft in hero') })
    expect(b.store.store.getSnapshot().draft).toBe('draft in hero')
    // Picker: open through the chip; a pick switches to the other
    // workspace's blank session (draft carry is apply-layer wiring).
    fireEvent.click(b.view.getByRole('button', { name: '选择工作区' }))
    const owner = b.pickerOwner() as { open: boolean; onPick(id: WorkspaceId): void }
    expect(owner.open).toBe(true)
    act(() => { owner.onPick(wid('second')) })
    expect(b.retargetWorkspace).toHaveBeenCalledWith(wid('second'))
    expect(b.view.getByText('Selected Folder')).toBeTruthy()
  })

  it('keeps a rejected first prompt engaging instead of returning to the Hero', () => {
    const failed = sessionSnapshotOf({
      blank: true,
      promptAttempted: true,
      awaitingFirstTurn: true,
      promptError: {
        op: 'send',
        error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }),
      },
    })

    expect(conversationPhase(failed, EMPTY_CONVERSATION_SNAPSHOT)).toBe('engaging')
    const b = mount(failed, undefined, undefined, { summaryBlank: true })
    expect(b.view.container.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('active')
    expect(b.view.queryByText('探索未至之境')).toBeNull()
  })

  it('settling phase: a summary that does not prove the session blank hides the composer while it opens', () => {
    const b = mount(sessionSnapshotOf({ blank: true, openState: 'loading' }))
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
    expect(b.view.queryByTestId('hero-headline')).toBeNull()
  })

  it('settling phase: a session the list has no row for settles conservatively', () => {
    const b = mount(
      sessionSnapshotOf({ blank: true, openState: 'loading' }),
      undefined,
      undefined,
      { omitSummaryRow: true },
    )
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
  })

  it('startup auto-selection: a summary-proven blank session opens straight into the hero', () => {
    const b = mount(
      sessionSnapshotOf({ blank: true, openState: 'loading' }),
      undefined,
      undefined,
      { summaryBlank: true },
    )
    // The summary already proves the outcome, so the settling hide would only
    // blank the column for the history round-trip.
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('hero')
    expect(b.view.getByText('探索未至之境')).toBeTruthy()
    expect(b.view.getByRole('textbox')).toBeTruthy()
  })

  it('same textarea DOM node survives the hero → active flip into the sticky scrollport', () => {
    const b = mount(sessionSnapshotOf({ blank: true }))
    const before = b.view.getByRole('textbox')
    act(() => { b.wiring.setDraft('kept across flip') })
    // First message landed: content exists, phase leaves blank. Composer
    // already sat in the resident scrollport during hero, so the textarea
    // node and InputHub draft both survive.
    b.session.set(sessionSnapshotOf({ blank: false }))
    b.rerender()
    const after = b.view.getByRole('textbox')
    expect(after).toBe(before)
    expect(b.wiring.snapshot.draft).toBe('kept across flip')
    expect(b.store.store.getSnapshot().draft).toBe('kept across flip')
    expect(b.view.container.querySelector('[data-conversation-scroll]')?.contains(after)).toBe(true)
    expect(b.view.queryByTestId('hero-headline')).toBeNull()
    expect(b.view.getByTestId('view-chat')).toBeTruthy()
  })

  it('keeps the Chat fallback selected by id when a view is inserted before it', () => {
    const viewTabs: ViewTab[] = [
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
    ]
    const b = mount(sessionSnapshotOf(), undefined, undefined, { viewTabs })
    // A removed dynamic view leaves its persisted id behind. The visible
    // fallback is Chat and must stay Chat when another lower-order view lands.
    act(() => { b.store.actions.setView('removed-view') })
    expect(b.view.getByTestId('view-chat')).toBeTruthy()

    viewTabs.unshift({ id: 'new-view', label: 'New view' })
    b.rerender()

    expect(b.view.getByTestId('view-chat')).toBeTruthy()
    expect(b.view.queryByTestId('view-new-view')).toBeNull()
    expect(b.view.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true')
    expect(b.view.getByRole('tab', { name: 'New view' }).getAttribute('aria-selected')).toBe('false')
  })

  it('rolls the pending workspace label back when switching fails', async () => {
    const selectWorkspace = vi.fn(async () => { throw new Error('connect failed') })
    const b = mount(
      sessionSnapshotOf({ blank: true }),
      [
        { ...workspace('one'), sessionIds: [SID] },
        { ...workspace('second'), title: 'Selected Folder' },
      ],
      selectWorkspace,
    )
    fireEvent.click(b.view.getByRole('button', { name: '选择工作区' }))
    const owner = b.pickerOwner() as { onPick(id: WorkspaceId): void }
    await act(async () => { owner.onPick(wid('second')); await Promise.resolve() })
    expect(selectWorkspace).toHaveBeenCalledWith(wid('second'))
    expect(b.view.queryByText('Selected Folder')).toBeNull()
    expect(b.view.getByText('one')).toBeTruthy()
  })

  it('blank session keeps the interactive picker chip (workspace switchable until the first message)', () => {
    const b = mount(sessionSnapshotOf({ blank: true }))
    const chip = b.view.getByRole('button', { name: '选择工作区' })
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(b.slotCalls).toContain('conversation.hero.workspace')
    // The agent-preset chip sits in the same row, for the same reason: both
    // choices are only open before the first message.
    expect(b.slotCalls).toContain('conversation.hero.agentPreset')
  })

  it('prompt failure renders the promptError strip (ordinary failure, no transaction UI)', () => {
    const b = mount(sessionSnapshotOf({
      promptError: { op: 'send', error: { code: 'offline', message: 'Message send failed' } as never },
    }))
    expect(b.view.getByRole('alert').textContent).toContain('Message send failed (offline)')
    expect(b.view.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('publishes the column width as a px variable for the shared width axis', () => {
    const b = mount(sessionSnapshotOf())
    const root = b.view.container.querySelector('[data-phase]') as HTMLElement
    // jsdom offsetWidth is 0 until faked: the observer publishes whatever the
    // layout reports, and the CSS clamp() floors the axis at 680px either way.
    Object.defineProperty(root, 'offsetWidth', { value: 1200, configurable: true })
    act(() => { fireResize(root) })
    expect(root.style.getPropertyValue('--dsh-conversation-column-width')).toBe('1200px')
    // No dragged preference: the user-width override stays absent so the
    // adaptive clamp term applies.
    expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('')
  })

  it('drag → persist → window clamp round-trip on a width handle', () => {
    const b = mount(sessionSnapshotOf())
    const root = b.view.container.querySelector('[data-phase]') as HTMLElement
    Object.defineProperty(root, 'offsetWidth', { value: 1600, configurable: true })
    act(() => { fireResize(root) })
    const handle = b.view.container.querySelector('[data-width-handle="right"]') as HTMLElement
    expect(handle).not.toBeNull()
    // jsdom lacks pointer capture: emulate per-element so hasPointerCapture
    // gates pass; the finally block restores the original descriptors so the
    // stubs cannot leak into later tests.
    const names = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const
    const originals = names.map(name =>
      [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const)
    const captured = new Set<Element>()
    Element.prototype.setPointerCapture = function () { captured.add(this) }
    Element.prototype.releasePointerCapture = function () { captured.delete(this) }
    Element.prototype.hasPointerCapture = function () { return captured.has(this) }
    try {
      // Base resolves from the adaptive clamp: min(1600*0.64, 920) = 920.
      // Dragging the right handle outward by 25px widens by 2×25 = 50 → 970,
      // inside both bounds (max = 1600 − 176 = 1424 keeps the handles on-column).
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800, clientY: 300 })
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 825, clientY: 300 })
      expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('970px')
      expect(localStorage.getItem('dsh.conversation.contentWidth')).toBe('970')
      // Window shrinks: the displayed width re-clamps (900 − 176 = 724) but the
      // preference stays.
      Object.defineProperty(root, 'offsetWidth', { value: 900, configurable: true })
      act(() => { fireResize(root) })
      expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('724px')
      expect(localStorage.getItem('dsh.conversation.contentWidth')).toBe('970')
      // A press without travel (a real double-click delivers two such
      // press/release rounds) must not commit the clamped display value over
      // the stored preference.
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 800, clientY: 300 })
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 800, clientY: 300 })
      expect(localStorage.getItem('dsh.conversation.contentWidth')).toBe('970')
      expect(root.style.getPropertyValue('--dsh-chat-user-width')).toBe('724px')
      // No reset affordance on the handle: double-click leaves the preference alone.
      fireEvent.doubleClick(handle)
      expect(localStorage.getItem('dsh.conversation.contentWidth')).toBe('970')
    } finally {
      for (const [name, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name)
        else Object.defineProperty(Element.prototype, name, descriptor)
      }
    }
  })

  it('hero phase renders no width handles (no transcript to size)', () => {
    const b = mount(sessionSnapshotOf({ blank: true }))
    expect(b.view.container.querySelector('[data-width-handle]')).toBeNull()
  })
})
