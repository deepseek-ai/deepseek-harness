// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CHAT_DIFF_MAX_LINES, diffCardModel } from '../src/client/tool/models/diff-card-model.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { FileMutationRow, fileMutationToolview } from '../src/client/tool/toolviews/file-mutation-row.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

type FileMutationRowProps = Parameters<typeof FileMutationRow>[0]

const SID = 's1' as SessionId

const t = makeTranslate(zh, commonZh)

const ARGS = '{"file_path":"notes/demo.txt","old_string":"hello","new_string":"hello fixture"}'

const DIFFS = [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }]

const running = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'edit', argsRaw: ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settled = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'edit', argsRaw: ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'The file notes/demo.txt has been updated successfully.' }], isError: false,
  meta: { diffs: DIFFS }, subCalls: [], ...over,
})

describe('diffCardModel', () => {
  it('derives a running card from raw edit arguments', () => {
    expect(diffCardModel(running())).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: 'hello', newText: 'hello fixture' }] },
    })
  })

  it('preserves the Host presenter\'s whole-file diff for an empty old_string', () => {
    expect(diffCardModel(running({
      argsRaw: '{"file_path":"notes/demo.txt","old_string":"","new_string":"replacement"}',
    }))).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: null, newText: 'replacement' }] },
    })
  })

  it.each([
    {
      command: 'create',
      args: { command: 'create', path: 'notes/new.txt', file_text: 'new file\n' },
      diff: { path: 'notes/new.txt', oldText: null, newText: 'new file\n' },
    },
    {
      command: 'str_replace',
      args: { command: 'str_replace', path: 'notes/demo.txt', old_str: 'old', new_str: 'new' },
      diff: { path: 'notes/demo.txt', oldText: 'old', newText: 'new' },
    },
  ])('preserves the running str_replace_editor $command diff', ({ args, diff }) => {
    expect(diffCardModel(running({
      name: 'str_replace_editor',
      argsRaw: JSON.stringify(args),
    }))).toEqual({ card: { diffs: [diff] } })
  })

  it('preserves str_replace_editor defaults and its settled Generic result', () => {
    const argsRaw = JSON.stringify({ command: 'str_replace', path: 'notes/demo.txt' })
    expect(diffCardModel(running({ name: 'str_replace_editor', argsRaw }))).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: null, newText: '' }] },
    })
    expect(diffCardModel(settled({
      call: { name: 'str_replace_editor', argsRaw },
      meta: { diffs: [{ path: 'notes/demo.txt', oldText: 'old', newText: 'new' }] },
    }))).toBeNull()
  })

  it('keeps unsupported or malformed str_replace_editor calls generic', () => {
    const editor = (args: Record<string, unknown>) => running({
      name: 'str_replace_editor', argsRaw: JSON.stringify(args),
    })
    expect(diffCardModel(editor({ command: 'view', path: 'notes/demo.txt' }))).toBeNull()
    expect(diffCardModel(editor({ command: 'insert', path: 'notes/demo.txt', new_str: 'x' }))).toBeNull()
    expect(diffCardModel(editor({ command: 'create', path: '', file_text: 'x' }))).toBeNull()
    expect(diffCardModel(editor({ command: 'create', path: 'notes/demo.txt', file_text: 1 }))).toBeNull()
    expect(diffCardModel(editor({ command: 'str_replace', path: 'notes/demo.txt', old_str: 1 }))).toBeNull()
    expect(diffCardModel(editor({ command: 'str_replace', path: 'notes/demo.txt', new_str: 1 }))).toBeNull()
  })

  it('derives a settled card from result metadata, which replaces the intended diff', () => {
    expect(diffCardModel(settled({
      meta: { diffs: [{ path: 'notes/demo.txt', oldText: 'a', newText: 'b' }] },
    }))).toEqual({
      card: { diffs: [{ path: 'notes/demo.txt', oldText: 'a', newText: 'b' }] },
    })
  })

  it('uses the intended write diff when successful metadata reports no applied hunk', () => {
    const writeArgs = JSON.stringify({ file_path: 'notes/new.txt', content: 'hello fixture\n' })
    expect(diffCardModel(settled({
      call: { name: 'write', argsRaw: writeArgs },
      meta: { diffs: [] },
    }))).toEqual({
      card: { diffs: [{ path: 'notes/new.txt', oldText: null, newText: 'hello fixture\n' }] },
    })
  })

  it('returns null for missing calls, errors, malformed args, unrelated tools, and child dispatches', () => {
    expect(diffCardModel(settled({ call: null }))).toBeNull()
    expect(diffCardModel(settled({ isError: true }))).toBeNull()
    expect(diffCardModel(running({ argsRaw: '{' }))).toBeNull()
    expect(diffCardModel(running({ name: 'read' }))).toBeNull()
    expect(diffCardModel(running({ parentCallId: 'parent' }))).toBeNull()
    expect(diffCardModel(settled({ parentCallId: 'parent' }))).toBeNull()
  })

  it('keeps edit generic for missing or malformed applied metadata', () => {
    expect(diffCardModel(settled({ meta: undefined }))).toBeNull()
    expect(diffCardModel(settled({ meta: null }))).toBeNull()
    expect(diffCardModel(settled({ meta: { diffs: 'nope' } }))).toBeNull()
    expect(diffCardModel(settled({ meta: { diffs: [null] } }))).toBeNull()
    expect(diffCardModel(settled({ meta: { diffs: [{ path: 1, oldText: null, newText: 'x' }] } }))).toBeNull()
    expect(diffCardModel(settled({ meta: { diffs: [{ path: 'a', oldText: 5, newText: 'x' }] } }))).toBeNull()
    expect(diffCardModel(settled({ meta: { diffs: [{ path: 'a', oldText: null, newText: 9 }] } }))).toBeNull()
  })

  it.each([
    undefined,
    null,
    { diffs: 'nope' },
    { diffs: [null] },
  ])('uses the intended write diff when applied metadata is absent or malformed: %j', (meta) => {
    const writeArgs = JSON.stringify({ file_path: 'notes/new.txt', content: 'hello fixture\n' })
    expect(diffCardModel(settled({
      call: { name: 'write', argsRaw: writeArgs },
      meta,
    }))).toEqual({
      card: { diffs: [{ path: 'notes/new.txt', oldText: null, newText: 'hello fixture\n' }] },
    })
  })

  it('validates mutation escalation fields but accepts unrelated open-root fields', () => {
    const args = (fields: Record<string, unknown>) => JSON.stringify({
      file_path: 'notes/demo.txt', old_string: 'hello', new_string: 'hello fixture', ...fields,
    })
    expect(diffCardModel(running({ argsRaw: args({ sandbox_permissions: 7, justification: 'Need access' }) }))).toBeNull()
    expect(diffCardModel(running({ argsRaw: args({ sandbox_permissions: 'workspace-write' }) }))).toBeNull()
    expect(diffCardModel(running({ argsRaw: args({ extension: { version: 1 } }) }))).not.toBeNull()
  })
})

