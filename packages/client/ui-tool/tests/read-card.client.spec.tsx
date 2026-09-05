// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import {
  bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot, workspaceSnapshot,
} from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ChatSnapshot, ConversationNode, RunningToolCall, SelectionTarget, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CHAT_READ_MAX_LINES, readCardModel } from '../src/client/tool/models/read-card-model.ts'
import { createChatStore } from '@deepseek-ai/dsh-client-ui-chat/src/client/stores.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { zh as chatZh } from '@deepseek-ai/dsh-client-ui-chat/src/client/locale.ts'
import { DetailsPanel } from '@deepseek-ai/dsh-client-ui-chat/src/client/details/DetailsPanel.tsx'
import { ReadRow, readToolview } from '../src/client/tool/toolviews/read-row.tsx'
import { renderToolDetails, toolChatSnapshot, useEmptyTrajectory } from './tool-details-render.client.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId

/** The chat-view locale seat: this package's namespace over the common fallback. */
const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)
const chatT = makeTranslate(chatZh, commonZh)

// The read tool's real schema key is `file_path`; the top-level read samples
// use it so the row exercises a production-shaped call. `web_fetch` (below) has
// its own schema whose key is not `file_path`, so it keeps a `url`-less `path`.
const ARGS = '{"file_path":"src/a.ts","offset":41}'

/** The read block's rendered content cells, one string per row (highlighting
 *  breaks a line across token spans, so match on the row's textContent). */
function contentTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-read] [class^="_content_"]')].map(cell => cell.textContent ?? '')
}

/** Three windowed lines starting at file line 41 (a read past an offset). */
const sampleLines = [
  { number: 41, text: 'export const a = 1' },
  { number: 42, text: 'export const b = 2' },
  { number: 43, text: 'export const c = 3' },
]

interface ReadMetaFixture {
  path: string
  offset: number
  lines: { number: number; text: string }[]
  totalLines: number
  lang?: string
}

const readMeta = (over?: Partial<ReadMetaFixture>): ReadMetaFixture => ({
  path: 'src/a.ts', offset: 41, lines: sampleLines, totalLines: 180, lang: 'ts', ...over,
})

const readContent = (body = 'export const a = 1'): string => `<path>src/a.ts</path>\n<type>file</type>\n<content>\n${body}\n</content>`

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'read', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'read', argsRaw: ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: readContent() }], isError: false,
  meta: readMeta(), subCalls: [], ...over,
})

describe('readCardModel', () => {
  it('derives the card from settled read metadata and its raw envelope', () => {
    expect(readCardModel(settled())).toEqual({
      label: 'src/a.ts', lines: sampleLines, totalLines: 180, lang: 'ts',
    })
  })

  it('copies the lines into the primitive shape rather than aliasing the frozen slice', () => {
    const model = readCardModel(settled())
    expect(model?.lines).toEqual(sampleLines)
    expect(model?.lines).not.toBe(sampleLines)
    expect(model?.lines[0]).not.toBe(sampleLines[0])
  })

  it('relativizes a workspace-rooted path label, and leaves others as authored', () => {
    // A workspace-rooted absolute path shows its short form.
    expect(readCardModel(settled({ meta: readMeta({ path: '/w/app/src/a.ts' }) }), '/w/app')?.label)
      .toBe('src/a.ts')
    // A path outside the workspace stays as authored.
    expect(readCardModel(settled({ meta: readMeta({ path: '/srv/other.ts' }) }), '/w/app')?.label)
      .toBe('/srv/other.ts')
    // With no session cwd there is nothing to relativize against.
    expect(readCardModel(settled({ meta: readMeta({ path: '/w/app/src/a.ts' }) }))?.label)
      .toBe('/w/app/src/a.ts')
  })

  it('abbreviates a leftover POSIX home path label', () => {
    expect(readCardModel(settled({ meta: readMeta({ path: '/Users/u/notes.md' }) }), '/tmp/ws', '/Users/u')?.label)
      .toBe('~/notes.md')
    expect(readCardModel(settled({ meta: readMeta({ path: '/Users/u/app/src/a.ts' }) }), '/Users/u/app', '/Users/u')?.label)
      .toBe('src/a.ts')
    expect(readCardModel(settled({ meta: readMeta({ path: 'C:\\Users\\u\\a.ts' }) }), '/tmp/ws', '/Users/u')?.label)
      .toBe('C:\\Users\\u\\a.ts')
  })

  it('carries an omitted language through as undefined', () => {
    const noLang = readMeta()
    delete (noLang as { lang?: string }).lang
    expect(readCardModel(settled({ meta: noLang }))?.lang).toBeUndefined()
  })

  it('returns null for a running read: the read intent is result-side only', () => {
    // A read carries no content until execute returns, so the pending call is a
    // generic card and there is no read card to draw yet.
    expect(readCardModel(running())).toBeNull()
  })

  it('returns null for missing calls, errors, malformed metadata/envelopes, unrelated tools, and children', () => {
    expect(readCardModel(settled({ call: null }))).toBeNull()
    expect(readCardModel(settled({ isError: true }))).toBeNull()
    expect(readCardModel(settled({ meta: undefined }))).toBeNull()
    expect(readCardModel(settled({ meta: { ...readMeta(), lines: [{ number: 0, text: 'bad' }] } }))).toBeNull()
    expect(readCardModel(settled({ content: [{ type: 'text', text: 'plain result' }] }))).toBeNull()
    expect(readCardModel(settled({ call: { name: 'echo', argsRaw: '{}' } }))).toBeNull()
    expect(readCardModel(settled({ parentCallId: 'parent' }))).toBeNull()
  })

  it.each([
    ['missing file_path', '{}'],
    ['non-string file_path', '{"file_path":7}'],
    ['blank file_path', '{"file_path":" "}'],
    ['non-number offset', '{"file_path":"src/a.ts","offset":"41"}'],
    ['non-positive offset', '{"file_path":"src/a.ts","offset":0}'],
    ['fractional limit', '{"file_path":"src/a.ts","limit":1.5}'],
  ])('keeps malformed recognized read args generic: %s', (_label, argsRaw) => {
    expect(readCardModel(settled({ call: { name: 'read', argsRaw } }))).toBeNull()
  })

  it('accepts unknown fields because first-party parameter roots are open', () => {
    const argsRaw = JSON.stringify({ file_path: 'src/a.ts', offset: 41, extension: { version: 1 } })
    expect(readCardModel(settled({ call: { name: 'read', argsRaw } }))).not.toBeNull()
  })
})

