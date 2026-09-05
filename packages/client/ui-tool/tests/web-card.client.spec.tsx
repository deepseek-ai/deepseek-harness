// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ChatSnapshot, ConversationNode, RunningToolCall, SelectionTarget, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  bindSnapshotSelector, conversationSnapshot, sessionSnapshot, workspaceSnapshot,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { webCardModel } from '../src/client/tool/models/web-card-model.ts'
import { createChatStore } from '@deepseek-ai/dsh-client-ui-chat/src/client/stores.ts'
import { GenericToolCard } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { DetailsPanel } from '@deepseek-ai/dsh-client-ui-chat/src/client/details/DetailsPanel.tsx'
import { WebRow, webToolview } from '../src/client/tool/toolviews/web-row.tsx'
import { renderToolDetails, toolChatSnapshot, useEmptyTrajectory } from './tool-details-render.client.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { zh as chatZh } from '@deepseek-ai/dsh-client-ui-chat/src/client/locale.ts'

afterEach(cleanup)

const SID = 's1' as SessionId

const t = makeTranslate(zh, commonZh)
const chatT = makeTranslate(chatZh, commonZh)

const SEARCH_ARGS = '{"queries":["deepseek harness"]}'
const FETCH_ARGS = '{"url":"https://example.com/page"}'

interface SearchMeta {
  sources: { url: string; title?: string; snippet?: string; publishedAt?: string }[]
  truncated: boolean
  answer?: string
}

interface FetchMeta {
  url: string
  statusCode: number
  truncated: boolean
}

/** Persisted web_search result metadata. */
const searchMeta = (over?: Partial<SearchMeta>): SearchMeta => ({
  truncated: false,
  answer: 'A short answer.',
  sources: [
    { url: 'https://example.com/a', title: 'Titled', snippet: 'excerpt', publishedAt: '2026-07-01' },
    { url: 'https://plain.example.org/b' },
  ],
  ...over,
})

/** Persisted web_fetch result metadata. */
const fetchMeta = (over?: Partial<FetchMeta>): FetchMeta => ({
  url: 'https://example.com/page', statusCode: 200, truncated: false, ...over,
})

const runningSearch = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'web_search', argsRaw: SEARCH_ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settledSearch = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'web_search', argsRaw: SEARCH_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'search text' }], isError: false,
  meta: searchMeta(), subCalls: [], ...over,
})

const settledFetch = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 11, time: 2_000, callId: 'c2',
  call: { name: 'web_fetch', argsRaw: FETCH_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'fetch body' }], isError: false,
  meta: fetchMeta(), subCalls: [], ...over,
})

describe('webCardModel', () => {
  it('derives a search card from result metadata, projecting every source field', () => {
    expect(webCardModel(settledSearch())).toEqual({
      kind: 'search',
      answer: 'A short answer.',
      truncated: false,
      sources: [
        { url: 'https://example.com/a', title: 'Titled', snippet: 'excerpt', publishedAt: '2026-07-01' },
        { url: 'https://plain.example.org/b' },
      ],
    })
  })

  it('carries the search truncation flag and an absent answer', () => {
    const model = webCardModel(settledSearch({ meta: { truncated: true, sources: [] } }))
    expect(model).toEqual({ kind: 'search', answer: undefined, truncated: true, sources: [] })
  })

  it('derives a fetch card from result metadata', () => {
    expect(webCardModel(settledFetch())).toEqual({
      kind: 'fetch', url: 'https://example.com/page', statusCode: 200, truncated: false,
    })
    expect(webCardModel(settledFetch({ meta: fetchMeta({ statusCode: 404, truncated: true }) })))
      .toEqual({ kind: 'fetch', url: 'https://example.com/page', statusCode: 404, truncated: true })
  })

  it('returns null for a running call, since the web card is result-only', () => {
    expect(webCardModel(runningSearch())).toBeNull()
  })

  it('returns null for missing calls, errors, malformed args/meta, unrelated tools, and children', () => {
    expect(webCardModel(settledSearch({ call: null }))).toBeNull()
    expect(webCardModel(settledSearch({ isError: true }))).toBeNull()
    expect(webCardModel(settledSearch({ call: { name: 'web_search', argsRaw: '{' } }))).toBeNull()
    expect(webCardModel(settledSearch({ meta: undefined }))).toBeNull()
    expect(webCardModel(settledSearch({ meta: { sources: [], truncated: 'yes' } }))).toBeNull()
    expect(webCardModel(settledSearch({ call: { name: 'echo', argsRaw: '{}' } }))).toBeNull()
    expect(webCardModel(settledSearch({ parentCallId: 'parent' }))).toBeNull()
  })

  it('accepts open-root extensions while validating declared web arguments', () => {
    expect(webCardModel(settledSearch({
      call: { name: 'web_search', argsRaw: '{"queries":["deepseek"],"extension":1}' },
    }))).not.toBeNull()
    expect(webCardModel(settledSearch({
      call: { name: 'web_search', argsRaw: '{"queries":[7]}' },
    }))).toBeNull()
    expect(webCardModel(settledFetch({
      call: { name: 'web_fetch', argsRaw: '{"url":" "}' },
    }))).toBeNull()
  })
})

