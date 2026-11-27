// @vitest-environment jsdom
import { syncedConfig } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ChatSnapshot, StartedToolCall, ToolCallBlock, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots/client'
import {
  ConversationEventRegistry, ConversationViewRegistry, EMPTY_CONVERSATION_SNAPSHOT, type ConvViewOwnerProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationInteractionRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/interaction-registry.ts'
import { en as conversationEn, NS as CONVERSATION_NS, zh as conversationZh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { apply as applyChat, inject as injectChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { apply as applyTool, inject as injectTool } from '../src/client/apply.ts'
import { toolChatSnapshot } from './tool-fixtures.client.ts'

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

const PROGRAM = 'const listing = await tools.bash({ command: "ls notes", description: "List notes" })\nreturn listing'
const RUN_CODE_ARGS = JSON.stringify({ code: PROGRAM, description: 'List the notes directory' })

const codeResult = (seq: number, callId: string, name = 'run_code', argsRaw = RUN_CODE_ARGS): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  name, args: PartialArguments.fromText(argsRaw),
  call: { name, argsRaw },
  callTime: seq * 1_000 - 500,
  content: [{ type: 'text', text: 'demo.txt' }], isError: false,
  subCalls: [],
})

const runningCode = (callId: string, name = 'run_code', argsRaw = RUN_CODE_ARGS): StartedToolCall => ({
  phase: 'start' as const, args: PartialArguments.fromText(argsRaw), callId, name, argsRaw, turn: 9, step: 0, time: 9_000,
  subCalls: [],
})

const subCall = (
  seq: number, parent: string, n: number, name: string, args: object, resultText: string, isError = false,
): ToolCallBlock => ({
  kind: 'tool-result', seq, time: seq * 1_000,
  callId: `${parent}:code:${n}`,
  name, args: PartialArguments.fromText(JSON.stringify(args)),
  parentCallId: parent,
  call: { name, argsRaw: JSON.stringify(args) },
  callTime: seq * 1_000,
  content: [{ type: 'text', text: resultText }], isError,
  subCalls: [],
})

const startedSubCall = (parent: string, n: number, name: string, args: object): ToolCallBlock => ({
  phase: 'start' as const, args: PartialArguments.fromText(JSON.stringify(args)), callId: `${parent}:code:${n}`, name,
  argsRaw: JSON.stringify(args), parentCallId: parent, turn: 0, step: 0, time: 21_000, subCalls: [],
})

function snapshotWith(
  nodes: ToolResultNode[],
  subCalls: readonly ToolCallBlock[],
  runningCalls: StartedToolCall[] = [],
): ChatSnapshot {
  const nestedNodes = nodes.map(node => ({ ...node, subCalls }))
  const nestedRunningCalls = runningCalls.map(call => ({ ...call, subCalls }))
  return toolChatSnapshot(nestedNodes, nestedRunningCalls)
}

/** Test-owned AppFrame role: declares and renders the Chat view list. */
type AppRootProps = PropsRenderSlots<'conversation.view'>
const VIEW_OWNER: ConvViewOwnerProps = {
  inspectCall: undefined,
  inspectRequest: undefined,
  viewRequest: null,
  openView: () => {},
  completeViewRequest: () => {},
}
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('conversation.view', VIEW_OWNER, { only: 'chat' })}</>
}

const ROOT_CHILDREN = {
  'conversation.view': { kind: 'list', scope: 'session' },
} as const

/**
 * Same real-stack bench as the toolview-slot spec: renderer, Chat target, and
 * Tool registrations; fakes only at service boundaries.
 */
async function bench(snapshot: ChatSnapshot) {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('fileDrag', { actions: { prepare: async () => ({ start: () => true, release: () => {} }), reportFailure: () => {} }, read: () => undefined } satisfies import('@deepseek-ai/cordis').Context['fileDrag'])
  runtimes.push(runtime)
  const ctx = runtime.ctx
  const chat = createSnapshotStore(snapshot)
  const conversation = createSnapshotStore(EMPTY_CONVERSATION_SNAPSHOT)
  const events = new ConversationEventRegistry(ctx)
  const views = new ConversationViewRegistry(ctx)
  ctx.provide('connection', { state: createSnapshotStore('connected') } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  ctx.provide('uiConversation', {
    events,
    views,
    interactions: new ConversationInteractionRegistry(ctx),
    groups: { register: () => () => {} },
    binding: () => ({ target: () => chat, snapshot: conversation }),
  } as never)
  ctx.uiSession.provide({
    hooks: ['conversation'],
    resolve: () => ({ hooks: { conversation } }),
  })

  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/w' },
    snapshot: { running: snapshot.legacy.runningCalls.length > 0 },
  })
  await runtime.sessions.retainFor(runtime.ctx, SID, { source: 'mainView', facets: { conversation: true } }).ready
  const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
  const openWorkspacePath = vi.fn(async () => ({ ok: true, value: { opened: true } }))
  ctx.provide('layout', layout as never)
  const sidebarRight = { openResource: vi.fn<(address: string) => void>() }
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('uiWorkspace', {} as never)
  runtime.remote.provideNamespaces({ session: { openWorkspacePath } })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register(CONVERSATION_NS, { zh: conversationZh, en: conversationEn })
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus }, syncedConfig({ resolutionTimeoutMs: 1000 }))

  await runtime.root.declare(ROOT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  return { runtime, layout, openWorkspacePath, sidebarRight }
}

