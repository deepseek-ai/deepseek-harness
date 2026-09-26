// @vitest-environment jsdom
/**
 * ui-deliverables browser half: the derivation contract of produced paths,
 * recorded changes, and deliveries over engine-published Turn data, the
 * changed-files card's rendering and opener wiring, and the plugin
 * registrations' fiber-teardown removal (HMR safety) against the real
 * SlotRegistry.
 */
import { renderFileActions } from './file-actions.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEventEntry, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler, UiConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationMatch, ConversationNodeDefinition,
  ConversationStartMatch, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewDefinition,
  ConversationViewNode, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatFileMentions, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { Deliverables, DeliverablesTail, selectDeliverables, type DeliverablesInjected } from '../src/client/Deliverables.tsx'
import type { ReviewInjected } from '../src/client/ReviewTab.tsx'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { changesSummaryUrl, type ChangesSummary } from '../src/changes.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'
import {
  basename, changesForClosing, deliverablesDefinition, presentedForClosing, producedFileMentions, producedForClosing,
  selectProducedFiles, type DeliverablesTurnData,
} from '../src/client/turn-deliverables.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

function openProps(controller = new PresentedOpenController(), summaries = new ChangesSummaryStore()) {
  controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
  const diffs = new ChangesDiffStore()
  const sessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  return {
    SessionProvider: ({ children }: { children?: import('react').ReactNode }) => <>{children}</>,
    renderSlot: renderFileActions,
    useChangesDiff: <T,>(select: (state: ReturnType<typeof diffs.state.getSnapshot>) => T): T => select(diffs.state.getSnapshot()),
    loadChangesDiff: vi.fn((...args: Parameters<ChangesDiffStore['load']>) => diffs.load(...args)),
    useShowCodeDiff: <T,>(select: (value: boolean) => T): T => select(true),
    useSessions: <T,>(select: (state: SessionListState) => T): T => select(sessions),
    reloadPresentedHost: vi.fn(() => controller.loadHost()),
    useChangesSummary: <T,>(select: (state: ReturnType<typeof summaries.state.getSnapshot>) => T): T =>
      select(summaries.state.getSnapshot()),
    loadChangesSummary: vi.fn((...args: Parameters<ChangesSummaryStore['load']>) => summaries.load(...args)),
    usePresentedHost: <T,>(select: (state: ReturnType<typeof controller.host.getSnapshot>) => T): T =>
      select(controller.host.getSnapshot()),
    openPresented: vi.fn((...args: Parameters<PresentedOpenController['open']>) => controller.open(...args)),
    openChanged: vi.fn((...args: Parameters<PresentedOpenController['openChanged']>) => controller.openChanged(...args)),
    openChangesReview: vi.fn<DeliverablesInjected['openChangesReview']>(),
    usePresentedOpen: <T,>(select: (state: ReturnType<typeof controller.state.getSnapshot>) => T): T =>
      select(controller.state.getSnapshot()),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()
  private readonly sources = new Map<string, ConversationLocationDataSource<unknown>>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = { getSnapshot: () => this.get(key), subscribe: () => () => {} }
      this.sources.set(key, source)
    }
    return source as ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined>
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

const turnLocation = (turn: number, deliverables?: DeliverablesTurnData): TurnLocation => {
  const data = new TestTurnDataStore()
  if (deliverables !== undefined) data.set('deliverables', deliverables)
  return { turn, start: undefined, end: undefined, status: 'closed', steps: [], data }
}

const produced = (...values: ReadonlyArray<readonly [seq: number, path: string]>): DeliverablesTurnData => ({
  produced: values.map(([seq, path]) => ({ seq, path })),
})

function tailOwner(
  data: DeliverablesTurnData | undefined,
  seq: number,
  openFile: (path: string) => void = () => {},
  turn = 1,
): TurnTailOwnerProps {
  return { seq, openFile, turn: turnLocation(turn, data) }
}

interface TimelineSnapshot {
  readonly timeline: ConversationTimelineSnapshot
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [deliverablesDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [timelineViewDefinition] }
}

const timelineViewDefinition: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return {
      empty: current,
      replace: ({ timeline }) => (current = { timeline }),
      apply: ({ timeline }) => (current = { timeline }),
    }
  },
}

function at(
  seq: number,
  type: string,
  data: unknown,
): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as SessionEvent,
  }
}

function matched(input: SessionLiveEventEntry, role: 'start'): ConversationStartMatch
function matched(input: SessionLiveEventEntry, role: 'update'): ConversationMatch
function matched(input: SessionLiveEventEntry, role: ConversationMatch['role']): ConversationMatch {
  return { event: input.event, role, location: { kind: 'unresolved' } }
}

function call(
  seq: number,
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  turn = 1,
): SessionLiveEventEntry {
  return rawCall(seq, callId, name, JSON.stringify(args), turn)
}

function rawCall(
  seq: number,
  callId: string,
  name: string,
  argsRaw: string,
  turn = 1,
): SessionLiveEventEntry {
  return at(
    seq,
    'tool/call',
    { turn, step: 1, callId, name, arguments: argsRaw },
  )
}

function result(seq: number, callId: string, isError = false, turn = 1): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      id: `result-${callId}`,
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      content: [],
      isError,
    },
  })
}

