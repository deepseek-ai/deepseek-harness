// @vitest-environment jsdom
/**
 * ui-deliverables browser half: the derivation contract of
 * `producedForClosing` over engine-published Turn data, the row's rendering
 * and opener wiring, and the plugin registrations' fiber-teardown removal
 * (HMR safety) against the real SlotRegistry.
 */
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
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { Deliverables, selectDeliverables, type DeliverablesInjected } from '../src/client/Deliverables.tsx'
import { PresentedOpenController } from '../src/client/present-open.ts'
import { ProducedFiles } from '../src/client/ProducedFiles.tsx'
import {
  basename, deliverablesDefinition, presentedForClosing, producedFileMentions, producedForClosing, selectProducedFiles,
  type DeliverablesTurnData,
} from '../src/client/turn-deliverables.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

function openProps(controller = new PresentedOpenController()) {
  controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
  const sessions: SessionListState = { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }
  return {
    useSessions: <T,>(select: (state: SessionListState) => T): T => select(sessions),
    reloadPresentedHost: vi.fn(() => controller.loadHost()),
    usePresentedHost: <T,>(select: (state: ReturnType<typeof controller.host.getSnapshot>) => T): T =>
      select(controller.host.getSnapshot()),
    openPresented: vi.fn((...args: Parameters<PresentedOpenController['open']>) => controller.open(...args)),
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
      source: { type: 'tool-result', callId },
      content: [{ type: 'tool-result', content: [], isError }],
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

describe('ProducedFiles row', () => {
  const t = makeTranslate(zh)

  it('renders the bounded chips and opens the file it was clicked for', () => {
    const paths = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']
    const openFile = vi.fn<(path: string) => void>()

    const view = render(<ProducedFiles matched={paths} openFile={openFile} t={t} />)
    expect(view.getByText('本轮文件改动')).toBeTruthy()
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getAllByRole('button')).toHaveLength(6)
    expect(within(row).getByText('+ 2 个文件')).toBeTruthy()
    const chip = view.getByRole('button', { name: '打开 deep/a.html' })
    expect(chip.textContent).toBe('a.html')
    expect(chip.getAttribute('title')).toBe('deep/a.html')
    expect(view.queryByRole('button', { name: '打开 g.ts' })).toBeNull()
    fireEvent.click(chip)
    // The row hands over the path it was given; where it opens is the
    // Sidebar's decision, not this row's.
    expect(openFile).toHaveBeenCalledWith('deep/a.html')
  })

  it('renders a remainder counter after every chip but the last when every file fits', () => {
    const view = render(<ProducedFiles matched={['a.md', 'b.md', 'c.md']} openFile={() => {}} t={t} />)
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getAllByRole('button')).toHaveLength(3)
    // One counter per chip that could be the last visible one; the final chip hides nothing.
    expect([...row.querySelectorAll('[data-shown]')].map(node => node.getAttribute('data-shown'))).toEqual(['1', '2'])
  })

  it('offers no folder action, because a directory has no preview to open', () => {
    const openFile = vi.fn<(path: string) => void>()
    const overflowing = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']
    const view = render(<ProducedFiles matched={overflowing} openFile={openFile} t={t} />)
    expect(view.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
    // Nothing in the row reaches the local machine any more.
    expect(openFile).not.toHaveBeenCalled()
  })

  it('uses singular English copy when exactly one file is hidden', () => {
    const view = render(
      <ProducedFiles
        matched={['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']}
        openFile={() => {}}
        t={makeTranslate(en)}
      />,
    )
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getByText('+ 1 file')).toBeTruthy()
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
      children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
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
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = ctx.slots.entries('conversation.chat.turnTail')
    expect(entry).toBeDefined()
    expect(ctx.slots.entries('tool.call.toolview')).toHaveLength(1)
    expect(entry?.inject).toBeDefined()

    // The prose face is live while the plugin is: a produced turn yields a
    // resolver whose matches open through the owner-supplied opener.
    const opened: string[] = []
    const owner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
    )
    const service = (ctx as unknown as { get(name: string): ChatFileMentions | undefined }).get('chatFileMentions')
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
    ctx.emit('connection/reset')
    expect(face.hooks.presentedHost.getSnapshot()).toBeNull()
    await face.openPresented(SessionId('child-session'), 2, 0)
    expect(face.hooks.presentedOpen.getSnapshot()['/api/present.open?sessionId=child-session&seq=2&index=0']).toBe('opened')
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
    // Fiber teardown retracts the service: the consumer's ctx.get sees the off state.
    expect((ctx as unknown as { get(name: string): unknown }).get('chatFileMentions')).toBeUndefined()
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
    props.openPresented.mockResolvedValue(undefined)
    const view = render(<Deliverables {...props} matched={matched} openFile={owner.openFile} sessionId={SessionId('child-session')} t={makeTranslate(en)} />)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    const expand = view.getByRole('button', { name: 'Show all 8 delivered files' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(8)
    expect(view.getByRole('button', { name: 'Collapse delivered files' }).getAttribute('aria-expanded')).toBe('true')
    expect(view.queryByRole('link')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Preview report-0.docx in sidebar' }))
    fireEvent.click(view.getByRole('button', { name: 'Open report-0.docx in sidebar' }))
    expect(preview).toHaveBeenCalledTimes(2)
    expect(preview).toHaveBeenLastCalledWith('report-0.docx')
    fireEvent.click(view.getByRole('button', { name: 'More file actions for report-0.docx' }))
    fireEvent.click(view.getByRole('menuitem', { name: 'Open in default app' }))
    expect(props.openPresented).toHaveBeenCalledWith('child-session', 2, 0, 'open')
    fireEvent.click(view.getByRole('button', { name: 'Collapse delivered files' }))
    expect(view.container.querySelectorAll('[data-presented-file]')).toHaveLength(4)
    expect(view.queryByText('Files changed')).toBeNull()
  })
})


it.each([null, [], 'invalid'])('declines non-object delivery data: %j', (data) => {
  expect(deliverablesDefinition.match(at(1, 'deliverables/presented', data).event)).toBeNull()
})

it.each([{}, { turn: '1', callId: 'bad', files: [] },
  { turn: 1.5, callId: 'bad', files: [] }, { turn: 0, callId: 'bad', files: [] },
  { turn: 1, files: [] }, { turn: 1, callId: '', files: [] }, { turn: 1, callId: 'bad', files: null },
])('ignores malformed delivery data and keeps the existing produced row: %j', (data) => {
  const value = assembler([
    at(1, 'turn/start', { turn: 1 }),
    call(2, 'write-a', 'write', { file_path: 'a.txt', content: 'a' }),
    result(3, 'write-a'),
    at(4, 'deliverables/presented', data),
  ])
  const owner = tailOwner(deliverablesOf(value), 5)
  const matched = selectDeliverables(owner)!
  const view = render(<Deliverables {...openProps()} matched={matched} openFile={owner.openFile} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Files changed')).toBeTruthy()
  expect(view.queryByText('Deliverables')).toBeNull()
})

it('shows descriptions and falls back to file metadata without hiding extensionless deliveries', () => {
  const view = render(<Deliverables {...openProps()} matched={{ produced: [], presented: [
    { path: 'out/report.txt', description: 'Quarterly summary', seq: 2, index: 0 },
    { path: 'LICENSE', seq: 2, index: 1 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText('Quarterly summary')).toBeTruthy()
  expect(view.getByText('File')).toBeTruthy()
  expect(view.getByTitle('out/report.txt')).toBeTruthy()
  expect(view.getByText('report.txt')).toBeTruthy()
})

it('marks delivery cards that directly follow the produced-files row', () => {
  const shared = { ...openProps(), openFile: () => {}, sessionId: SessionId('session'), t: makeTranslate(en) }
  const presented = [{ path: 'report.txt', seq: 2, index: 0 }]
  const view = render(<Deliverables {...shared} matched={{ produced: ['source.ts'], presented }} />)
  expect(view.getByText('Files changed')).toBeTruthy()
  expect(view.container.querySelector('[data-presented-files-row]')?.parentElement
    ?.getAttribute('data-after-produced-files')).toBe('true')
})

it('distinguishes PDF, Word, Markdown, and code files with compact decorative card icons', () => {
  const paths = ['report.pdf', 'report.docx', 'README.md', 'index.tsx']
  const view = render(<Deliverables {...openProps()} matched={{ produced: [], presented:
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
  const view = render(<Deliverables {...openProps()} matched={{ produced: [], presented: [
    { path: 'report.pdf', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.container.querySelector('[data-presented-files-row]')?.getAttribute('data-single')).toBe('true')
  expect(view.queryByRole('button', { name: /delivered files/ })).toBeNull()
})


it.each(['opening', 'opened', 'error'] as const)('shows the %s state and permits retries after failure', (phase) => {
  const controller = new PresentedOpenController()
  controller.state.set({ '/api/present.open?sessionId=session&seq=2&index=0': phase })
  const props = openProps(controller)
  const view = render(<Deliverables {...props} matched={{ produced: [], presented: [
    { path: 'report.txt', seq: 2, index: 0 },
  ] }} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en[`presented.${phase}`])).toBeTruthy()
  expect((view.getByRole('button', { name: 'More file actions for report.txt' }) as HTMLButtonElement).disabled).toBe(phase === 'opening')
})


it('explains a missing desktop and retries failed Host metadata', () => {
  const controller = new PresentedOpenController()
  const props = openProps(controller)
  const matched = { produced: [], presented: [{ path: 'file.txt', seq: 2, index: 0 }] }
  controller.host.set('error')
  const view = render(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
  controller.host.set({ name: 'server', available: false, fileManager: null })
  view.rerender(<Deliverables {...props} matched={matched} openFile={() => {}} sessionId={SessionId('session')} t={makeTranslate(en)} />)
  expect(view.getByText(en['presented.unavailable'])).toBeTruthy()
})


it('loads desktop information only when delivery cards appear', () => {
  const controller = new PresentedOpenController()
  const props = openProps(controller)
  controller.host.set(null)
  props.reloadPresentedHost.mockResolvedValue(undefined)
  const shared = { ...props, openFile: () => {}, sessionId: SessionId('session'), t: makeTranslate(en) }
  const view = render(<Deliverables {...shared} matched={{ produced: ['source.ts'], presented: [] }} />)
  expect(props.reloadPresentedHost).not.toHaveBeenCalled()
  view.rerender(<Deliverables {...shared} matched={{ produced: [], presented: [{ path: 'report.txt', seq: 2, index: 0 }] }} />)
  expect(props.reloadPresentedHost).toHaveBeenCalledOnce()
})