describe('chat row web body', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode, toolName: string): ToolCallOwnerProps => ({
    callId: block.callId, toolName, block, openFile: vi.fn(), loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
  })
  // WebRow reads only toolName/block off the full runtime share plus the locale
  // seat; the standard kit is unused, so the cast supplies the owner slice and
  // `t` alone (as BashRow's tests do for the terminal card).
  const rowProps = (block: RunningToolCall | ToolResultNode, toolName: string): Parameters<typeof WebRow>[0] =>
    ({ ...ownerProps(block, toolName), t } as unknown as Parameters<typeof WebRow>[0])

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('the WebRow collapses to the summary row, expanding to the full search card', () => {
    const globe = render(<IconGlobeOutline14 />).container.querySelector('svg')!.outerHTML
    const view = render(<WebRow {...rowProps(settledSearch(), 'web_search')} />)
    // Collapsed: the summary row alone, no card in the DOM.
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.container.querySelector('svg')?.outerHTML).toBe(globe)
    expect(view.queryByText('Titled')).toBeNull()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    toggleRow(view)
    // Expanded: the resident search card with every source field.
    expect(view.getByText('Titled')).toBeTruthy()
    expect(view.getByText('excerpt')).toBeTruthy()
    // hostname fallback for the source with no title
    expect(view.getByText('plain.example.org')).toBeTruthy()
  })

  it('the WebRow expands to the fetch card, titled Fetch', () => {
    const view = render(<WebRow {...rowProps(settledFetch(), 'web_fetch')} />)
    expect(view.getByText('网页获取')).toBeTruthy()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    toggleRow(view)
    // The url shows as the card's link; scope to the card.
    const card = view.container.querySelector('[data-web="fetch"]')
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/page')
    expect(view.getByText('HTTP 200')).toBeTruthy()
  })

  it('a running web call is the summary row alone, with nothing to expand', () => {
    const view = render(<WebRow {...rowProps(runningSearch(), 'web_search')} />)
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.queryByText('Titled')).toBeNull()
    // No card material and no expandable body: clicking the row reveals nothing.
    expect(view.container.querySelector('[data-expandable]')).toBeNull()
    expect(view.container.querySelector('[data-web]')).toBeNull()
  })

  it('a failed web call keeps the summary row without the card', () => {
    const view = render(<WebRow {...rowProps(settledSearch({
      isError: true,
    }), 'web_search')} />)
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    // The row reflects the error state so the summary line still reads as failed.
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('the GenericToolCard fallback does not promote an unknown tool from metadata alone', () => {
    const view = render(<GenericToolCard {...ownerProps(settledSearch({
      call: { name: 'fx-web', argsRaw: SEARCH_ARGS },
    }), 'fx-web')} t={t} />)
    toggleRow(view)
    expect(view.container.querySelector('[data-web]')).toBeNull()
    expect(view.getByText('search text')).toBeTruthy()
  })

  it('the GenericToolCard fallback keeps the plain row for a non-web call', () => {
    const view = render(<GenericToolCard {...ownerProps(settledSearch({
      call: { name: 'echo', argsRaw: '{}' },
      meta: undefined,
    }), 'echo')} t={t} />)
    expect(view.container.querySelector('[data-web]')).toBeNull()
  })
})