describe('chat row diff body', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode): GenericToolCardProps => ({
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    callId: 'c1', toolName: 'edit', block, openFile: vi.fn(), t,
  })

  it('the expanded body is the applied diff, capped tighter than the panel', () => {
    expect(CHAT_DIFF_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settled())} />)
    // Collapsed: the summary row (path) only, no diff body.
    expect(view.queryByText('hello fixture')).toBeNull()
    // The path link is not the expand control; the leading toggle is.
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.getByText('hello fixture')).toBeTruthy()
  })

  it('a running diff call expands to its intended change', () => {
    const view = render(<GenericToolCard {...ownerProps(running())} />)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
  })

  it('a non-diff call keeps the args-JSON text body', () => {
    // A non-file tool name so the row is not single-file (no path link), and its
    // args body is the fallback the diff card must not have replaced.
    const view = render(<GenericToolCard {...{
      callId: 'c1', toolName: 'some_tool', openFile: vi.fn(),
      loadImage: vi.fn(() => Promise.reject(new Error('not used'))), t,
      block: settled({
        call: { name: 'some_tool', argsRaw: '{"foo":"bar"}' },
        meta: undefined,
      }),
    }} />)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    expect(view.getByText(/"foo"/)).toBeTruthy()
  })
})

describe('FileMutationRow diff card', () => {
  const list = () => createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, blank: false, updatedAt: 0, cwd: '/w/app' } },
    current: SID,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  })

  const rowProps = (block: RunningToolCall | ToolResultNode, toolName = 'edit'): FileMutationRowProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(), cwd: '/w/app',
    sessionId: SID, useSessions: bindSnapshotSelector(list()),
    t,
  } as unknown as FileMutationRowProps)

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('collapses to the summary row; expanding reveals the applied diff card', () => {
    const view = render(<FileMutationRow {...rowProps(settled())} />)
    // The diff card is collapsed by default — not in the DOM until expanded.
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    expect(view.queryByText('hello fixture')).toBeNull()
    toggleRow(view)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.getByText('hello fixture')).toBeTruthy()
    expect(view.getByText('复制')).toBeTruthy()
  })

  it('the summary is a path link that opens the tool path through the host', () => {
    const openFile = vi.fn()
    const view = render(<FileMutationRow {...{ ...rowProps(settled()), openFile }} />)
    // The path link rides the collapsed summary, so it opens without expanding.
    fireEvent.click(view.getByRole('button', { name: 'notes/demo.txt' }))
    // The row passes the tool's own path; the injected openFile resolves it
    // against the session cwd (apply.ts), so the row must not resolve twice.
    expect(openFile).toHaveBeenCalledWith('notes/demo.txt')
  })

  it('registers under write too, rendering a create as an added-only diff', () => {
    const writeArgs = '{"file_path":"notes/new.txt","content":"hello fixture\\n"}'
    const view = render(<FileMutationRow {...rowProps(settled({
      call: { name: 'write', argsRaw: writeArgs },
      meta: { diffs: [] },
    }), 'write')} />)
    // The collapsed row already carries the card's +/- totals beside the path.
    expect(view.getByText('+1 -0')).toBeTruthy()
    // The footer counts live inside the collapsed diff card.
    toggleRow(view)
    expect(view.getByText('└ +1 -0 · 1 个文件')).toBeTruthy()
  })

  it('reflects the run state on its leading slot', () => {
    const runningView = render(<FileMutationRow {...rowProps(running())} />)
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    cleanup()
    const errorView = render(<FileMutationRow {...rowProps(settled({ isError: true }))} />)
    expect(errorView.container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('a mutation result with no metadata renders the summary row alone', () => {
    const view = render(<FileMutationRow {...rowProps(settled({ meta: undefined }))} />)
    // No diff material: expanding shows the args-JSON body, never a diff card.
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    toggleRow(view)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
  })

  it('surfaces the result text when an errored mutation has no diff card', () => {
    // Failed mutations have no diff; ToolRow keeps the model-facing error text.
    const view = render(<FileMutationRow {...rowProps(settled({
      isError: true,
      content: [{ type: 'text', text: 'old_string not found in notes/demo.txt' }],
    }))} />)
    expect(view.container.querySelector('[data-diff]')).toBeNull()
    expect(view.getByText('old_string not found in notes/demo.txt')).toBeTruthy()
  })

  it('falls back to the error name/code when an errored result has no text block', () => {
    const view = render(<FileMutationRow {...rowProps(settled({
      isError: true, content: [],
      error: { name: 'ToolError', code: 'sandbox_denied' },
    }))} />)
    expect(view.getByText('ToolError: sandbox_denied')).toBeTruthy()
  })

  it('shows no error summary for a successful diff or a running call', () => {
    // ToolRow's error-color summary line is set only on the error state.
    const ok = render(<FileMutationRow {...rowProps(settled())} />)
    expect(ok.container.querySelector('[class*="_errorSummary_"]')).toBeNull()
    cleanup()
    const run = render(<FileMutationRow {...rowProps(running())} />)
    expect(run.container.querySelector('[class*="_errorSummary_"]')).toBeNull()
  })

  it('shows the stopped state when the call was interrupted', () => {
    const view = render(<FileMutationRow {...rowProps(settled({
      isError: true,
      error: { name: 'ToolError', code: 'interrupted' },
    }))} />)
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    // The amber StateDot is aria-hidden, so ToolRow carries the state to AT as
    // visually-hidden text; without it a stopped row is a colour-only signal.
    expect(view.getByText('已停止')).toBeTruthy()
  })

  it('renders a plain summary span when the call carries no file path', () => {
    // Empty args leave deriveFilePath undefined, so the summary is not a link.
    const view = render(<FileMutationRow {...rowProps(settled({
      call: { name: 'edit', argsRaw: '' },
    }))} />)
    expect(view.container.querySelector('[class*="_fileLink_"]')).toBeNull()
    expect(view.container.querySelector('[class*="_summary_"]')).not.toBeNull()
  })
})

describe('fileMutationToolview registration', () => {
  it('registers one component under both edit and write, and each disposes', () => {
    const registered: { key: string; locale: unknown; disposed: boolean }[] = []
    const disposers: (() => void)[] = []
    let disposeInjection = (): void => {}
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          const active = [...callback()]
          disposeInjection = () => { for (const dispose of active.reverse()) dispose() }
          return disposeInjection
        },
        register: ({ key, locale }: { name: string; key: string; locale?: string }) => {
          const entry = { key, locale, disposed: false }
          registered.push(entry)
          const dispose = () => { entry.disposed = true }
          disposers.push(dispose)
          return dispose
        },
      },
    }
    fileMutationToolview.apply(ctx as never)
    expect(registered.map(r => r.key).sort()).toEqual(['edit', 'write'])
    // Both keys claim the conversation locale seat ToolRow's body copy needs.
    expect(registered.map(r => r.locale)).toEqual(['conversation', 'conversation'])
    expect(fileMutationToolview.inject).toEqual(['slots'])
    // Disposal removes each contribution (packages/AGENTS.md registry contract).
    disposeInjection()
    expect(registered.every(r => r.disposed)).toBe(true)
  })
})