function mountApp(runtime: SlotTestRuntime) {
  return runtime.renderRoot()
}

/** Open the first program call's header row, which mounts the source row and the sub-call rows. */
function openProgramCall(container: HTMLElement): void {
  fireEvent.click(container.querySelector('[data-program-call] [data-disclosure-row]')!)
}

describe('program sub-calls through the real chat machinery', () => {
  it('heads a program call with its description and sub-call count over the source row and the sub-calls', async () => {
    const parent = 'call-64'
    const subCalls = [
      subCall(11, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
      subCall(12, parent, 2, 'mystery', { n: 1 }, 'ok'),
    ]
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    const call = view.container.querySelector(`[data-chat-call-id="${parent}"]`)!
    const header = call.querySelector('[data-program-call="run_code"] [data-disclosure-row]')!
    expect(header.textContent).toBe('List the notes directory2 tool calls')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(call.querySelector('[data-variant="code"]')).toBeNull()
    expect(call.querySelector('[data-subcalls]')).toBeNull()

    fireEvent.keyDown(header, { key: 'Enter' })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.textContent).toBe('List the notes directory2 tool calls')
    const source = call.querySelector('[data-variant="code"] [data-disclosure-row]')!
    expect(source.textContent).toBe('Source code')
    expect(source.getAttribute('aria-expanded')).toBe('false')
    expect(call.querySelectorAll('[data-subcalls] [data-chat-call-id]')).toHaveLength(2)
    expect(view.container.querySelector('pre.shiki')).toBeNull()

    fireEvent.click(header)
    expect(call.querySelector('[data-variant="code"]')).toBeNull()
    expect(call.querySelector('[data-subcalls]')).toBeNull()
  })

  it('heads a program call without sub-calls with its description alone', async () => {
    const b = await bench(snapshotWith([codeResult(10, 'call-64')], []))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call] [data-disclosure-row]')?.textContent).toBe('List the notes directory')
    openProgramCall(view.container)
    expect(view.container.querySelector('[data-variant="code"]')).not.toBeNull()
    expect(view.container.querySelector('[data-subcalls]')).toBeNull()
  })

  it('labels a single sub-call in the singular', async () => {
    const parent = 'call-64'
    const b = await bench(snapshotWith([codeResult(10, parent)], [subCall(11, parent, 1, 'mystery', { n: 1 }, 'ok')]))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call] [data-disclosure-row]')?.textContent)
      .toBe('List the notes directory1 tool call')
  })

  it('shows a failed program call as its description and the failed state, with the first error line on the source row', async () => {
    const parent = 'call-64'
    const failed: ToolResultNode = {
      ...codeResult(10, parent), isError: true,
      content: [{ type: 'text', text: 'Error: code run failed\n    at program' }],
    }
    const b = await bench(snapshotWith([failed], [subCall(11, parent, 1, 'mystery', { n: 1 }, 'ok')]))
    const view = mountApp(b.runtime)
    const header = view.container.querySelector('[data-program-call][data-state="error"] [data-disclosure-row]')!
    expect(header.textContent).toBe('List the notes directoryFailed')
    expect(view.getAllByText('Failed')).toHaveLength(1)
    fireEvent.click(header)
    expect(view.container.querySelector('[data-variant="code"][data-state="error"] [data-disclosure-row]')?.textContent)
      .toBe('Source codeError: code run failed')
  })

  it('shows the stopped state of an interrupted program call after its description', async () => {
    const parent = 'call-64'
    const stopped: ToolResultNode = {
      ...codeResult(10, parent), isError: true, content: [],
      error: { name: 'ToolInterruptedError', code: 'interrupted' },
    }
    const b = await bench(snapshotWith([stopped], [subCall(11, parent, 1, 'mystery', { n: 1 }, 'ok')]))
    const view = mountApp(b.runtime)
    const header = view.container.querySelector('[data-program-call][data-state="stopped"] [data-disclosure-row]')!
    expect(header.textContent).toBe('List the notes directoryStopped')
    expect(view.getAllByText('Stopped')).toHaveLength(1)
    fireEvent.click(header)
    expect(view.container.querySelector('[data-variant="code"][data-state="stopped"] [data-disclosure-row]')?.textContent)
      .toBe('Source code')
  })

  it('heads an Auto-denied program call with the denial and no program description', async () => {
    const parent = 'call-64'
    const denied: ToolResultNode = {
      ...codeResult(10, parent), isError: true, content: [],
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: 'not authorized' },
    }
    const b = await bench(snapshotWith([denied], []))
    const view = mountApp(b.runtime)
    const header = view.container.querySelector('[data-program-call] [data-disclosure-row]')!
    expect(header.textContent).toBe('Tool callRejected by Auto review')
    fireEvent.click(header)
    expect(view.container.querySelector('[data-variant="code"] [data-disclosure-row]')?.textContent)
      .toBe('Source codeRejected by Auto review')
    expect(view.queryByText('List the notes directory')).toBeNull()
  })

  it('lists the first sub-calls of a long program above an omission row', async () => {
    const parent = 'call-64'
    const subCalls = Array.from({ length: 33 }, (_, index) => subCall(11 + index, parent, index + 1, 'mystery', { n: index }, 'ok'))
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call] [data-disclosure-row]')?.textContent)
      .toBe('List the notes directory33 tool calls')
    openProgramCall(view.container)
    const rows = [...view.container.querySelectorAll('[data-subcalls] > *')]
    expect(rows).toHaveLength(21)
    expect(rows.slice(0, 20).map(row => row.getAttribute('data-chat-call-id'))).toEqual(subCalls.slice(0, 20).map(call => call.callId))
    expect(rows[20]?.getAttribute('data-subcalls-omitted')).toBe('13')
    expect(rows[20]?.textContent).toBe('Show more (13 hidden)')
    expect(rows[20]?.getAttribute('role')).toBe('button')
  })

  it('doubles the listed sub-calls per omission-row activation and returns to the first 20 when reopened', async () => {
    const parent = 'call-64'
    const subCalls = Array.from({ length: 150 }, (_, index) => subCall(11 + index, parent, index + 1, 'mystery', { n: index }, 'ok'))
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    const listedIds = () => [...view.container.querySelectorAll('[data-subcalls] > [data-chat-call-id]')]
      .map(row => row.getAttribute('data-chat-call-id'))
    const firstIds = (count: number) => subCalls.slice(0, count).map(call => call.callId)
    const omission = () => view.container.querySelector<HTMLElement>('[data-subcalls-omitted]')
    openProgramCall(view.container)
    expect(listedIds()).toEqual(firstIds(20))
    expect(omission()?.textContent).toBe('Show more (130 hidden)')

    fireEvent.click(omission()!)
    expect(listedIds()).toEqual(firstIds(40))
    expect(omission()?.textContent).toBe('Show more (110 hidden)')

    fireEvent.keyDown(omission()!, { key: 'Tab' })
    expect(listedIds()).toEqual(firstIds(40))
    fireEvent.keyDown(omission()!, { key: 'Enter' })
    expect(listedIds()).toEqual(firstIds(80))
    expect(omission()?.textContent).toBe('Show more (70 hidden)')

    fireEvent.keyDown(omission()!, { key: ' ' })
    expect(listedIds()).toEqual(firstIds(150))
    expect(omission()).toBeNull()

    openProgramCall(view.container)
    openProgramCall(view.container)
    expect(listedIds()).toEqual(firstIds(20))
    expect(omission()?.textContent).toBe('Show more (130 hidden)')
  })

  it.each([false, true])('renders the CUA program and its nested calls while running=%s', async (running) => {
    const parent = 'cua-program'
    const program = "var app = await cua.getApp('Calculator')\nconsole.log(app)"
    const argsRaw = JSON.stringify({ code: program, description: 'Select Calculator' })
    const child = subCall(11, parent, 1, 'cua', { method: 'getApp', params: { selector: 'Calculator' } }, 'Calculator')
    const b = await bench(snapshotWith(
      running ? [] : [codeResult(10, parent, 'cua_run_code', argsRaw)], [child],
      running ? [runningCode(parent, 'cua_run_code', argsRaw)] : [],
    ))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call="cua_run_code"]')?.textContent).toContain('Select Calculator')
    openProgramCall(view.container)
    expect(view.container.querySelector('[data-subcalls] [data-tool="cua"]')).not.toBeNull()
    fireEvent.click(view.getByText('Source code'))
    expect(view.container.querySelector('pre.shiki')?.textContent).toBe(program)
  })

  it('renders the code-variant source row and the sub-call rows under the header row', async () => {
    const parent = 'call-64'
    const subCalls = [
      subCall(11, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
      subCall(12, parent, 2, 'mystery', { n: 1 }, 'ok'),
    ]
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)

    // The header row carries the model-authored description; the source row is the code variant.
    expect(view.getByText('List the notes directory')).toBeTruthy()
    expect(view.container.querySelector('[data-program-call] [data-variant="code"]')).not.toBeNull()
    expect(view.getByText('Source code')).toBeTruthy()

    const nest = view.container.querySelector('[data-subcalls]')
    expect(nest).not.toBeNull()
    expect(nest!.querySelector('[data-sample="bash"]')).not.toBeNull()
    expect(view.getByText('Bash')).toBeTruthy()
    expect(view.getByText('List notes')).toBeTruthy()
    expect(view.getByText('Tool call')).toBeTruthy()

    const bashRow = nest!.querySelector('[data-sample="bash"]')!
    expect(bashRow.getAttribute('role')).toBe('button')
    fireEvent.click(bashRow)
    expect(nest!.querySelector('[data-terminal]')).not.toBeNull()
    expect(view.getByText('ls notes')).toBeTruthy()
    expect(nest!.querySelector('[data-terminal]')!.textContent).toContain('demo.txt')
  })

  it('renders Cordis sub-calls with lifecycle titles over the generic variants', async () => {
    const parent = 'call-cordis'
    const subCalls = [
      subCall(11, parent, 1, 'cordis_runtime_inspect', { what: 'temporary' }, '## Dynamic Packages'),
      subCall(12, parent, 2, 'cordis_run', { id: 'dyn-2' }, 'Dynamic package dyn-2 is running'),
      subCall(13, parent, 3, 'cordis_undefine', { id: 'dyn-2' }, 'Dynamic package dyn-2 was discarded.'),
    ]
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)
    const nest = view.container.querySelector('[data-subcalls]')!

    // Each run-control verb names its act and shows the package id; without the
    // owned titles all three would read "Tool call · cordis_run · dyn-2".
    expect(nest.querySelector('[data-tool="cordis_runtime_inspect"]')?.textContent).toContain('Query Cordis environment')
    expect(nest.querySelector('[data-tool="cordis_run"]')?.textContent).toContain('Run Cordis Plugindyn-2')
    expect(nest.querySelector('[data-tool="cordis_undefine"]')?.textContent).toContain('Remove Cordis Plugindyn-2')
    // None of them is a code row: the program belongs to cordis_define, whose
    // own keyed card renders it (the next case covers the code row itself).
    expect(nest.querySelector('[data-variant="code"]')).toBeNull()
  })

  it('expanding the code row reveals the program body verbatim (shiki-tokenized)', async () => {
    const parent = 'call-64'
    const b = await bench(snapshotWith([codeResult(10, parent)], []))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)
    // The code row is expandable via the whole summary row (body = the program).
    const toggle = view.container.querySelector('[data-variant="code"] [data-expandable]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle!)
    // Shiki splits the program into token spans inside one <pre class="shiki">:
    // assert the whole text and the highlighted tree rather than one node.
    const pre = view.container.querySelector('pre.shiki')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('const listing = await tools.bash')
    expect(pre!.querySelectorAll('span[style]').length).toBeGreaterThan(3)
  })

  it('an isError sub-call renders the same error row state as a failed native row', async () => {
    const parent = 'call-64'
    const subCalls = [
      subCall(11, parent, 1, 'mystery', { n: 1 }, 'Error: boom', true),
    ]
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)
    const nested = view.container.querySelector('[data-subcalls] [data-variant][data-state="error"]')
    expect(nested).not.toBeNull()
  })

  it('a file sub-row click opens the file in the Sidebar; bash sub-rows open nothing', async () => {
    const parent = 'call-64'
    const subCalls = [
      { ...subCall(11, parent, 1, 'read', { path: 'notes/demo.txt' }, 'ok'), meta: { path: '/w/notes/demo.txt' } },
      subCall(12, parent, 2, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
    ]
    const b = await bench(snapshotWith([codeResult(10, parent)], subCalls))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)
    view.getByText('notes/demo.txt').click()
    await vi.waitFor(() => {
      expect(b.sidebarRight.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1//w/notes/demo.txt')
    })
    expect(b.openWorkspacePath).not.toHaveBeenCalled()
    view.getByText('List notes').click()
    expect(b.sidebarRight.openResource).toHaveBeenCalledTimes(1)
  })

  it('a RUNNING run_code call nests its so-far dispatches under running header and source rows', async () => {
    const parent = 'call-live'
    const subCalls = [
      subCall(21, parent, 1, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
    ]
    const b = await bench(snapshotWith([], subCalls, [runningCode(parent)]))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call][data-state="running"]')).not.toBeNull()
    expect(view.getByText('Running')).toBeTruthy()
    // Between two sub-calls the collapsed row keeps the last one started, still inert.
    const current = view.container.querySelector('[data-current-subcall]')
    expect(current?.hasAttribute('inert')).toBe(true)
    expect(current?.querySelector('[data-sample="bash"]')?.getAttribute('data-state')).toBe('ok')
    openProgramCall(view.container)
    const running = view.container.querySelector('[data-variant="code"][data-state="running"]')
    expect(running).not.toBeNull()
    const nest = view.container.querySelector('[data-subcalls]')
    expect(nest).not.toBeNull()
    expect(nest!.querySelector('[data-sample="bash"]')).not.toBeNull()
  })

  it('a started-but-unsettled sub-call renders the running state exactly like a native in-flight row', async () => {
    const parent = 'call-live'
    const b = await bench(snapshotWith([], [startedSubCall(parent, 1, 'grep', { pattern: 'todo' })], [runningCode(parent)]))
    const view = mountApp(b.runtime)
    openProgramCall(view.container)
    // The nested row derives 'running' from the StartedToolCall shape — the
    // same data-state chrome (row sweep) a native in-flight row wears.
    const nested = view.container.querySelector('[data-subcalls] [data-variant][data-state="running"]')
    expect(nested).not.toBeNull()
  })

  it('shows the unsettled sub-call a running program started last as one inert row under its collapsed header row', async () => {
    const parent = 'call-live'
    const subCalls = [
      startedSubCall(parent, 1, 'grep', { pattern: 'todo' }),
      startedSubCall(parent, 2, 'mystery', { n: 1 }),
      subCall(21, parent, 3, 'bash', { command: 'ls notes', description: 'List notes' }, 'demo.txt'),
    ]
    const b = await bench(snapshotWith([], subCalls, [runningCode(parent)]))
    const view = mountApp(b.runtime)
    const rows = view.container.querySelectorAll('[data-current-subcall]')
    expect(rows).toHaveLength(1)
    // The preview follows the header row as a sibling inside the call's own row wrapper.
    expect(rows[0]?.previousElementSibling?.getAttribute('data-program-call')).toBe('run_code')
    expect(rows[0]?.getAttribute('data-current-subcall')).toBe(`${parent}:code:2`)
    expect(rows[0]?.hasAttribute('inert')).toBe(true)
    expect(rows[0]?.querySelector('[data-tool="mystery"][data-state="running"]')).not.toBeNull()
    expect(view.container.querySelector('[data-subcalls]')).toBeNull()

    openProgramCall(view.container)
    expect(view.container.querySelector('[data-current-subcall]')).toBeNull()
    expect(view.container.querySelectorAll('[data-subcalls] [data-chat-call-id]')).toHaveLength(3)
  })

  it('shows no current sub-call row under a running program call without sub-calls or under a settled program call', async () => {
    const parent = 'call-64'
    const stopped: ToolResultNode = {
      ...codeResult(10, parent), isError: true, content: [],
      error: { name: 'ToolInterruptedError', code: 'interrupted' },
    }
    const b = await bench(snapshotWith([stopped], [startedSubCall(parent, 1, 'grep', { pattern: 'todo' })]))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-program-call][data-state="stopped"]')).not.toBeNull()
    expect(view.container.querySelector('[data-current-subcall]')).toBeNull()

    const idle = await bench(snapshotWith([], [], [runningCode('call-live')]))
    const idleView = mountApp(idle.runtime)
    expect(idleView.container.querySelector('[data-program-call][data-state="running"]')).not.toBeNull()
    expect(idleView.container.querySelector('[data-current-subcall]')).toBeNull()
  })

  it('an ordinary tool row renders no sub-call nest', async () => {
    const parent = 'call-64'
    const plain: ToolResultNode = {
      kind: 'tool-result', seq: 10, time: 10_000, callId: parent,
      name: 'mystery', args: PartialArguments.fromText('{"n":1}'),
      call: { name: 'mystery', argsRaw: '{"n":1}' },
      callTime: 9_500,
      content: [], isError: false, subCalls: [],
    }
    const b = await bench(snapshotWith([plain], []))
    const view = mountApp(b.runtime)
    expect(view.container.querySelector('[data-subcalls]')).toBeNull()
  })
})