function assembler(entries: readonly SessionLiveEventEntry[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.activateTarget('test')
  return value
}

function deliverablesOf(value: ConversationNodeAssembler, turn = 1): Readonly<DeliverablesTurnData> | undefined {
  const snapshot = value.snapshot('test') as TimelineSnapshot
  return snapshot.timeline.turns.get(turn)?.data.get('deliverables')
}

describe('produced-file Turn data', () => {
  it('deduplicates paths in first-seen order and stops at the closing Assistant seq', () => {
    const data = produced(
      [3, 'out/index.html'],
      [4, 'out/app.css'],
      [4, 'out/index.html'],
      [8, 'after.txt'],
    )
    expect(producedForClosing(data, 6)).toEqual(['out/index.html', 'out/app.css'])
    expect(selectProducedFiles(tailOwner(data, 6))).toEqual(['out/index.html', 'out/app.css'])
    expect(producedForClosing(undefined)).toEqual([])
    expect(selectProducedFiles(tailOwner(undefined, 9, () => {}, 2))).toBeNull()
  })

  it('folds successful first-party mutation paths from their raw arguments', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', {
        file_path: 'out/index.html', path: 'wrong-write.txt', content: '<html></html>',
      }),
      result(3, 'write'),
      call(4, 'edit', 'edit', {
        file_path: 'out/app.css', path: 'wrong-edit.txt', old_string: 'red', new_string: 'blue',
        replace_all: false,
      }),
      result(5, 'edit'),
      call(6, 'create', 'str_replace_editor', {
        command: 'create', path: 'notes/new.md', file_path: 'wrong-create.txt', file_text: 'new',
      }),
      result(7, 'create'),
      call(8, 'replace', 'str_replace_editor', {
        command: 'str_replace', path: 'notes/existing.md', old_str: 'old', new_str: 'new',
      }),
      result(9, 'replace'),
      call(10, 'delete-text', 'str_replace_editor', {
        command: 'str_replace', path: 'notes/deleted-text.md', old_str: 'remove me',
      }),
      result(11, 'delete-text'),
      call(12, 'insert', 'str_replace_editor', {
        command: 'insert', path: 'notes/inserted.md', insert_line: 1, new_str: 'line',
      }),
      result(13, 'insert'),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([
      'out/index.html',
      'out/app.css',
      'notes/new.md',
      'notes/existing.md',
      'notes/deleted-text.md',
      'notes/inserted.md',
    ])
  })

  it.each([
    { caseName: 'write omits content', name: 'write', args: { file_path: 'write.txt' } },
    { caseName: 'write has non-string content', name: 'write', args: { file_path: 'write.txt', content: 1 } },
    {
      caseName: 'edit omits old_string', name: 'edit',
      args: { file_path: 'edit.txt', new_string: 'new' },
    },
    {
      caseName: 'edit has an empty old_string', name: 'edit',
      args: { file_path: 'edit.txt', old_string: '', new_string: 'new' },
    },
    {
      caseName: 'edit omits new_string', name: 'edit',
      args: { file_path: 'edit.txt', old_string: 'old' },
    },
    {
      caseName: 'edit does not change the string', name: 'edit',
      args: { file_path: 'edit.txt', old_string: 'same', new_string: 'same' },
    },
    {
      caseName: 'edit has a non-boolean replace_all', name: 'edit',
      args: { file_path: 'edit.txt', old_string: 'old', new_string: 'new', replace_all: 'yes' },
    },
    {
      caseName: 'editor create omits file_text', name: 'str_replace_editor',
      args: { command: 'create', path: 'create.txt' },
    },
    {
      caseName: 'editor create has non-string file_text', name: 'str_replace_editor',
      args: { command: 'create', path: 'create.txt', file_text: 1 },
    },
    {
      caseName: 'editor replace omits old_str', name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'replace.txt', new_str: 'new' },
    },
    {
      caseName: 'editor replace has an empty old_str', name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'replace.txt', old_str: '' },
    },
    {
      caseName: 'editor replace has non-string new_str', name: 'str_replace_editor',
      args: { command: 'str_replace', path: 'replace.txt', old_str: 'old', new_str: 1 },
    },
    {
      caseName: 'editor insert omits insert_line', name: 'str_replace_editor',
      args: { command: 'insert', path: 'insert.txt', new_str: 'new' },
    },
    {
      caseName: 'editor insert has a fractional insert_line', name: 'str_replace_editor',
      args: { command: 'insert', path: 'insert.txt', insert_line: 1.5, new_str: 'new' },
    },
    {
      caseName: 'editor insert has a negative insert_line', name: 'str_replace_editor',
      args: { command: 'insert', path: 'insert.txt', insert_line: -1, new_str: 'new' },
    },
    {
      caseName: 'editor insert omits new_str', name: 'str_replace_editor',
      args: { command: 'insert', path: 'insert.txt', insert_line: 1 },
    },
  ])('ignores a successful result when $caseName', ({ name, args }) => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'malformed', name, args),
      result(3, 'malformed'),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([])
  })

  it('ignores editor views, unsupported tools, failures, interruptions, malformed calls, and orphan results', () => {
    const replacement = result(25, 'replacement')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'view', 'str_replace_editor', { command: 'view', path: 'viewed.txt' }),
      result(3, 'view'),
      call(4, 'read', 'read', { file_path: 'input.txt' }),
      result(5, 'read'),
      call(6, 'unknown', 'custom_edit', { file_path: 'custom.txt', path: 'custom.txt' }),
      result(7, 'unknown'),
      call(8, 'failed', 'write', { file_path: 'failed.txt', content: 'x' }),
      result(9, 'failed', true),
      call(10, 'interrupted', 'edit', {
        file_path: 'interrupted.txt', old_string: 'old', new_string: 'new',
      }),
      rawCall(11, 'invalid-json', 'write', '{'),
      result(12, 'invalid-json'),
      rawCall(13, 'null-args', 'write', 'null'),
      result(14, 'null-args'),
      rawCall(15, 'array-args', 'edit', '[]'),
      result(16, 'array-args'),
      call(17, 'missing-path', 'write', { content: 'x' }),
      result(18, 'missing-path'),
      call(19, 'blank-path', 'edit', {
        file_path: '   ', old_string: 'old', new_string: 'new',
      }),
      result(20, 'blank-path'),
      call(21, 'missing-editor-path', 'str_replace_editor', { command: 'create', file_text: 'x' }),
      result(22, 'missing-editor-path'),
      result(23, 'orphan'),
      call(24, 'replacement', 'str_replace_editor', {
        command: 'insert', path: 'replaced.txt', insert_line: 0, new_str: 'new',
      }),
      {
        ...replacement,
        event: {
          ...replacement.event,
          surfaceOp: { op: 'replace', start: 1, end: 1 },
        } as SessionEvent,
      },
      at(26, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([])
  })

  it('rejects an invalid start match and preserves state for an unrelated update', () => {
    const startMatch = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const emptyContext: Parameters<typeof deliverablesDefinition.start>[0] = {
      key: 'deliverables:1',
      kind: 'deliverables',
      id: '1',
      matches: [startMatch],
      start: startMatch,
      state: undefined,
      current: new Map(),
    }
    const reader: Parameters<typeof deliverablesDefinition.start>[2] = { previous: () => undefined }
    const state = deliverablesDefinition.start(emptyContext, startMatch, reader)
    const unrelated = matched(at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'update')
    const context: Parameters<typeof deliverablesDefinition.update>[0] = { ...emptyContext, state }

    expect(() => deliverablesDefinition.start(
      emptyContext,
      unrelated as ConversationStartMatch,
      reader,
    ))
      .toThrow('deliverables start requires turn/start')
    expect(deliverablesDefinition.update(context, unrelated)).toBe(state)
    for (const files of [[], [null, { path: '' }]]) {
      const declaration = matched(at(3, 'deliverables/presented', { turn: 1, callId: 'present', files }), 'update')
      expect(deliverablesDefinition.update(context, declaration)).toBe(state)
    }
  })

  it('replays a tail page once prepend supplies its missing Turn start', () => {
    const value = assembler([
      call(10, 'late', 'write', { file_path: 'history.txt', content: 'history' }),
      result(11, 'late'),
    ], true)
    expect(deliverablesOf(value)).toBeUndefined()

    value.prepend([at(1, 'turn/start', { turn: 1 })], false)
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['history.txt'])
  })

  it('extends the same Turn data incrementally on live append', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'first', 'write', { file_path: 'first.txt', content: 'first' }),
      result(3, 'first'),
    ])
    const first = deliverablesOf(value)
    expect(producedForClosing(first)).toEqual(['first.txt'])

    value.append(call(4, 'second', 'edit', {
      file_path: 'second.txt', old_string: 'before', new_string: 'after',
    }))
    value.flush()
    expect(deliverablesOf(value)).toBe(first)

    value.append(result(5, 'second'))
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['first.txt', 'second.txt'])
  })
})