describe('DetailsPanel web Output section', () => {
  function mount(snapshot: ChatSnapshot, selection: SelectionTarget | null) {
    localStorage.clear()
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const sessions = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    const session = createSnapshotStore(sessionSnapshot(SID))
    const conversation = createSnapshotStore(conversationSnapshot())
    const workspaces = createSnapshotStore(workspaceSnapshot())
    const attention = createSnapshotStore(new Map())
    return render(
      <DetailsPanel
        renderSlot={renderToolDetails(t)}
        SessionProvider={({ children }) => children}
        sessionId={SID}
        useSession={bindSnapshotSelector(session)}
        useSessions={bindSnapshotSelector(sessions)}
        useSessionPendingInteraction={bindSnapshotSelector(attention)}
        useWorkspaces={bindSnapshotSelector(workspaces)}
        useConversation={bindSnapshotSelector(conversation)}
        useChat={bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: () => () => {} })}
        useTrajectory={useEmptyTrajectory}
        useInput={(() => { throw new Error('unused') })}
        inputActions={{
          setDraft: () => {},
          addAttachments: () => true,
          removeAttachment: () => {},
          pruneAttachments: () => {},
          submit: () => {},
        }}
        useProjection={(() => undefined)}
        useStore={bindSnapshotSelector(chat)}
        actions={chat.actions}
        closeDetails={vi.fn()}
        t={chatT}
      />,
    )
  }

  function snapshot(over: {
    nodes?: readonly ConversationNode[]
    runningCalls?: readonly RunningToolCall[]
  } = {}): ChatSnapshot {
    const nodes = over.nodes ?? []
    const runningCalls = over.runningCalls ?? []
    return toolChatSnapshot(nodes, runningCalls)
  }

  it('renders the search card at full source allowance', () => {
    const view = mount(snapshot({ nodes: [settledSearch()] }), { turnSeq: 10, callId: 'c1', toolName: 'web_search' })
    expect(view.getByText('Titled')).toBeTruthy()
    expect(view.getByText('excerpt')).toBeTruthy()
    // The Input JSON section survives beside it.
    expect(view.getByText(/"queries"/)).toBeTruthy()
  })

  it('renders the fetch card and keeps the fetched body below it', () => {
    const view = mount(snapshot({ nodes: [settledFetch()] }), { turnSeq: 11, callId: 'c2', toolName: 'web_fetch' })
    const card = view.container.querySelector('[data-web="fetch"]')
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/page')
    expect(view.getByText('HTTP 200')).toBeTruthy()
    // The card is a summary (URL + status only); the panel is the single-call
    // reading surface, so the fetched body still renders below the card.
    const output = view.getByText('输出').closest('section')
    expect(output?.querySelector('pre')?.textContent).toContain('fetch body')
  })

  it('a non-web result keeps the flattened pre form', () => {
    const view = mount(snapshot({
      nodes: [settledSearch({ meta: undefined })],
    }), { turnSeq: 10, callId: 'c1', toolName: 'web_search' })
    expect(view.container.querySelector('[data-web]')).toBeNull()
    const output = view.getByText('输出').closest('section')
    expect(output?.querySelector('pre')?.textContent).toContain('search text')
  })
})

describe('web toolview registration', () => {
  it('registers one WebRow under both web_search and web_fetch', () => {
    const registered: { key: string; locale: unknown; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          for (const _dispose of callback()) { /* exhaust transactional setup */ }
          return () => undefined
        },
        register: (options: { name: string; key: string; locale?: string }, component: unknown) => {
          registered.push({ key: options.key, locale: options.locale, component })
          return () => {}
        },
      },
    } as unknown as import('@deepseek-ai/cordis').Context
    webToolview.apply(ctx)
    expect(registered.map(r => r.key)).toEqual(['web_search', 'web_fetch'])
    // Both keys claim the conversation locale seat ToolRow's body copy needs.
    expect(registered.map(r => r.locale)).toEqual(['conversation', 'conversation'])
    // One component under both keys, not two thin rows.
    expect(registered[0]?.component).toBe(WebRow)
    expect(registered[1]?.component).toBe(WebRow)
    expect(webToolview.inject).toEqual(['slots'])
  })
})