describe('GenericToolCard read body', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode): GenericToolCardProps => ({
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    callId: 'c1', toolName: 'read', block, openFile: vi.fn(), t,
  })

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('expands to the read card, capped tighter than the panel', () => {
    expect(CHAT_READ_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settled())} />)
    // Collapsed: no read card in the DOM yet.
    expect(view.container.querySelector('[data-read]')).toBeNull()
    toggleRow(view)
    expect(view.container.querySelector('[data-read]')).not.toBeNull()
    expect(contentTexts(view.container)).toContain('export const a = 1')
    // The gutter keeps the file's own line numbers.
    expect(view.getByText('41')).toBeTruthy()
  })

  it('a non-read tool renders the bare row with no read card', () => {
    const view = render(<GenericToolCard {...({
      callId: 'c1', toolName: 'echo', block: settled({
        call: { name: 'echo', argsRaw: '{"text":"x"}' }, meta: undefined,
      }), openFile: vi.fn(), loadImage: vi.fn(() => Promise.reject(new Error('not used'))), t,
    })} />)
    toggleRow(view)
    expect(view.container.querySelector('[data-read]')).toBeNull()
  })

  it('a running read renders the summary row alone (no result metadata yet)', () => {
    const view = render(<GenericToolCard {...ownerProps(running())} />)
    expect(view.container.querySelector('[data-read]')).toBeNull()
  })
})