const changedFile = (display: string, added = 1, deleted = 0, extra: { binary?: true; oversized?: true; path?: string } = {}) =>
  ({
    path: extra.path ?? display, display, added, deleted,
    ...extra.binary === true ? { binary: true as const } : {},
    ...extra.oversized === true ? { oversized: true as const } : {},
  })

const changesEvent = (seq: number, turn = 1) => at(seq, 'workspace/changes', { turn })

describe('announced changes Turn data', () => {
  it('keeps the latest valid announcement of the turn and ignores malformed ones', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      changesEvent(2),
      at(3, 'workspace/changes', { turn: 'x' }),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      changesEvent(5),
      at(6, 'turn/start', { turn: 2 }),
    ])
    const owner = tailOwner(deliverablesOf(value), 4)
    expect(changesForClosing(owner)).toEqual({ seq: 5 })
    expect(selectDeliverables(owner)).toEqual({ changes: { seq: 5 }, presented: [] })
    expect(changesForClosing(tailOwner(deliverablesOf(value, 2), 8))).toBeNull()
    expect(selectDeliverables(tailOwner(deliverablesOf(value, 2), 8))).toBeNull()
    expect(changesForClosing(tailOwner(undefined, 8))).toBeNull()
  })

  it('preserves Turn data identity across unrelated appends', () => {
    const value = assembler([at(1, 'turn/start', { turn: 1 }), changesEvent(2)])
    const first = deliverablesOf(value)
    value.append(call(3, 'later', 'read', { file_path: 'a.ts' }))
    value.flush()
    expect(deliverablesOf(value)).toBe(first)
  })
})

describe('ChangedFiles card', () => {
  const files = [
    changedFile('config/design-token', 42, 11), changedFile('config/feature-flags.json', 143, 32),
    changedFile('config/launch-plan.yaml', 654, 9), changedFile('src/index.ts', 393, 274),
    changedFile('~/.zshrc', 0, 0, { binary: true, path: '/home/u/.zshrc' }),
  ]
  const changes = { seq: 5 }
  const served: ChangesSummary = { turn: 1, files, total: 11, added: 1232, deleted: 326 }

  /** A store already holding the summary the Host served for the announced sequence. */
  function servedStore(summary: ChangesSummary = served, seq = 5) {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [changesSummaryUrl(SessionId('child-session'), seq)]: summary })
    return summaries
  }

  function renderCard(
    controller = new PresentedOpenController(), locale = en, matched = { changes, presented: [] as never[] }, summaries = servedStore(),
  ) {
    const props = openProps(controller, summaries)
    props.openChanged.mockResolvedValue(null)
    const openFile = vi.fn<(path: string) => void>()
    const view = render(<Deliverables {...props} matched={matched} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(locale)} />)
    return { props, openFile, view }
  }

  it.each([en, zh])('shows one edited filename without a list and opens its review', (locale) => {
    const single = servedStore({ turn: 1, files: [changedFile('src/example.scss', 3, 1)], total: 1, added: 3, deleted: 1 })
    const { props, view } = renderCard(new PresentedOpenController(), locale, { changes, presented: [] }, single)
    const t = makeTranslate(locale)
    const card = view.container.querySelector('[data-changed-files]')!
    expect(within(card as HTMLElement).getByText(t('changes.singleTitle', { name: 'example.scss' }))).toBeTruthy()
    expect(card.querySelector('ul')).toBeNull()
    expect(view.queryByRole('button', { name: /Show all|Collapse changed|展开全部|收起改动/ })).toBeNull()
    expect(card.querySelector('svg [data-file-type-mark]')?.children).toHaveLength(3)
    const open = view.getByRole('button', { name: t('changes.viewDiff', { name: 'src/example.scss' }) })
    expect(open.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(open)
    expect(props.openChangesReview).toHaveBeenCalledExactlyOnceWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
  })

  it.each(['binary', 'oversized'] as const)('keeps the %s status in a single-file header', (flag) => {
    const single = servedStore({ turn: 1, files: [changedFile('asset.bin', 0, 0, { [flag]: true })], total: 1, added: 0, deleted: 0 })
    const { view } = renderCard(new PresentedOpenController(), en, { changes, presented: [] }, single)
    expect(view.getByText(en[`changes.${flag}`])).toBeTruthy()
    expect(view.queryByText('+0')).toBeNull()
    expect(view.queryByRole('list')).toBeNull()
  })

  it('hides changed files and avoids summary reads when developer tools are off', () => {
    const props = openProps(new PresentedOpenController(), servedStore())
    const base = { ...props, matched: { changes, presented: [] }, openFile: vi.fn(), sessionId: SessionId('child-session'), t: makeTranslate(en) }
    const off = { useShowCodeDiff: <T,>(select: (enabled: boolean) => T): T => select(false) }
    const view = render(<Deliverables {...base} {...off} />)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
    expect(props.loadChangesSummary).not.toHaveBeenCalled()
    view.rerender(<Deliverables {...base} />)
    expect(view.container.querySelector('[data-changed-files]')).not.toBeNull()
    view.rerender(<Deliverables {...base} {...off} />)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
  })

  it('reads the announced summary once and renders nothing while it loads, when it is gone, or when it lists no file', async () => {
    const summaries = new ChangesSummaryStore()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('seq=5')) return Response.json(served)
      if (url.endsWith('seq=6')) return Response.json({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
      return new Response('gone', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { props, view } = renderCard(new PresentedOpenController(), en, { changes, presented: [] as never[] }, summaries)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
    expect(props.loadChangesSummary).toHaveBeenCalledWith('child-session', 5)
    await vi.waitFor(() => { expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toEqual(served) })
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.getByText('Edited 11 files')).toBeTruthy()
    for (const seq of [6, 7]) {
      view.rerender(<Deliverables {...props} matched={{ changes: { seq }, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
      await vi.waitFor(() => { expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), seq)]).not.toBe('loading') })
      view.rerender(<Deliverables {...props} matched={{ changes: { seq }, presented: [] }} openFile={() => {}} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
      expect(view.container.querySelector('[data-changed-files]')).toBeNull()
    }
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 7)]).toBe('missing')
    await summaries.load(SessionId('child-session'), 5)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // A replaced connection forgets every read; a later mount asks the new Host again.
    summaries.reset()
    expect(summaries.state.getSnapshot()).toEqual({})
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await summaries.load(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toBe('missing')
    fetchMock.mockResolvedValueOnce(Response.json({ turn: 'x' }))
    await summaries.load(SessionId('child-session'), 8)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 8)]).toBe('missing')
    await summaries.dispose()
    await summaries.load(SessionId('child-session'), 9)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 9)]).toBeUndefined()
  })

  it('sums the header from the Host totals, not from the capped list', () => {
    const capped = servedStore({ turn: 1, files: files.slice(0, 1), total: 2, added: 50, deleted: 20 })
    const { view } = renderCard(new PresentedOpenController(), en, { changes, presented: [] as never[] }, capped)
    expect(view.getByText('Edited 2 files')).toBeTruthy()
    expect(view.getByText('+50')).toBeTruthy()
    expect(view.getByText('-20')).toBeTruthy()
  })

  it('lets no read started before a reset publish afterwards', async () => {
    const summaries = new ChangesSummaryStore()
    let settle!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const stale = summaries.load(SessionId('child-session'), 5)
    summaries.reset()
    const url = changesSummaryUrl(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[url]).toBeUndefined()
    settle(Response.json(served))
    await stale
    // The reset abandoned the read; a later mount asks the new Host afresh.
    expect(summaries.state.getSnapshot()[url]).toBeUndefined()
    await summaries.dispose()
  })

  it('drops a read that settles after disposal', async () => {
    const summaries = new ChangesSummaryStore()
    let settle!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const loading = summaries.load(SessionId('child-session'), 5)
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toBe('loading')
    const disposal = summaries.dispose()
    settle(Response.json(served))
    await Promise.all([loading, disposal])
    expect(summaries.state.getSnapshot()[changesSummaryUrl(SessionId('child-session'), 5)]).toBe('loading')
  })

  it('summarizes the turn, folds after four rows, and opens the review from the header and each row', () => {
    const { props, openFile, view } = renderCard()
    const card = view.container.querySelector('[data-changed-files]')
    if (!(card instanceof HTMLElement)) throw new Error('changed-files card missing')
    expect(within(card).getByText('Edited 11 files')).toBeTruthy()
    expect(within(card).getByText('+1,232')).toBeTruthy()
    expect(within(card).getByText('-326')).toBeTruthy()
    expect(within(card).getByText('Preview in sidebar')).toBeTruthy()
    expect(within(card).getAllByRole('listitem')).toHaveLength(4)
    expect(within(within(card).getByRole('button', { name: 'View changes to config/design-token' })).getByText('config/design-token')).toBeTruthy()
    expect(within(card).getByText('+42')).toBeTruthy()
    expect(within(within(card).getByRole('button', { name: 'View changes to src/index.ts' })).getByText('src/index.ts')).toBeTruthy()
    expect(within(card).queryByText('~/.zshrc')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Review this turn’s changes in the sidebar' })
      .querySelector('svg')?.getAttribute('width')).toBe('20')
    fireEvent.click(within(card).getByRole('button', { name: 'View changes to config/feature-flags.json' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 1)
    expect(props.openChanged).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Review this turn’s changes in the sidebar' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    expect(openFile).not.toHaveBeenCalled()
    const expand = within(card).getByRole('button', { name: 'Show all 5 changed files' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(expand.textContent).toContain('All 5 files')
    fireEvent.click(expand)
    expect(within(card).getAllByRole('listitem')).toHaveLength(5)
    expect(within(card).getByText('binary')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'View changes to ~/.zshrc' }).getAttribute('title')).toBeNull()
    expect(within(card).getByRole('button', { name: 'View changes to ~/.zshrc', description: '/home/u/.zshrc' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'View changes to ~/.zshrc' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 4)
    const collapse = within(card).getByRole('button', { name: 'Collapse changed files' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(card.lastElementChild).toBe(collapse)
    fireEvent.click(collapse)
    expect(within(card).getAllByRole('listitem')).toHaveLength(4)
  })

  it('opens the review the same way without a desktop', () => {
    const controller = new PresentedOpenController()
    const { openFile, props, view } = renderCard(controller, zh)
    controller.host.set('error')
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(zh)} />)
    expect(view.getByRole('button', { name: '在侧边栏查看本轮改动' })).toBeTruthy()
    controller.host.set({ name: 'server', available: false, fileManager: null })
    view.rerender(<Deliverables {...props} matched={{ changes, presented: [] }} openFile={openFile} sessionId={SessionId('child-session')} t={makeTranslate(zh)} />)
    expect(view.getByText('已编辑 11 个文件')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '在侧边栏查看本轮改动' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    fireEvent.click(view.getByRole('button', { name: '查看 config/design-token 的改动' }))
    expect(props.openChangesReview).toHaveBeenLastCalledWith({ sessionId: 'child-session', seq: 5, turn: 1 }, 0)
    expect(openFile).not.toHaveBeenCalled()
    expect(props.openChanged).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: '展开全部 5 个改动文件' }).textContent).toContain('全部 5 个文件')
  })

  it('preserves expanded rows when the served announcement changes', () => {
    const summaries = servedStore()
    summaries.state.set({ ...summaries.state.getSnapshot(), [changesSummaryUrl(SessionId('child-session'), 6)]: served })
    const { props, openFile, view } = renderCard(new PresentedOpenController(), en, { changes, presented: [] }, summaries)
    const card = view.container.querySelector('[data-changed-files]')
    fireEvent.click(view.getByRole('button', { name: 'Show all 5 changed files' }))
    view.rerender(<Deliverables {...props} matched={{ changes: { seq: 6 }, presented: [] }} openFile={openFile}
      sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.container.querySelector('[data-changed-files]')).toBe(card)
    expect(view.getAllByRole('listitem')).toHaveLength(5)
    expect(view.getByRole('button', { name: 'Collapse changed files' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps every count in place whatever the native-open gestures of the review tab are doing', () => {
    const controller = new PresentedOpenController()
    controller.state.set({
      'api/changes.open?sessionId=child-session&seq=5&index=0': 'opening',
      'api/changes.open?sessionId=child-session&seq=5&index=1': 'error',
    })
    const { view } = renderCard(controller)
    // Native-open gestures belong to the review tab; the card shows counts only.
    expect(view.queryByText(en['presented.opening'])).toBeNull()
    expect(view.queryByText(en['presented.error'])).toBeNull()
    expect(view.getByText('+42')).toBeTruthy()
    expect(view.getByText('+143')).toBeTruthy()
    expect(view.getByText('+1,232')).toBeTruthy()
  })

  it('renders without a fold for three files or fewer and beside delivery cards', () => {
    const short = servedStore({ turn: 1, files: [...files.slice(0, 1), changedFile('huge.bin', 0, 0, { oversized: true })], total: 2, added: 185, deleted: 43 })
    const { view } = renderCard(new PresentedOpenController(), en, { changes, presented: [{ path: 'report.pdf', seq: 6, index: 0 }] as never[] }, short)
    expect(view.getByText('Edited 2 files')).toBeTruthy()
    expect(view.getByText('too large')).toBeTruthy()
    expect(view.queryByRole('button', { name: /Show all|Collapse changed/ })).toBeNull()
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(1)
    expect(view.container.querySelector('[data-presented-files-row]')?.parentElement?.getAttribute('data-after-changes')).toBe('true')
  })
})

describe('producedFileMentions resolver', () => {
  const label = (path: string) => `打开 ${path}`

  it('resolves exact paths and unique basenames; ambiguity and unknowns stay unresolved', () => {
    const opened: string[] = []
    const resolver = producedFileMentions(
      ['out/index.html', 'a/style.css', 'b/style.css'],
      (path) => { opened.push(path) },
      label,
    )
    // Unique basename resolves to its full path; the full path rides title.
    const byBasename = resolver.resolve('index.html')
    expect(byBasename?.label).toBe('打开 out/index.html')
    expect(byBasename?.title).toBe('out/index.html')
    byBasename?.open()
    expect(opened).toEqual(['out/index.html'])
    // An exact path resolves even when its basename is ambiguous.
    const exact = resolver.resolve('a/style.css')
    expect(exact?.title).toBe('a/style.css')
    // A basename two paths share stays unresolved rather than guessing,
    // and so does a token naming nothing the turn wrote.
    expect(resolver.resolve('style.css')).toBeUndefined()
    expect(resolver.resolve('notes.md')).toBeUndefined()
    expect(basename('a\\b\\c.txt')).toBe('c.txt')
  })
})


describe('plugin registration', () => {
  it('registers the tail entry and fiber disposal removes it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new UiConversation(ctx, { binding: () => undefined } as never)
    // The owning view's child declaration, stood up by a bench root entry.
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    const registerTab = vi.fn(() => () => { registered = undefined })
    let registered: unknown
    ctx.provide('sidebarRightTabs', { register: (definition: unknown) => { registered = definition; return registerTab() } } as never)
    const openResource = vi.fn()
    ctx.provide('sidebarRight', { openResource } as never)
    // ui-theme's Appearance row binds a durable scope through these two.
    const session = {
      canOpenWorkspacePath: () => Promise.resolve({ ok: true as const, value: true }),
    }
    ctx.provide('remote', {
      $on: () => () => {},
      $host: { home: undefined, isLoopback: false },
      session,
    } as never)
    ctx.provide('remote.session', session as never)
    ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = ctx.slots.entries('conversation.chat.turnTail')
    expect(entry).toBeDefined()
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(1)
    expect(entry?.inject).toBeDefined()
    expect(registered).toMatchObject({ kind: 'changes-review', patterns: ['dsh-resource://changes-review/**'] })
    const [tabEntry] = ctx.slots.entries('sidebar.right.pane.tab')
    expect(tabEntry?.options.key).toBe('@deepseek-ai/dsh-client-ui-deliverables')

    // The prose face is live while the plugin is: a produced turn yields a
    // resolver whose matches open through the owner-supplied opener.
    const opened: string[] = []
    const owner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
    )
    const service = (ctx as { get(name: string): ChatFileMentions | undefined }).get('chatFileMentions')
    const mentions = service?.forClosing(owner, SessionId('viewed-session'))
    expect(mentions?.resolve('report.html')?.label).toBe('Open site/report.html in sidebar')
    mentions?.resolve('report.html')?.open()
    expect(opened).toEqual(['site/report.html'])
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const preview = vi.fn<(path: string) => void>()
    for (const produced of [[], [{ path: 'out/report.docx', seq: 1 }]]) {
      const delivered = tailOwner({ produced, presented: [{ path: 'out/report.docx', seq: 2, index: 0 }] }, 3, preview)
      const mentions = service?.forClosing(delivered, SessionId('child-session'))
      for (const text of ['report.docx', 'out/report.docx']) {
        const mention = mentions?.resolve(text)
        expect(mention?.label).toBe('Open out/report.docx in sidebar')
        mention?.open()
      }
    }
    expect(preview.mock.calls).toEqual(Array.from({ length: 4 }, () => ['out/report.docx']))
    expect(fetcher).not.toHaveBeenCalled()
    const face = entry!.inject!(SessionId('child-session') as never) as unknown as DeliverablesInjected
    fetcher.mockResolvedValueOnce(Response.json({ name: 'desktop', available: true, fileManager: 'finder' }))
    await face.reloadPresentedHost()
    expect(face.hooks.presentedHost.getSnapshot()).toMatchObject({ name: 'desktop' })
    fetcher.mockResolvedValueOnce(Response.json({ turn: 1, files: [], total: 0, added: 0, deleted: 0 }))
    await face.loadChangesSummary(SessionId('child-session'), 5)
    expect(face.hooks.changesSummary.getSnapshot()['api/changes.summary?sessionId=child-session&seq=5']).toEqual({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
    ctx.emit('connection/reset')
    expect(face.hooks.presentedHost.getSnapshot()).toBeNull()
    // The replaced connection may reach a Host that no longer serves the summaries read so far.
    expect(face.hooks.changesSummary.getSnapshot()).toEqual({})
    await face.openPresented(SessionId('child-session'), 2, 0)
    expect(face.hooks.presentedOpen.getSnapshot()['api/present.open?sessionId=child-session&seq=2&index=0']).toBe('opened')
    await face.openChanged(SessionId('child-session'), 5, 0)
    expect(face.hooks.presentedOpen.getSnapshot()['api/changes.open?sessionId=child-session&seq=5&index=0']).toBe('opened')
    face.openChangesReview({ sessionId: SessionId('child-session'), seq: 5, turn: 3 }, 1)
    expect(openResource).toHaveBeenCalledWith('dsh-resource://changes-review/session/child-session/5/3', { params: { index: 1 } })
    expect((registered as { title(address: string): string }).title('dsh-resource://changes-review/session/child-session/5/3')).toBe('Review · turn 3')
    const tabFace = tabEntry!.inject!(SessionId('child-session') as never) as unknown as ReviewInjected
    fetcher.mockResolvedValueOnce(Response.json({ turn: 3, files: [], total: 0, added: 0, deleted: 0 }))
    await tabFace.loadChangesSummary(SessionId('child-session'), 6)
    expect(tabFace.hooks.changesSummary.getSnapshot()['api/changes.summary?sessionId=child-session&seq=6']).toEqual({ turn: 3, files: [], total: 0, added: 0, deleted: 0 })
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'binary', path: 'src/a.ts', display: 'src/a.ts' }))
    await face.loadChangesDiff(SessionId('child-session'), 5, 1)
    expect(face.hooks.changesDiff).toBe(tabFace.hooks.changesDiff)
    expect(face.hooks.changesDiff.getSnapshot()['api/changes.diff?sessionId=child-session&seq=5&index=1']).toEqual({ kind: 'binary', path: 'src/a.ts', display: 'src/a.ts' })
    const readsAfterHover = fetcher.mock.calls.length
    await tabFace.loadChangesDiff(SessionId('child-session'), 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(readsAfterHover)
    expect(tabFace.hooks.changesDiff.getSnapshot()['api/changes.diff?sessionId=child-session&seq=5&index=1']).toEqual({ kind: 'binary', path: 'src/a.ts', display: 'src/a.ts' })
    expect(tabFace.hooks.presentedHost).toBe(face.hooks.presentedHost)
    fetcher.mockResolvedValueOnce(Response.json({ name: 'desktop', available: true, fileManager: 'finder' }))
    await tabFace.reloadPresentedHost()
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await tabFace.openChanged(SessionId('child-session'), 5, 1)
    expect(tabFace.hooks.presentedOpen.getSnapshot()['api/changes.open?sessionId=child-session&seq=5&index=1']).toBe('opened')
    ctx.emit('connection/reset')
    expect(tabFace.hooks.changesDiff.getSnapshot()).toEqual({})
    // A turn that produced nothing yields no vocabulary at all.
    expect(service?.forClosing(tailOwner(undefined, 2), SessionId('viewed-session'))).toBeUndefined()

    fetcher.mockResolvedValueOnce(Response.json({ name: 'last-host', available: true, fileManager: 'finder' }))
    await face.reloadPresentedHost()
    await fiber.dispose()
    const reset = vi.fn()
    const unsubscribe = face.hooks.presentedHost.subscribe(reset)
    ctx.emit('connection/reset')
    expect(reset).not.toHaveBeenCalled()
    unsubscribe()
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(registered).toBeUndefined()
    // Fiber teardown retracts the service: the consumer's ctx.get sees the off state.
    expect((ctx as { get(name: string): unknown }).get('chatFileMentions')).toBeUndefined()
  })
})


describe('presented files', () => {
  const file = (path = 'report.docx') => ({ path })

  it('replays deliveries without mutation calls, preserves indices, and isolates turns', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'deliverables/presented', { turn: 1, callId: 'nested', files: [null, { ...file(), description: 'Final report' }] }),
      at(3, 'deliverables/presented', { turn: 1, callId: 'again', files: [{ ...file(), description: 'Updated report' }] }),
      at(4, 'turn/end', { turn: 1 }),
      at(5, 'turn/start', { turn: 2 }),
    ])
    const first = presentedForClosing(tailOwner(deliverablesOf(value), 3))
    expect(first).toMatchObject([{ path: 'report.docx', seq: 2, index: 1, description: 'Final report' }])
    expect(presentedForClosing(tailOwner(deliverablesOf(value), 4)))
      .toMatchObject([{ path: 'report.docx', seq: 3, description: 'Updated report' }])
    expect(selectDeliverables(tailOwner(deliverablesOf(value, 2), 9))).toBeNull()
  })

  it('uses the viewed fork Session in every open action and expands all delivered files', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'deliverables/presented', { turn: 1, callId: 'nested', files: Array.from({ length: 8 }, (_, i) => file(`report-${i}.docx`)) }),
    ])
    const preview = vi.fn()
    const owner = tailOwner(deliverablesOf(value), 3, preview)
    const matched = selectDeliverables(owner)!
    const props = openProps()
    props.openPresented.mockResolvedValue(null)
    const view = render(<Deliverables {...props} matched={matched} openFile={owner.openFile} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    const expand = view.getByRole('button', { name: 'Show all 8 delivered files' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(8)
    expect(view.getByRole('button', { name: 'Collapse delivered files' }).getAttribute('aria-expanded')).toBe('true')
    expect(view.queryByRole('link')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Preview report-0.docx in sidebar' }))
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenLastCalledWith('report-0.docx')
    fireEvent.click(view.getAllByRole('button', { name: 'Native file action' })[0]!)
    expect(props.openPresented).toHaveBeenCalledWith('child-session', 2, 0, 'open', undefined)
    fireEvent.click(view.getByRole('button', { name: 'Collapse delivered files' }))
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    expect(view.container.querySelector('[data-changed-files]')).toBeNull()
  })
})