describe('ReadRow keyed toolview', () => {
  const list = () => createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0, cwd: '/w/app' } },
    current: SID,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  })

  const rowProps = (block: RunningToolCall | ToolResultNode): Parameters<typeof ReadRow>[0] => ({
    callId: 'c1', toolName: 'read', block, openFile: vi.fn(),
    sessionId: SID, useSessions: bindSnapshotSelector(list()),
    t,
  } as unknown as Parameters<typeof ReadRow>[0])

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('collapses to the path summary; the whole row toggles the read card', () => {
    const view = render(<ReadRow {...rowProps(settled())} />)
    expect(view.getByText('读取')).toBeTruthy()
    // Collapsed: the path is the summary link alone, and the card is absent.
    expect(view.getAllByText('src/a.ts').length).toBe(1)
    expect(view.container.querySelector('[data-read]')).toBeNull()
    toggleRow(view)
    // Expanded: the summary link stays inline and the card's banner label adds a
    // second occurrence of the path.
    expect(view.getAllByText('src/a.ts').length).toBe(2)
    expect(view.container.querySelector('[data-read]')).not.toBeNull()
    expect(contentTexts(view.container)).toContain('export const a = 1')
    expect(view.getByText('显示 3 / 180 行')).toBeTruthy()
    // Collapse back in place: the card unmounts, the summary link returns.
    toggleRow(view)
    expect(view.container.querySelector('[data-read]')).toBeNull()
    expect(view.getAllByText('src/a.ts').length).toBe(1)
  })

  it('the path summary opens the file through the host', () => {
    const openFile = vi.fn()
    const view = render(<ReadRow {...{ ...rowProps(settled()), openFile }} />)
    fireEvent.click(view.getByRole('button', { name: 'src/a.ts' }))
    // The row derives the file path from args; the chat view resolves it against
    // the cwd before this callback opens it, so the arg path is what arrives.
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('a running read renders the summary row alone, and its state', () => {
    const view = render(<ReadRow {...rowProps(running())} />)
    expect(view.container.querySelector('[data-variant="read"]')?.getAttribute('data-state')).toBe('running')
    expect(view.container.querySelector('[data-read]')).toBeNull()
  })

  it('an error read result shows the error state and no read card', () => {
    const view = render(<ReadRow {...rowProps(settled({
      isError: true,
      content: [{ type: 'text', text: 'ENOENT' }],
    }))} />)
    expect(view.container.querySelector('[data-variant="read"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.querySelector('[data-read]')).toBeNull()
  })

  it('an interrupted read shows the stopped state', () => {
    const view = render(<ReadRow {...rowProps(settled({
      isError: true, error: { name: 'ToolError', code: 'interrupted' },
    }))} />)
    expect(view.container.querySelector('[data-variant="read"]')?.getAttribute('data-state')).toBe('stopped')
  })

  it('registers under the read key of the keyed toolview slot', () => {
    const registered: { name: unknown; key?: unknown }[] = []
    const ctx = { slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (options: { name: unknown; key?: unknown }) => { registered.push(options); return () => undefined },
    } } as unknown as Context
    readToolview.apply(ctx)
    // The row composes ToolRow, so it declares its locale namespace at the seat.
    expect(registered).toEqual([{ name: 'tool.call.toolview', key: 'read', locale: 'conversation' }])
    expect(readToolview.inject).toEqual(['slots'])
  })
})

describe('DetailsPanel Output section (read)', () => {
  function mount(
    snapshot: ChatSnapshot,
    selection: SelectionTarget | null,
    cwd?: string,
    description?: Parameters<typeof renderToolDetails>[1],
  ) {
    localStorage.clear()
    const chat = createChatStore().create()
    if (selection !== null) chat.actions.select(selection)
    const sessions = createSnapshotStore<SessionListState>(cwd === undefined
      ? { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
      : {
        ids: [SID],
        byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0, cwd } },
        current: SID,
        phase: 'ready',
        subagentsByParent: {}, jobsBySession: {},
        currentAddress: undefined,
      })
    const session = createSnapshotStore(sessionSnapshot(SID))
    const conversation = createSnapshotStore(conversationSnapshot())
    const workspaces = createSnapshotStore(workspaceSnapshot())
    const attention = createSnapshotStore(new Map())
    return render(
      <DetailsPanel
        renderSlot={renderToolDetails(t, description)}
        SessionProvider={({ children }) => children}
        sessionId={SID}
        t={chatT}
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

  const target: SelectionTarget = { turnSeq: 10, callId: 'c1', toolName: 'read' }

  it('renders the read card at full height, keeping the JSON Input section', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, text: `row-${i}` }))
    const view = mount(snapshot({
      nodes: [settled({ meta: readMeta({ offset: 1, lines: long, totalLines: 20 }) })],
    }), target)
    expect(view.getByText(/"file_path"/)).toBeTruthy()
    expect(view.container.querySelector('[data-read]')).not.toBeNull()
    // The panel takes the primitive's own default cap (16), not the row's.
    expect(view.getByText(`… 其余 ${20 - 16} 行`)).toBeTruthy()
    expect(contentTexts(view.container)).toContain('row-0')
  })

  it('a non-read result keeps the flattened pre form', () => {
    const view = mount(snapshot({
      nodes: [settled({
        meta: undefined,
        content: [{ type: 'text', text: 'plain result' }],
      })],
    }), target)
    expect(view.container.querySelector('[data-read]')).toBeNull()
    expect(view.getByText('输出').closest('section')?.querySelector('pre')?.textContent).toBe('plain result')
  })

  it('abbreviates a leftover POSIX home path on the read card label', () => {
    const view = mount(snapshot({
      nodes: [settled({ meta: readMeta({ path: '/Users/u/notes.md' }) })],
    }), target, '/tmp/ws', '/Users/u')
    expect(view.getByText('~/notes.md')).toBeTruthy()
  })

  it('a running read keeps the 运行中… placeholder (no result metadata)', () => {
    const view = mount(snapshot({ runningCalls: [running()] }), target)
    expect(view.getByText('运行中…')).toBeTruthy()
    expect(view.container.querySelector('[data-read]')).toBeNull()
  })
})