it.each([null, [], 'invalid'])('declines non-object delivery data: %j', (data) => {
  expect(deliverablesDefinition.match(at(1, 'deliverables/presented', data).event)).toBeNull()
})

it.each([{}, { turn: '1', callId: 'bad', files: [] },
  { turn: 1.5, callId: 'bad', files: [] }, { turn: 0, callId: 'bad', files: [] },
  { turn: 1, files: [] }, { turn: 1, callId: '', files: [] }, { turn: 1, callId: 'bad', files: null },
])('ignores malformed delivery data and keeps the recorded changes card: %j', (data) => {
  const value = assembler([
    at(1, 'turn/start', { turn: 1 }),
    call(2, 'write-a', 'write', { file_path: 'a.txt', content: 'a' }),
    result(3, 'write-a'),
    at(4, 'deliverables/presented', data),
    at(5, 'workspace/changes', { turn: 1 }),
  ])
  const owner = tailOwner(deliverablesOf(value), 6)
  const matched = selectDeliverables(owner)!
  const summaries = new ChangesSummaryStore()
  summaries.state.set({ [changesSummaryUrl(SessionId('session'), 5)]: { turn: 1, files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 } })
  const view = render(<Deliverables {...openProps(new PresentedOpenController(), summaries)} matched={matched} openFile={owner.openFile} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Edited a.txt')).toBeTruthy()
  expect(view.queryByText('Deliverables')).toBeNull()
})

it('shows descriptions and falls back to file metadata without hiding extensionless deliveries', () => {
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented: [
    { path: 'out/report.txt', description: 'Quarterly summary', seq: 2, index: 0 },
    { path: 'LICENSE', seq: 2, index: 1 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Quarterly summary')).toBeTruthy()
  expect(view.getByText('File')).toBeTruthy()
  expect(view.getByTitle('out/report.txt')).toBeTruthy()
  expect(view.getByText('report.txt')).toBeTruthy()
})

it('distinguishes PDF, Word, Markdown, and code files with compact decorative card icons', () => {
  const paths = ['report.pdf', 'report.docx', 'README.md', 'index.tsx']
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented:
    paths.map((path, index) => ({ path, seq: 2, index })),
  }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  const icons = [...view.container.querySelectorAll('[data-presented-file]')].map((card) => {
    const icon = card.querySelector('svg')!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('width')).toBe('20')
    return icon.innerHTML
  })
  expect(new Set(icons).size).toBe(paths.length)
})

it('lets one delivered file span the complete row without an expansion control', () => {
  const view = render(<Deliverables {...openProps()} matched={{ changes: null, presented: [
    { path: 'report.pdf', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.container.querySelector('[data-presented-files-row]')?.getAttribute('data-single')).toBe('true')
  expect(view.queryByRole('button', { name: /delivered files/ })).toBeNull()
})


it.each(['opening', 'opened', 'error'] as const)('shows the %s state and permits retries after failure', (phase) => {
  const controller = new PresentedOpenController()
  controller.state.set({ 'api/present.open?sessionId=session&seq=2&index=0': phase })
  const props = openProps(controller)
  const view = render(<Deliverables {...props} matched={{ changes: null, presented: [
    { path: 'report.txt', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en[`presented.${phase}`])).toBeTruthy()
  expect((view.getByRole('button', { name: 'Native file action' }) as HTMLButtonElement).disabled).toBe(phase === 'opening')
})


it('explains a missing desktop and retries failed Host metadata', () => {
  const controller = new PresentedOpenController()
  const props = openProps(controller)
  const matched = { changes: null, presented: [{ path: 'file.txt', seq: 2, index: 0 }] }
  controller.host.set('error')
  const view = render(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
  controller.host.set({ name: 'server', available: false, fileManager: null })
  view.rerender(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en['presented.unavailable'])).toBeTruthy()
})


it('loads desktop information once the tail renders and not again while it is known', () => {
  const controller = new PresentedOpenController()
  const props = openProps(controller)
  controller.host.set(null)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  const shared = { ...props, openFile: () => {}, sessionId: SessionId('session'), t: makeTranslate(en) }
  const view = render(<Deliverables {...shared} matched={{ changes: { seq: 2 }, presented: [] }} />)
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
  controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
  view.rerender(<Deliverables {...shared} matched={{ changes: null, presented: [{ path: 'report.txt', seq: 2, index: 0 }] }} />)
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
})

it('contributes file artifacts to the tail list only for turns with deliveries', () => {
  const owner = tailOwner(undefined, 3)
  const props = { ...openProps(), ...owner, sessionId: SessionId('session'), t: makeTranslate(en) } as unknown as Parameters<typeof DeliverablesTail>[0]
  const view = render(<DeliverablesTail {...props} />)
  expect(view.container.innerHTML).toBe('')
  const withFile = tailOwner({ produced: [], presented: [{ path: 'report.md', seq: 2, index: 0 }] }, 3)
  view.rerender(<DeliverablesTail {...props} {...withFile} />)
  expect(view.getByText('report.md')).toBeTruthy()
})
